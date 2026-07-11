"""Cut/crop/burn/loudnorm/thumbnail a single clip.

Crop fallback chain (critic directive 9): a dominant face in the clip's
opening scene-span gets a static face-centered crop; no dominant face falls
back to a plain center crop; source video already <=9:16 (portrait-or-
narrower) skips cropping entirely in favor of scale+pad (pillarbox/
letterbox). Audio is loudness-normalized to -14 LUFS via two-pass loudnorm.
A single frame at cut.t0 (post-crop, no captions) is exported as a
1080x1920 jpg thumbnail.
"""

import contextlib
import dataclasses
import json
import os
import re
import subprocess
from pathlib import Path

from shorts.ffmpeg import FfmpegError, run
from shorts.render.captions import words_to_ass
from shorts.signals.index import scene_span
from shorts.types import Cut, Hook, SignalIndex

# worker/src/shorts/render/renderer.py -> parents[3] == worker/
_FONTS_DIR = Path(__file__).resolve().parents[3] / "fonts"

TARGET_W, TARGET_H = 1080, 1920
_LOUDNESS_TARGET_LUFS = -14.0
_LOUDNORM_JSON_RE = re.compile(r"\{[^{}]*\}", re.S)


@contextlib.contextmanager
def _cwd(path: Path):
    # ponytail: run ffmpeg with cwd=out_dir and relative filenames so the
    # subtitles= filter never has to worry about colon/quote escaping in an
    # absolute path.
    prev = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prev)


def _crop_geometry(
    src_w: int, src_h: int, face_cx: float | None
) -> tuple[int, int, int, int] | None:
    """Pure function (no ffmpeg/IO): the 9:16 crop window in source-pixel
    space, or None if the source is already <=9:16 (portrait-or-narrower)
    and should be scaled+padded instead of cropped.

    `face_cx` is the normalized (0..1) mean dominant-face x-center for the
    clip, or None to fall back to a plain center crop (no dominant face
    found -- e.g. screenshare, or a real face that never clears the
    detector's confidence gate). Returns (crop_w, crop_h, x, y).
    """
    if src_w * 16 <= src_h * 9:
        return None

    crop_w = (src_h * 9) // 16
    crop_h = src_h
    if face_cx is None:
        x = (src_w - crop_w) // 2
    else:
        x = round(face_cx * src_w - crop_w / 2)
        x = max(0, min(x, src_w - crop_w))
    return crop_w, crop_h, x, 0


def _scene_face_center_x(idx: SignalIndex, cut: Cut) -> float | None:
    """Mean normalized x-center of the dominant face box, sampled across
    the clip's *opening* scene-span (scene_span at cut.t0, clamped to the
    cut) -- a static per-shot crop, not frame-by-frame tracking.
    # ponytail: if a cut straddles a mid-clip scene change the crop stays
    anchored to the first scene; smooth/multi-shot tracking is v2.
    None if no dominant face was found in that span."""
    scene = scene_span(idx, cut.t0)
    t0 = max(cut.t0, scene.t0) if scene else cut.t0
    t1 = min(cut.t1, scene.t1) if scene else cut.t1

    centers = [
        f.boxes[f.dominant].x + f.boxes[f.dominant].w / 2
        for f in idx.faces
        if t0 <= f.t < t1 and f.dominant is not None
    ]
    return sum(centers) / len(centers) if centers else None


def _measure_loudness(video: Path, cut: Cut) -> dict:
    """First loudnorm pass: measure-only, JSON printed to stderr (ffmpeg
    loudnorm quirk -- there's no stdout output to parse here, same as
    blackdetect/freezedetect)."""
    proc = subprocess.run(
        [
            "ffmpeg",
            "-ss", str(cut.t0),
            "-i", str(video),
            "-t", str(cut.t1 - cut.t0),
            "-af", f"loudnorm=I={_LOUDNESS_TARGET_LUFS}:print_format=json",
            "-f", "null", "-",
        ],
        capture_output=True, check=False,
    )
    stderr = proc.stderr.decode("utf-8", errors="replace")
    match = _LOUDNORM_JSON_RE.search(stderr)
    if not match:
        raise FfmpegError(f"loudnorm measure pass produced no JSON:\n{stderr[-2000:]}")
    return json.loads(match.group(0))


def _loudnorm_filter(measured: dict) -> str:
    return (
        f"loudnorm=I={_LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured.get('target_offset', 0)}:linear=true:print_format=summary"
    )


def render_clip(
    video: Path,
    cut: Cut,
    idx: SignalIndex,
    hook: Hook | None,
    style: str,
    out_dir: Path,
) -> tuple[Path, Path]:
    """Cut [cut.t0, cut.t1) from `video`, crop/scale to 1080x1920 per the
    crop fallback chain, burn in karaoke captions built from idx.words,
    loudness-normalize audio to -14 LUFS, and export a thumbnail at
    cut.t0. Writes clip.mp4 + thumb.jpg (+ clip.ass) into `out_dir`.
    `hook`, if given, burns its title into the top safe area for the first
    3 seconds (or the whole clip, if shorter) -- same ASS file/pass as the
    karaoke captions, not a second subtitles filter.
    Returns (mp4_path, thumb_path)."""
    video = Path(video).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    out = out_dir / "clip.mp4"
    thumb = out_dir / "thumb.jpg"
    ass_path = out_dir / "clip.ass"

    # words_to_ass expects clip-relative timestamps (its output is burned
    # into a clip whose own timeline starts at 0 post -ss trim); idx.words
    # carries absolute source timestamps, so rebase before handing off.
    clip_words = [
        dataclasses.replace(w, t0=w.t0 - cut.t0, t1=w.t1 - cut.t0)
        for w in idx.words
        if cut.t0 <= w.t0 < cut.t1
    ]
    ass_path.write_text(
        words_to_ass(
            clip_words, style, (TARGET_W, TARGET_H),
            hook_title=hook.title if hook else None,
            clip_duration_s=cut.t1 - cut.t0,
        )
    )

    face_cx = _scene_face_center_x(idx, cut)
    geom = _crop_geometry(idx.media.width, idx.media.height, face_cx)
    if geom is None:
        crop_vf = (
            f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_W}:{TARGET_H}:(ow-iw)/2:(oh-ih)/2"
        )
    else:
        crop_w, crop_h, x, y = geom
        crop_vf = f"crop={crop_w}:{crop_h}:{x}:{y},scale={TARGET_W}:{TARGET_H}"

    measured = _measure_loudness(video, cut)
    audio_filter = _loudnorm_filter(measured)

    with _cwd(out_dir):
        run(
            [
                "-y",
                "-ss", str(cut.t0),
                "-i", str(video),
                "-t", str(cut.t1 - cut.t0),
                "-vf", f"{crop_vf},subtitles={ass_path.name}:fontsdir={_FONTS_DIR}",
                "-af", audio_filter,
                "-c:v", "libx264",
                "-c:a", "aac",
                "-pix_fmt", "yuv420p",
                out.name,
            ]
        )
        run(
            [
                "-y",
                "-ss", str(cut.t0),
                "-i", str(video),
                "-frames:v", "1",
                "-vf", crop_vf,
                thumb.name,
            ]
        )

    return out, thumb


if __name__ == "__main__":
    # ponytail: quick manual self-check of the pure crop-geometry function
    # only -- rendering itself is exercised by tests/test_render.py (needs
    # real media). Run `python -m shorts.render.renderer`.
    assert _crop_geometry(1920, 1080, None) == (607, 1080, 656, 0)  # center crop
    assert _crop_geometry(1920, 1080, 0.0) == (607, 1080, 0, 0)  # clamped left
    assert _crop_geometry(1920, 1080, 1.0) == (607, 1080, 1313, 0)  # clamped right
    assert _crop_geometry(1080, 1920, None) is None  # already portrait -> no crop
    print("renderer self-check OK")

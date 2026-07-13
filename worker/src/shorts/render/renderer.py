"""Cut/reframe/burn/loudnorm/thumbnail a single clip.

Reframe to 1080x1920 uses a blurred-background "fit": the source is scaled to
fit whole (nothing cropped) and centered, and a blurred, zoomed-to-fill copy
of the same frame fills the top/bottom (or side) margins -- the standard
vertical-clip look that keeps every important visual on screen instead of
cropping the sides off a 16:9 frame. Audio is loudness-normalized to -14 LUFS
via two-pass loudnorm. A single frame at cut.t0 (post-reframe, no captions)
is exported as a 1080x1920 jpg thumbnail.
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


def _reframe_fc() -> str:
    """The blurred-background "fit" filtergraph: consumes [0:v] and ends on an
    *unlabeled* reframed 1080x1920 stream, so a caller can either chain more
    filters (subtitles) or just append an output label. `split` feeds the same
    frame to two branches -- [bg] is scaled to *fill* (increase + crop) then
    blurred to cover the whole target, [fg] is scaled to *fit* whole (decrease,
    nothing cropped) and overlaid centered on top. Aspect-agnostic: a 16:9
    source gets top/bottom margins, a tall source gets side margins, both
    blurred-filled."""
    return (
        f"[0:v]split=2[bg][fg];"
        f"[bg]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
        f"crop={TARGET_W}:{TARGET_H},gblur=sigma=24[bgb];"
        f"[fg]scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=decrease[fgs];"
        f"[bgb][fgs]overlay=(W-w)/2:(H-h)/2"
    )


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
    """Cut [cut.t0, cut.t1) from `video`, reframe to 1080x1920 via the
    blurred-background fit (see `_reframe_fc` -- nothing cropped), burn in
    karaoke captions built from idx.words,
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

    reframe = _reframe_fc()
    measured = _measure_loudness(video, cut)
    audio_filter = _loudnorm_filter(measured)

    with _cwd(out_dir):
        # blurred-fit video (subtitles chained on) -> [v]; loudnorm'd audio -> [a]
        run(
            [
                "-y",
                "-ss", str(cut.t0),
                "-i", str(video),
                "-t", str(cut.t1 - cut.t0),
                "-filter_complex",
                f"{reframe},subtitles={ass_path.name}:fontsdir={_FONTS_DIR}[v];"
                f"[0:a]{audio_filter}[a]",
                "-map", "[v]",
                "-map", "[a]",
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
                "-filter_complex", f"{reframe}[v]",
                "-map", "[v]",
                thumb.name,
            ]
        )

    return out, thumb


if __name__ == "__main__":
    # ponytail: quick manual self-check of the reframe filtergraph shape only
    # -- rendering itself is exercised by tests/test_render.py (needs real
    # media). Run `python -m shorts.render.renderer`.
    fc = _reframe_fc()
    assert fc.startswith("[0:v]split=2[bg][fg];")  # both branches fed
    assert "force_original_aspect_ratio=increase" in fc  # blurred bg fills
    assert "force_original_aspect_ratio=decrease" in fc  # fg fits whole, uncropped
    assert "gblur" in fc and "overlay=(W-w)/2:(H-h)/2" in fc  # blur + center
    assert not fc.rstrip().endswith("]")  # unlabeled tail, caller appends
    print("renderer self-check OK")

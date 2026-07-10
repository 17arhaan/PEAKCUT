"""Video-only signal extraction: scene cuts (PySceneDetect), per-second
face boxes (mediapipe BlazeFace), a coarse motion curve (OpenCV frame-diff),
and black/frozen defect spans (ffmpeg blackdetect/freezedetect, parsed off
stderr since both filters log there, not stdout).
"""

import re
import subprocess
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
import scenedetect
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import FaceDetector, FaceDetectorOptions
from scenedetect import ContentDetector

from shorts.types import Box, Curve, FaceFrame, Span

# worker/src/shorts/signals/video.py -> parents[3] == worker/
_MODEL_PATH = Path(__file__).resolve().parents[3] / "models" / "blaze_face_short_range.tflite"

# ponytail: lower than mediapipe's 0.5 default -- our primary subjects are
# podcast/interview setups where a second speaker is often partially turned
# away from camera (profile view), and BlazeFace's confidence on a profile
# face runs well below its confidence on a front-facing one. Measured on
# committed fixtures: real_talking_head.mp4 (single frontal face) shows a
# false second box in 0/75 sampled seconds at this threshold, so the
# lower bar doesn't cost us clean single-face accuracy.
_MIN_FACE_CONFIDENCE = 0.2

# Two-tier gate: detection stays at _MIN_FACE_CONFIDENCE (0.2) so weak-but-real
# faces stay in `boxes` -- the podcast fixture's partially-turned second
# speaker is 25.3% detected at 0.2 vs 0% at 0.5. But `dominant` (the box
# downstream crop logic center-crops around) is only chosen from boxes
# clearing this higher bar: at 0.2, real_screenshare.mp4 (no camera face at
# all) reports a phantom low-confidence box in 69% of sampled frames, and
# every single one of those measured below 0.5 (0/52 boxes clear it) --
# gating dominant at 0.5 kills the phantom without touching the podcast's
# weak-but-real second-face detection in `boxes`. real_talking_head.mp4's
# genuine face is 100% >= 0.5, so the gate costs nothing there either.
DOMINANT_MIN_CONF = 0.5

_FACE_DETECTOR = None


def _face_detector() -> FaceDetector:
    global _FACE_DETECTOR
    if _FACE_DETECTOR is None:
        base_options = BaseOptions(model_asset_path=str(_MODEL_PATH))
        options = FaceDetectorOptions(
            base_options=base_options, min_detection_confidence=_MIN_FACE_CONFIDENCE
        )
        _FACE_DETECTOR = FaceDetector.create_from_options(options)
    return _FACE_DETECTOR


def detect_scenes(video: Path) -> list[Span]:
    """Scene-cut spans covering the whole video, via PySceneDetect's
    ContentDetector (HSV histogram content-difference threshold)."""
    scene_list = scenedetect.detect(str(video), ContentDetector(), start_in_scene=True)
    return [Span(t0=start.seconds, t1=end.seconds) for start, end in scene_list]


def _iou(a: Box, b: Box) -> float:
    ax0, ay0, ax1, ay1 = a.x, a.y, a.x + a.w, a.y + a.h
    bx0, by0, bx1, by1 = b.x, b.y, b.x + b.w, b.y + b.h
    iw = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    ih = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0.0 else 0.0


def _pick_dominant(boxes: list[Box], prev: Box | None) -> int | None:
    """Pick the dominant box index for one sample: the largest-area box
    among those clearing DOMINANT_MIN_CONF, except sticky -- stays on
    whichever high-confidence candidate best overlaps (highest IoU) the
    previous sample's dominant box, if that overlap exceeds 0.3. Returns
    None if no box clears DOMINANT_MIN_CONF.

    Low-confidence boxes are never candidates, in sticky matching or
    otherwise -- a track can only be kept alive by a box that itself clears
    the bar, so it dies (falls back to None or the next strong box) the
    moment the tracked face's confidence drops below the gate, rather than
    drifting onto a phantom low-confidence box."""
    candidates = [i for i, b in enumerate(boxes) if b.conf >= DOMINANT_MIN_CONF]
    if not candidates:
        return None

    dominant_i = max(candidates, key=lambda i: boxes[i].w * boxes[i].h)

    if prev is not None:
        overlapping = [i for i in candidates if _iou(boxes[i], prev) > 0.3]
        if overlapping:
            dominant_i = max(overlapping, key=lambda i: _iou(boxes[i], prev))

    return dominant_i


def detect_faces(video: Path, fps: float = 1.0) -> list[FaceFrame]:
    """Per-sample face boxes at `fps` samples/sec (normalized 0..1 box
    coords), detected at _MIN_FACE_CONFIDENCE (0.2) so weak-but-real faces
    show up in `boxes`. `dominant` is gated at the higher DOMINANT_MIN_CONF
    (0.5, see comment there) and picked by `_pick_dominant`: largest
    high-confidence box each sample, sticky on the previous dominant's best
    IoU match (>0.3) to keep the chosen face stable frame-to-frame instead
    of flickering between two similar-sized boxes."""
    detector = _face_detector()
    cap = cv2.VideoCapture(str(video))
    try:
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        duration_s = frame_count / video_fps if video_fps > 0 else 0.0

        hop_s = 1.0 / fps
        n_samples = int(duration_s / hop_s) if duration_s > 0 else 0

        frames: list[FaceFrame] = []
        prev_dominant_box: Box | None = None

        for i in range(n_samples):
            t = i * hop_s
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue

            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = detector.detect(image)

            boxes = [
                Box(
                    x=d.bounding_box.origin_x / w,
                    y=d.bounding_box.origin_y / h,
                    w=d.bounding_box.width / w,
                    h=d.bounding_box.height / h,
                    conf=d.categories[0].score if d.categories else 0.0,
                )
                for d in result.detections
            ]

            if not boxes:
                frames.append(FaceFrame(t=t, boxes=[], dominant=None))
                prev_dominant_box = None
                continue

            dominant_i = _pick_dominant(boxes, prev_dominant_box)
            frames.append(FaceFrame(t=t, boxes=boxes, dominant=dominant_i))
            prev_dominant_box = boxes[dominant_i] if dominant_i is not None else None

        return frames
    finally:
        cap.release()


def motion_curve(video: Path, hop_s: float = 0.5) -> Curve:
    """Coarse motion curve: mean absolute grayscale frame-diff between
    consecutive `hop_s`-spaced samples (0.0 for the first sample, no prior
    frame to diff against)."""
    cap = cv2.VideoCapture(str(video))
    try:
        video_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        duration_s = frame_count / video_fps if video_fps > 0 else 0.0
        n_samples = int(duration_s / hop_s) if duration_s > 0 else 0

        values: list[float] = []
        prev_gray = None
        for i in range(n_samples):
            t = i * hop_s
            cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = cap.read()
            if not ok:
                values.append(0.0)
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).astype(np.float32)
            if prev_gray is None:
                values.append(0.0)
            else:
                values.append(float(np.mean(np.abs(gray - prev_gray))) / 255.0)
            prev_gray = gray

        return Curve(hop_s=hop_s, values=values)
    finally:
        cap.release()


# blackdetect/freezedetect write their detections to stderr as they occur
# (not stdout), one key:value token per line while the filter runs.
_BLACK_RE = re.compile(r"black_start:([\d.]+) black_end:([\d.]+)")
_FREEZE_START_RE = re.compile(r"lavfi\.freezedetect\.freeze_start:\s*([\d.]+)")
_FREEZE_END_RE = re.compile(r"lavfi\.freezedetect\.freeze_end:\s*([\d.]+)")


# ponytail: this is a 3rd full decode pass over the video -- detect_scenes
# (PySceneDetect) and detect_faces/motion_curve (OpenCV) each independently
# decode it too, so build_signal_index does 3+ full passes per video. Fine
# at current fixture lengths (75-90s); merge into one decode loop if
# real-length source video makes this a bottleneck.
def detect_defects(video: Path) -> tuple[list[Span], list[Span]]:
    """Black and frozen-frame spans, parsed off ffmpeg blackdetect/
    freezedetect stderr (both filters log to stderr on success -- there is
    no stdout output to parse, unlike `shorts.ffmpeg.run`)."""
    proc = subprocess.run(
        [
            "ffmpeg", "-i", str(video),
            "-vf", "blackdetect=d=0.1:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=0.5",
            "-an", "-f", "null", "-",
        ],
        capture_output=True, check=False,
    )
    stderr = proc.stderr.decode("utf-8", errors="replace")

    black = [
        Span(t0=float(t0), t1=float(t1)) for t0, t1 in _BLACK_RE.findall(stderr)
    ]

    starts = [float(t) for t in _FREEZE_START_RE.findall(stderr)]
    ends = [float(t) for t in _FREEZE_END_RE.findall(stderr)]
    # ponytail: zip() silently drops a trailing unmatched freeze_start (video
    # ends while still frozen, so no freeze_end is ever logged). Add a
    # dangling-freeze-to-EOF case if that turns out to matter for real input.
    frozen = [Span(t0=t0, t1=t1) for t0, t1 in zip(starts, ends)]

    return black, frozen

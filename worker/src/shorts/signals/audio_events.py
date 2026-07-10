"""Non-speech audio event detection (laughter, applause) via PANNs CNN14 --
the framewise sound-event-detection variant (Cnn14_DecisionLevelMax), which
gives a per-frame class probability instead of one label per whole clip, so
events can be localized in time.
"""

from pathlib import Path

import librosa
import numpy as np
from panns_inference import SoundEventDetection
from panns_inference import labels as _PANNS_LABELS

from shorts.signals.audio import _chunk_bounds
from shorts.types import AudioEvent

_SR = 32000

# Per-class thresholds (plan-owner decision 2026-07-11). PANNs' laughter
# head is low-activation: the synth fixture's spliced laugh is correctly
# localized at t=45.75s but peaks at conf ~0.08, while sine/speech controls
# on the same clip score 0.82/0.73 -- the pipeline is well-calibrated, the
# laughter class just never gets near 0.5. Measured noise floor on real
# non-laughing speech (real_talking_head.mp4) is 0.0013, so 0.05 is ~40x
# above it.
_THRESHOLDS = {"laughter": 0.05, "applause": 0.5}

# AudioEvent.label is one of {"laughter", "applause"} -- map the two
# matching AudioSet class names PANNs was trained on to those.
_LABEL_MAP = {"Laughter": "laughter", "Applause": "applause"}
_LABEL_INDICES = {_PANNS_LABELS.index(name): out for name, out in _LABEL_MAP.items()}

_SED_MODEL = None


def _sed_model() -> SoundEventDetection:
    global _SED_MODEL
    if _SED_MODEL is None:
        _SED_MODEL = SoundEventDetection(device="cpu")
    return _SED_MODEL


def _framewise_probs(
    y: np.ndarray, sr: int, chunk_s: float = 600.0, overlap_s: float = 5.0
) -> tuple[np.ndarray, float]:
    """(time, 527-class) framewise probabilities, chunked/stitched the same
    way audio._energy_from_array bounds memory for long audio."""
    duration_s = len(y) / sr
    bounds = _chunk_bounds(duration_s, chunk_s, overlap_s)
    model = _sed_model()

    pieces = []
    hop_s = None
    for i, (t0, t1) in enumerate(bounds):
        chunk = y[round(t0 * sr) : round(t1 * sr)].astype(np.float32)
        framewise = model.inference(chunk[None, :])[0]
        if hop_s is None:
            hop_s = (t1 - t0) / framewise.shape[0]
        if i > 0:
            framewise = framewise[round(overlap_s / hop_s) :]
        pieces.append(framewise)
    return np.concatenate(pieces, axis=0), hop_s or 0.01


def _spans_above(mask: np.ndarray, hop_s: float) -> list[tuple[int, int]]:
    """(start_frame, end_frame) for each run of consecutive True frames --
    this already merges adjacent above-threshold frames into one span."""
    spans = []
    in_run = False
    start = 0
    for i, above in enumerate(mask):
        if above and not in_run:
            in_run, start = True, i
        elif not above and in_run:
            in_run = False
            spans.append((start, i))
    if in_run:
        spans.append((start, len(mask)))
    return spans


def detect(wav: Path) -> list[AudioEvent]:
    """Laughter/applause spans: PANNs framewise probability >= the per-class
    threshold, adjacent above-threshold frames merged into one event."""
    y, sr = librosa.load(str(wav), sr=_SR, mono=True)
    framewise, hop_s = _framewise_probs(y, sr)

    events: list[AudioEvent] = []
    for class_idx, label in _LABEL_INDICES.items():
        probs = framewise[:, class_idx]
        mask = probs >= _THRESHOLDS[label]
        for lo, hi in _spans_above(mask, hop_s):
            events.append(
                AudioEvent(
                    label=label,
                    t0=lo * hop_s,
                    t1=hi * hop_s,
                    conf=float(probs[lo:hi].max()),
                )
            )

    events.sort(key=lambda e: e.t0)
    return events

"""Audio-only signal extraction: VAD speech/silence spans, RMS energy +
peaks, and filler-word spans over an existing word transcript.
"""

import math
import re
from pathlib import Path

import librosa
import numpy as np
import torch
from silero_vad import get_speech_timestamps, load_silero_vad

from shorts.types import Curve, Peak, Span, Word

_VAD_MODEL = None


def _vad_model():
    global _VAD_MODEL
    if _VAD_MODEL is None:
        # onnx=True: uses the packaged ONNX weights, no torch.hub network
        # fetch at runtime.
        _VAD_MODEL = load_silero_vad(onnx=True)
    return _VAD_MODEL


def run_vad(wav: Path) -> tuple[list[Span], list[Span]]:
    """Speech and silence spans over the whole file via silero VAD."""
    y, sr = librosa.load(str(wav), sr=16000, mono=True)
    duration_s = len(y) / sr

    timestamps = get_speech_timestamps(
        torch.from_numpy(y), _vad_model(), sampling_rate=sr, return_seconds=True
    )
    speech = [Span(t0=ts["start"], t1=ts["end"]) for ts in timestamps]

    silences: list[Span] = []
    cursor = 0.0
    for s in speech:
        if s.t0 > cursor:
            silences.append(Span(t0=cursor, t1=s.t0))
        cursor = max(cursor, s.t1)
    if cursor < duration_s:
        silences.append(Span(t0=cursor, t1=duration_s))

    return speech, silences


def _chunk_bounds(
    duration_s: float, chunk_s: float = 600.0, overlap_s: float = 5.0
) -> list[tuple[float, float]]:
    """(start, end) seconds for each processing chunk: chunk_s long, adjacent
    chunks overlapping by overlap_s so no RMS frame straddling a chunk seam
    is ever computed from a truncated window.

    # ponytail: chunk count is a ceiling over the non-overlapping stride
    # (chunk_s - overlap_s); last chunk is shorter if duration doesn't
    # divide evenly.
    """
    if duration_s <= chunk_s:
        return [(0.0, duration_s)]
    step = chunk_s - overlap_s
    n_chunks = math.ceil((duration_s - overlap_s) / step)
    return [(i * step, min(i * step + chunk_s, duration_s)) for i in range(n_chunks)]


def _rms_curve(y: np.ndarray, sr: int, hop_s: float) -> np.ndarray:
    hop_length = max(1, round(hop_s * sr))
    frame_length = hop_length * 2
    return librosa.feature.rms(
        y=y, frame_length=frame_length, hop_length=hop_length, center=True
    )[0]


def _energy_from_array(
    y: np.ndarray,
    sr: int,
    hop_s: float = 0.05,
    chunk_s: float = 600.0,
    overlap_s: float = 5.0,
) -> np.ndarray:
    """RMS values computed chunk-by-chunk (bounds memory for long audio),
    stitched by dropping each non-first chunk's overlapping head."""
    duration_s = len(y) / sr
    bounds = _chunk_bounds(duration_s, chunk_s, overlap_s)
    overlap_frames = round(overlap_s / hop_s)

    pieces = []
    for i, (t0, t1) in enumerate(bounds):
        chunk = y[round(t0 * sr) : round(t1 * sr)]
        rms = _rms_curve(chunk, sr, hop_s)
        if i > 0:
            rms = rms[overlap_frames:]
        pieces.append(rms)
    return np.concatenate(pieces) if pieces else np.array([], dtype=np.float32)


def _rolling_zscore(values: np.ndarray, window: int) -> np.ndarray:
    """z-score of each value against a centered rolling window (shrinks at
    the array edges rather than padding)."""
    n = len(values)
    if n == 0:
        return values
    half = window // 2
    csum = np.concatenate(([0.0], np.cumsum(values)))
    csum2 = np.concatenate(([0.0], np.cumsum(values.astype(np.float64) ** 2)))
    idx = np.arange(n)
    lo = np.maximum(0, idx - half)
    hi = np.minimum(n, idx + half + 1)
    cnt = (hi - lo).astype(np.float64)
    s = csum[hi] - csum[lo]
    s2 = csum2[hi] - csum2[lo]
    mean = s / cnt
    var = np.maximum(s2 / cnt - mean**2, 0.0)
    std = np.sqrt(var)
    return np.where(std > 1e-9, (values - mean) / std, 0.0)


def energy(wav: Path) -> tuple[Curve, list[Peak]]:
    """RMS energy curve (hop 0.05s) and peaks: frames whose value is > 2.0
    standard deviations above a 30s centered rolling mean."""
    hop_s = 0.05
    y, sr = librosa.load(str(wav), sr=16000, mono=True)
    values = _energy_from_array(y, sr, hop_s=hop_s)

    window = round(30.0 / hop_s)
    z = _rolling_zscore(values, window)
    peaks = [Peak(t=i * hop_s, sigma=float(z[i])) for i in np.flatnonzero(z > 2.0)]

    return Curve(hop_s=hop_s, values=values.tolist()), peaks


# Matches a filler token on its own (um/uh/like) or the "you know" bigram;
# words carry ASR punctuation attached (e.g. "like,"), so punctuation is
# optional at the end.
_SINGLE_FILLER_RE = re.compile(r"^(um|uh|like)[,.]?$", re.IGNORECASE)
_YOU_KNOW_RE = re.compile(r"^you\s+know[,.]?$", re.IGNORECASE)


def fillers(words: list[Word]) -> list[Span]:
    """Spans covering filler words/phrases: um, uh, like, and "you know"."""
    spans: list[Span] = []
    i = 0
    n = len(words)
    while i < n:
        if _SINGLE_FILLER_RE.match(words[i].text):
            spans.append(Span(t0=words[i].t0, t1=words[i].t1))
            i += 1
            continue
        if i + 1 < n and _YOU_KNOW_RE.match(f"{words[i].text} {words[i + 1].text}"):
            spans.append(Span(t0=words[i].t0, t1=words[i + 1].t1))
            i += 2
            continue
        i += 1
    return spans

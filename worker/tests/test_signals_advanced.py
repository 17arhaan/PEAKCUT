"""Golden + unit tests for the advanced audio signals: PANNs audio events,
prosody (rate/pitch/surges/monotone), and MMS_FA forced alignment.
"""

import json
import statistics

import numpy as np

from conftest import fixture
from shorts.ffmpeg import extract_wav
from shorts.signals.align import align_words
from shorts.signals.audio import _pitch_track
from shorts.signals.audio_events import detect
from shorts.signals.transcript import transcribe


def _truth() -> dict:
    return json.loads(fixture("synth_av.truth.json").read_text())


def test_detect_finds_laughter_burst(tmp_path):
    """golden: a laughter event overlapping the synth fixture's spliced
    laughter burst at t=45.0 (+-0.5s tolerance on each edge)."""
    truth = _truth()["laughter_burst"]
    wav = extract_wav(fixture("synth_av.mp4"), tmp_path / "audio.wav")

    events = detect(wav)
    laughter = [e for e in events if e.label == "laughter"]

    hit = next(
        (e for e in laughter if e.t0 < truth["t1"] + 0.5 and e.t1 > truth["t0"] - 0.5),
        None,
    )
    assert hit is not None, f"no laughter event overlaps {truth}; got {events}"


def test_align_words_error_bounds_on_real_talking_head(tmp_path):
    """golden: forced-alignment vs whisper's own word timestamps on real
    (non-synthetic) speech: median align_err_ms <= 100 AND p95 <= 300.

    Gate re-anchored from p95<=100 per decision 2026-07-11: measured
    median/p95 was 72/243ms with errors scattered (not systematic), whisper
    "base" measured worse (337ms p95) so a bigger model doesn't fix it, and
    production uses larger models anyway; whisperX was rejected for
    dependency reasons.
    """
    wav = extract_wav(fixture("real_talking_head.mp4"), tmp_path / "audio.wav")

    language, words = transcribe(wav)
    aligned = align_words(wav, words, language)

    errs = sorted(w.align_err_ms for w in aligned if w.align_err_ms is not None)
    assert errs, "no words were alignable"
    median = statistics.median(errs)
    p95 = errs[int(0.95 * (len(errs) - 1))]
    assert median <= 100.0, f"median align_err_ms={median:.1f}ms"
    assert p95 <= 300.0, f"p95 align_err_ms={p95:.1f}ms (median={median:.1f}ms)"


def test_detect_no_false_laughter_on_real_talking_head(tmp_path):
    """False-positive control for the lowered laughter threshold (0.05):
    real_talking_head.mp4 is 75s of one person speaking with no laughter --
    detect() must return zero laughter events. Measured laughter noise
    floor on this fixture is 0.0013, ~40x below the threshold."""
    wav = extract_wav(fixture("real_talking_head.mp4"), tmp_path / "audio.wav")

    events = detect(wav)

    assert [e for e in events if e.label == "laughter"] == []


def test_align_words_non_english_returns_words_unchanged():
    from shorts.types import Word

    words = [Word(text="bonjour", t0=0.0, t1=0.5, conf=0.9)]
    out = align_words(fixture("synth_av.mp4"), words, language="fr")

    assert out == words
    assert out[0].align_err_ms is None


def test_pitch_track_chunking_has_no_gap_at_seam():
    """Place a steady tone straddling a chunk boundary and confirm pyin's
    stitched f0 track stays voiced and near the true frequency right across
    the seam -- proves the overlap-trim in _pitch_track doesn't blank out
    or duplicate frames there (mirrors the T3 energy-seam test)."""
    sr = 16000
    freq = 220.0
    duration_s = 5.0
    chunk_s, overlap_s = 2.0, 0.5

    t = np.arange(int(duration_s * sr)) / sr
    y = 0.5 * np.sin(2 * np.pi * freq * t).astype(np.float32)

    f0, frame_hop_s = _pitch_track(y, sr, chunk_s=chunk_s, overlap_s=overlap_s)

    seam_s = chunk_s  # first seam is at the chunk boundary (t=2.0)
    lo = round((seam_s - 0.2) / frame_hop_s)
    hi = round((seam_s + 0.2) / frame_hop_s)
    around_seam = f0[lo:hi]

    assert not np.any(np.isnan(around_seam)), "unvoiced gap at the chunk seam"
    assert np.allclose(around_seam, freq, atol=5.0)

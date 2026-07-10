"""Golden + unit tests for the audio signal basics: VAD, RMS energy/peaks,
filler-word spans, and the chunked-RMS math.
"""

import json

import numpy as np

from conftest import approx_spans, fixture
from shorts.ffmpeg import extract_wav
from shorts.signals.audio import (
    _chunk_bounds,
    _energy_from_array,
    energy,
    fillers,
    run_vad,
)
from shorts.types import Word


def _truth() -> dict:
    return json.loads(fixture("synth_av.truth.json").read_text())


def test_vad_finds_silence_gap(tmp_path):
    """golden: VAD must surface a silence covering the acoustic gap. The
    fixture's segment-1 TTS naturally trails into near-silence a bit before
    the nominal 30.0s boundary (atempo-stretched espeak tail); ffmpeg
    silencedetect measures the true acoustic silence as 29.404762-32.013197s.
    This test anchors to those measured boundaries, allowing ±0.15s tolerance.
    """
    truth = _truth()["silence_gap"]
    wav = extract_wav(fixture("synth_av.mp4"), tmp_path / "audio.wav")

    _speech, silences = run_vad(wav)

    # Measured acoustic silence boundaries (ffmpeg silencedetect)
    acoustic_silence = (29.404762, 32.013197)

    mid = (truth["t0"] + truth["t1"]) / 2
    hit = next((s for s in silences if s.t0 <= mid <= s.t1), None)
    assert hit is not None, f"no detected silence covers {truth}"
    assert approx_spans(hit, acoustic_silence, tol_s=0.15)


def test_energy_peak_near_sine_burst(tmp_path):
    """golden: a peak (z > 2.0) within 0.25s of the +12dB sine burst."""
    truth = _truth()["sine_burst"]
    wav = extract_wav(fixture("synth_av.mp4"), tmp_path / "audio.wav")

    _curve, peaks = energy(wav)

    assert any(abs(p.t - truth["t0"]) <= 0.25 for p in peaks)


def test_chunk_bounds_single_chunk_when_short():
    assert _chunk_bounds(90.0) == [(0.0, 90.0)]


def test_chunk_bounds_ceiling_math():
    bounds = _chunk_bounds(1805.0, chunk_s=600.0, overlap_s=5.0)
    # step = 595; ceil((1805-5)/595) = ceil(3.025) = 4 chunks
    assert len(bounds) == 4
    assert bounds[0] == (0.0, 600.0)
    assert bounds[-1][1] == 1805.0


def test_energy_chunking_has_no_gap_or_duplication_at_seam():
    """Place a short burst straddling a chunk boundary and confirm the
    stitched curve still shows it continuously -- proves the overlap trim
    doesn't drop or double-count frames at the seam."""
    sr = 1000
    hop_s = 0.1
    chunk_s, overlap_s = 2.0, 0.5
    duration_s = 5.0

    y = np.zeros(int(duration_s * sr), dtype=np.float32)
    burst_t0, burst_t1 = 1.9, 2.1  # straddles the chunk-0/chunk-1 seam at t=2.0
    y[int(burst_t0 * sr) : int(burst_t1 * sr)] = 1.0

    values = _energy_from_array(y, sr, hop_s=hop_s, chunk_s=chunk_s, overlap_s=overlap_s)

    lo = round(burst_t0 / hop_s)
    hi = round(burst_t1 / hop_s)
    assert np.all(values[lo:hi] > 0.3)


def _w(text, t0, t1):
    return Word(text=text, t0=t0, t1=t1, conf=0.9)


def test_fillers_detects_single_tokens_and_you_know():
    words = [
        _w("So", 0.0, 0.3),
        _w("um", 0.3, 0.5),
        _w("I", 0.6, 0.7),
        _w("like,", 0.7, 0.9),
        _w("think", 1.0, 1.3),
        _w("you", 1.4, 1.5),
        _w("know", 1.5, 1.7),
        _w("uh", 1.8, 1.9),
        _w("yeah", 2.0, 2.2),
    ]

    spans = fillers(words)

    assert (spans[0].t0, spans[0].t1) == (0.3, 0.5)  # um
    assert (spans[1].t0, spans[1].t1) == (0.7, 0.9)  # like,
    assert (spans[2].t0, spans[2].t1) == (1.4, 1.7)  # you know
    assert (spans[3].t0, spans[3].t1) == (1.8, 1.9)  # uh
    assert len(spans) == 4

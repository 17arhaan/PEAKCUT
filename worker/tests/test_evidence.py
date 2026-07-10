"""Gate tests against the REAL fixture index: build once (module-scoped)
from synth_av.mp4 via build_signal_index, then hand-write Claims -- one
valid claim per kind (values queried straight out of the built index, so
they're guaranteed correct) and one invalid claim per kind (nonexistent
peak, wrong sigma, out-of-window t, unknown kind, fabricated quote), each
asserted to yield exactly one Violation with the right reason substring.
"""

import pytest

from conftest import fixture
from shorts.agents.evidence import Violation, validate_claims
from shorts.ffmpeg import extract_wav, probe
from shorts.signals.index import build_signal_index
from shorts.types import Claim, SourceMedia, Span


@pytest.fixture(scope="module")
def idx(tmp_path_factory):
    workdir = tmp_path_factory.mktemp("evidence_signals")
    video = fixture("synth_av.mp4")
    wav = extract_wav(video, workdir / "audio.wav")
    media = SourceMedia(video=video, wav16k=wav, info=probe(video))
    return build_signal_index(media, workdir)


@pytest.fixture(scope="module")
def window(idx):
    return Span(t0=0.0, t1=idx.media.duration_s)


def test_valid_energy_peak_claim_passes(idx, window):
    peak = idx.peaks[0]
    claims = [Claim(kind="energy_peak", t=peak.t, value=peak.sigma)]
    assert validate_claims(claims, idx, window) == []


def test_nonexistent_energy_peak_is_a_violation(idx, window):
    t = _time_with_no_peak_within(idx, tol=0.5)
    claims = [Claim(kind="energy_peak", t=t, value=2.5)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "no energy peak" in violations[0].reason


def test_wrong_sigma_energy_peak_is_a_violation(idx, window):
    peak = idx.peaks[0]
    wrong_sigma = peak.sigma + 5.0
    claims = [Claim(kind="energy_peak", t=peak.t, value=wrong_sigma)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "no energy peak" in violations[0].reason
    assert f"sigma={peak.sigma}" in violations[0].reason or str(peak.sigma) in violations[0].reason


def test_energy_peak_bad_value_type_is_a_violation(idx, window):
    peak = idx.peaks[0]
    claims = [Claim(kind="energy_peak", t=peak.t, value="not-a-number")]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "bad value type" in violations[0].reason


def test_valid_laughter_claim_passes(idx, window):
    laughter = next(e for e in idx.events if e.label == "laughter")
    claims = [Claim(kind="laughter", t=laughter.t0, value=laughter.conf)]
    assert validate_claims(claims, idx, window) == []


def test_fabricated_laughter_is_a_violation(idx, window):
    t = _time_with_no_event_within(idx, "laughter", tol=1.0)
    claims = [Claim(kind="laughter", t=t)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "no laughter event" in violations[0].reason


def test_valid_rate_surge_claim_passes(idx, window):
    if not idx.surges:
        pytest.skip("fixture has no rate surges to test against")
    surge = idx.surges[0]
    mid = (surge.t0 + surge.t1) / 2
    claims = [Claim(kind="rate_surge", t=mid)]
    assert validate_claims(claims, idx, window) == []


def test_fabricated_rate_surge_is_a_violation(idx, window):
    t = _time_outside_all_spans(idx.surges, idx.media.duration_s)
    claims = [Claim(kind="rate_surge", t=t)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "no rate surge" in violations[0].reason


def test_valid_silence_claim_passes(idx, window):
    assert idx.silences, "fixture must have at least one silence span"
    silence = idx.silences[0]
    mid = (silence.t0 + silence.t1) / 2
    claims = [Claim(kind="silence", t=mid)]
    assert validate_claims(claims, idx, window) == []


def test_fabricated_silence_is_a_violation(idx, window):
    t = _time_outside_all_spans(idx.silences, idx.media.duration_s, pad=2.0)
    claims = [Claim(kind="silence", t=t)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "no silence" in violations[0].reason


def test_valid_scene_stable_claim_passes(idx, window):
    long_scene = next((s for s in idx.scenes if s.t1 - s.t0 >= 15.0), None)
    assert long_scene is not None, "fixture must have a scene >=15s"
    claims = [Claim(kind="scene_stable", t=long_scene.t0 + 0.1)]
    assert validate_claims(claims, idx, window) == []


def test_short_scene_stable_is_a_violation(idx, window):
    short_scene = next((s for s in idx.scenes if s.t1 - s.t0 < 15.0), None)
    if short_scene is None:
        pytest.skip("fixture has no scene under 15s to test against")
    claims = [Claim(kind="scene_stable", t=short_scene.t0 + 0.1)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "scene" in violations[0].reason


def test_valid_quote_claim_passes(idx, window):
    # take three consecutive real words as the "quote"
    words = idx.words[:3]
    assert len(words) == 3
    value = " ".join(w.text for w in words)
    claims = [Claim(kind="quote", t=words[0].t0, value=value)]
    assert validate_claims(claims, idx, window) == []


def test_fabricated_quote_is_a_violation(idx, window):
    claims = [Claim(kind="quote", t=idx.words[0].t0, value="zzz nonexistent gibberish quote zzz")]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert "quote" in violations[0].reason


def test_unknown_kind_is_a_violation(idx, window):
    claims = [Claim(kind="bogus_kind", t=1.0)]
    violations = validate_claims(claims, idx, window)
    assert len(violations) == 1
    assert violations[0].reason == "unknown kind"


def test_out_of_window_claim_is_a_violation(idx, window):
    peak = idx.peaks[0]
    tight_window = Span(t0=peak.t + 100.0, t1=peak.t + 200.0)
    claims = [Claim(kind="energy_peak", t=peak.t, value=peak.sigma)]
    violations = validate_claims(claims, idx, tight_window)
    assert len(violations) == 1
    assert "outside window" in violations[0].reason


def test_multiple_claims_each_get_own_violation_or_pass(idx, window):
    peak = idx.peaks[0]
    good = Claim(kind="energy_peak", t=peak.t, value=peak.sigma)
    bad = Claim(kind="bogus_kind", t=1.0)
    violations = validate_claims([good, bad], idx, window)
    assert len(violations) == 1
    assert violations[0].claim == bad


# --- helpers -----------------------------------------------------------


def _time_with_no_peak_within(idx, tol: float) -> float:
    duration = idx.media.duration_s
    candidate = 1.0
    while candidate < duration - 1.0:
        if all(abs(p.t - candidate) > tol for p in idx.peaks):
            return candidate
        candidate += 1.0
    raise AssertionError("could not find a t with no nearby peak in fixture")


def _time_with_no_event_within(idx, label: str, tol: float) -> float:
    duration = idx.media.duration_s
    events = [e for e in idx.events if e.label == label]
    candidate = 1.0
    while candidate < duration - 1.0:
        if all(e.t1 + tol < candidate or e.t0 - tol > candidate for e in events):
            return candidate
        candidate += 1.0
    raise AssertionError(f"could not find a t with no nearby {label} event in fixture")


def _time_outside_all_spans(spans, duration: float, pad: float = 0.5) -> float:
    candidate = 1.0
    while candidate < duration - 1.0:
        if all(candidate < s.t0 - pad or candidate > s.t1 + pad for s in spans):
            return candidate
        candidate += 1.0
    raise AssertionError("could not find a t outside all spans in fixture")

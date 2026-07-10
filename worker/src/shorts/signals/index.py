"""SignalIndex: builds the per-video signal bundle and provides simple
time-range query helpers over it, plus JSON save/load.
"""

import json
from dataclasses import asdict
from pathlib import Path

from shorts.signals.audio import energy, fillers, run_vad
from shorts.signals.transcript import transcribe
from shorts.signals.video import detect_defects, detect_faces, detect_scenes, motion_curve
from shorts.types import (
    AudioEvent,
    Box,
    Curve,
    FaceFrame,
    MediaInfo,
    Peak,
    SignalIndex,
    SourceMedia,
    Span,
    Word,
)

SCHEMA_VERSION = 1


def build_signal_index(media: SourceMedia, workdir: Path) -> SignalIndex:
    """Build a SignalIndex from `media`, filling in the signals that exist
    today (transcript, VAD, RMS energy/peaks, fillers) and leaving the rest
    as empty lists/curves for later tasks to populate."""
    language, words = transcribe(media.wav16k)
    speech, silences = run_vad(media.wav16k)
    energy_curve, peaks = energy(media.wav16k)
    defects_black, defects_frozen = detect_defects(media.video)

    empty_curve = Curve(hop_s=0.0, values=[])

    return SignalIndex(
        version=SCHEMA_VERSION,
        media=media.info,
        language=language,
        words=words,
        fillers=fillers(words),
        speech=speech,
        silences=silences,
        energy=energy_curve,
        peaks=peaks,
        rate=empty_curve,
        pitch=empty_curve,
        surges=[],
        monotone=[],
        events=[],
        scenes=detect_scenes(media.video),
        faces=detect_faces(media.video),
        motion=motion_curve(media.video),
        defects_black=defects_black,
        defects_frozen=defects_frozen,
    )


def save(idx: SignalIndex, path: Path) -> None:
    Path(path).write_text(json.dumps(asdict(idx), indent=2))


# ponytail: hand-written per-type reconstruction rather than a generic
# reflection helper -- SignalIndex's nested dataclasses are shallow and
# fixed, not worth a dataclass-schema walker.
def _span(d: dict) -> Span:
    return Span(t0=d["t0"], t1=d["t1"])


def _word(d: dict) -> Word:
    return Word(
        text=d["text"], t0=d["t0"], t1=d["t1"], conf=d["conf"],
        align_err_ms=d.get("align_err_ms"),
    )


def _peak(d: dict) -> Peak:
    return Peak(t=d["t"], sigma=d["sigma"])


def _curve(d: dict) -> Curve:
    return Curve(hop_s=d["hop_s"], values=list(d["values"]))


def _event(d: dict) -> AudioEvent:
    return AudioEvent(label=d["label"], t0=d["t0"], t1=d["t1"], conf=d["conf"])


def _box(d: dict) -> Box:
    return Box(x=d["x"], y=d["y"], w=d["w"], h=d["h"], conf=d["conf"])


def _face(d: dict) -> FaceFrame:
    return FaceFrame(t=d["t"], boxes=[_box(b) for b in d["boxes"]], dominant=d.get("dominant"))


def _media_info(d: dict) -> MediaInfo:
    return MediaInfo(
        duration_s=d["duration_s"], fps=d["fps"], width=d["width"], height=d["height"]
    )


_REQUIRED_KEYS = {
    "version", "media", "language", "words", "fillers", "speech", "silences",
    "energy", "peaks", "rate", "pitch", "surges", "monotone", "events",
    "scenes", "faces", "motion", "defects_black", "defects_frozen",
}


def load(path: Path) -> SignalIndex:
    data = json.loads(Path(path).read_text())

    missing = _REQUIRED_KEYS - data.keys()
    if missing:
        raise ValueError(f"signals JSON missing keys: {sorted(missing)}")
    if data["version"] != SCHEMA_VERSION:
        raise ValueError(f"unsupported signals schema version {data['version']!r}")

    return SignalIndex(
        version=data["version"],
        media=_media_info(data["media"]),
        language=data["language"],
        words=[_word(w) for w in data["words"]],
        fillers=[_span(s) for s in data["fillers"]],
        speech=[_span(s) for s in data["speech"]],
        silences=[_span(s) for s in data["silences"]],
        energy=_curve(data["energy"]),
        peaks=[_peak(p) for p in data["peaks"]],
        rate=_curve(data["rate"]),
        pitch=_curve(data["pitch"]),
        surges=[_span(s) for s in data["surges"]],
        monotone=[_span(s) for s in data["monotone"]],
        events=[_event(e) for e in data["events"]],
        scenes=[_span(s) for s in data["scenes"]],
        faces=[_face(f) for f in data["faces"]],
        motion=_curve(data["motion"]),
        defects_black=[_span(s) for s in data["defects_black"]],
        defects_frozen=[_span(s) for s in data["defects_frozen"]],
    )


# --- query helpers -----------------------------------------------------
# ponytail: linear scan, bisect if indexes grow.


def peaks_in(idx: SignalIndex, t0: float, t1: float) -> list[Peak]:
    return [p for p in idx.peaks if t0 <= p.t <= t1]


def nearest_silence(idx: SignalIndex, t: float) -> Span | None:
    if not idx.silences:
        return None

    def distance(s: Span) -> float:
        if s.t0 <= t <= s.t1:
            return 0.0
        return min(abs(s.t0 - t), abs(s.t1 - t))

    return min(idx.silences, key=distance)


def word_at(idx: SignalIndex, t: float) -> Word | None:
    for w in idx.words:
        if w.t0 <= t <= w.t1:
            return w
    return None


def words_in(idx: SignalIndex, t0: float, t1: float) -> list[Word]:
    return [w for w in idx.words if w.t0 < t1 and w.t1 > t0]


def faces_at(idx: SignalIndex, t: float) -> FaceFrame | None:
    if not idx.faces:
        return None
    return min(idx.faces, key=lambda f: abs(f.t - t))


def scene_span(idx: SignalIndex, t: float) -> Span | None:
    for s in idx.scenes:
        if s.t0 <= t <= s.t1:
            return s
    return None


def events_in(
    idx: SignalIndex, t0: float, t1: float, label: str | None = None
) -> list[AudioEvent]:
    return [
        e for e in idx.events
        if e.t0 < t1 and e.t1 > t0 and (label is None or e.label == label)
    ]

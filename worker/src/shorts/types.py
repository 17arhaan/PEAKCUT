from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Span:
    t0: float
    t1: float


@dataclass(frozen=True)
class Word:
    text: str
    t0: float
    t1: float
    conf: float
    align_err_ms: float | None = None


@dataclass(frozen=True)
class Peak:
    t: float
    sigma: float


@dataclass(frozen=True)
class Curve:
    hop_s: float
    values: list[float]


@dataclass(frozen=True)
class AudioEvent:
    label: str
    t0: float
    t1: float
    conf: float  # label in {"laughter","applause"}


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float
    conf: float  # normalized 0..1


@dataclass(frozen=True)
class FaceFrame:
    t: float
    boxes: list[Box]
    dominant: int | None


@dataclass(frozen=True)
class MediaInfo:
    duration_s: float
    fps: float
    width: int
    height: int


@dataclass(frozen=True)
class SourceMedia:
    video: Path
    wav16k: Path
    info: MediaInfo


@dataclass
class SignalIndex:
    version: int
    media: MediaInfo
    language: str
    words: list[Word]
    fillers: list[Span]
    speech: list[Span]
    silences: list[Span]
    energy: Curve
    peaks: list[Peak]
    rate: Curve
    pitch: Curve
    surges: list[Span]
    monotone: list[Span]
    events: list[AudioEvent]
    scenes: list[Span]
    faces: list[FaceFrame]
    motion: Curve
    defects_black: list[Span]
    defects_frozen: list[Span]


@dataclass(frozen=True)
class Claim:
    kind: str
    t: float
    value: float | str | None = None


@dataclass
class Candidate:
    t0: float
    t1: float
    source: str
    evidence: list[Claim]
    notes: str = ""


@dataclass
class Scored:
    candidate: Candidate
    total: int
    components: dict[str, tuple[int, list[Claim]]]  # name -> (0..25 score, cited claims)
    verdict: str  # "keep" | "kill" | "borderline"


@dataclass
class Cut:
    t0: float
    t1: float
    payoff_word_i: int | None = None


@dataclass
class Hook:
    title: str
    captions: dict[str, str]  # platform -> caption


@dataclass(frozen=True)
class QAFail:
    code: str
    detail: str
    route_to: str  # route_to: "surgeon"|"render"|"drop"


@dataclass
class QAReport:
    passed: bool
    failures: list[QAFail] = field(default_factory=list)


@dataclass
class ClipResult:
    mp4: Path | None
    thumb: Path | None
    cut: Cut
    score: Scored | None
    hook: Hook | None
    qa: QAReport | None
    dropped_reason: str | None = None

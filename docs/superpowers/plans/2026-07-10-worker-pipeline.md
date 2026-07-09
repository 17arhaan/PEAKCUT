# Worker Pipeline Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Python pipeline — `shorts run <file|youtube-url> -o out/` — that finds the best moments in a long video via measured signals + a code-gated LLM agent crew, and renders 9:16 clips with karaoke captions, face-aware crop, hooks, and QA-verified output. Modal deployment last; nothing imports Modal before the final task.

**Architecture:** Walking skeleton (Architect B's ordering, critic-approved): a crude end-to-end pipeline lands in T2 and `tests/test_e2e.py` stays green after every subsequent task. Each task swaps one crude stage for the real one. Component designs largely from Architect A: per-kind evidence gate, index query helpers, 3-fixture strategy, token accounting. Origin docs: spec `docs/superpowers/specs/2026-07-09-shorts-factory-design.md`; critic verdict merged 2026-07-10.

**Tech Stack:** Python 3.12, uv. faster-whisper ≥1.1, torchaudio `forced_align` (MMS_FA) — **whisperX is banned from the dependency tree**. silero-vad ≥5 (ONNX path), librosa 0.10.x, panns-inference, scenedetect 0.6.x, mediapipe ≥0.10, opencv-python-headless, yt-dlp, anthropic SDK. ffmpeg/ffprobe via `subprocess.run` list-args (no ffmpeg-python wrapper).

## Global Constraints

- Working dir for all tasks: `worker/` inside the repo. Package name `shorts`, layout `worker/src/shorts/`.
- Python 3.12; `uv` manages deps; lockfile must resolve for macOS-arm64 AND `--python-platform x86_64-unknown-linux-gnu` (Modal image).
- All heavy deps land in ONE resolver fight (T1). No dep added after T1 without noting it in the task's commit message.
- ffmpeg via `subprocess.run([...], check=True, capture_output=True)`; never shell strings.
- No `utils.py`, no config framework (env vars + argparse only), no base classes, no plugin registries. Extractors are plain functions `f(input) -> dataclass`.
- Env vars: `SHORTS_WHISPER_MODEL` (default `small`; tests use `tiny`), `SHORTS_LLM` = `stub`|`live` (default `stub`), `ANTHROPIC_API_KEY` for live.
- LLM tests: handcrafted stub JSONs per test (committed). NO hash-keyed record/replay. Live smokes behind `SHORTS_LLM=live`, excluded from CI.
- Every non-trivial module keeps ONE runnable check (pytest test or `__main__` self-check). No per-function test suites (YAGNI).
- Loudness target: −14 LUFS ±1 (EBU R128, two-pass `loudnorm`). Output: 1080×1920, H.264 + AAC, `yuv420p`.
- Caption rendering: ASS via libass `subtitles=` filter; fonts committed in `worker/fonts/` (Inter + Noto Sans, OFL), passed via `fontsdir`.
- Alignment QA threshold: p95 `align_err_ms` ≤ 100 for `language == "en"`; alignment check SKIPPED for non-English in v1 (documented in qa.py).
- Long inputs: audio analysis (librosa/PANNs) processes wav in 10-min chunks with 5s overlap; hard cap 3h/2GB enforced in ingest.
- Commit after every green step; messages `feat(worker): ...` / `test(worker): ...`.
- Mark deliberate simplifications with `# ponytail: <ceiling + upgrade path>` comments.

## File map (final state)

```
worker/
  pyproject.toml
  fonts/                     # Inter-Bold.ttf, NotoSans-Bold.ttf (OFL, committed)
  src/shorts/
    types.py                 # ALL shared dataclasses; no logic
    cli.py                   # argparse: shorts doctor|index|run|render
    pipeline.py              # stage sequencing, partial success, checkpoint/resume
    ingest.py                # local file / yt-dlp -> SourceMedia (+16k mono wav)
    agent_log.py             # JSONL agent-event log incl. token counts
    ffmpeg.py                # probe/run/extract_wav subprocess helpers
    signals/
      __init__.py            # build_signal_index(media, workdir) -> SignalIndex
      transcript.py          # faster-whisper words + filler regex
      align.py               # torchaudio forced_align -> align_err_ms per word
      audio.py               # VAD, RMS+peaks, rate, pitch, surges/monotone (chunked)
      audio_events.py        # PANNs laughter/applause
      video.py               # scenes, faces (mediapipe), motion, black/frozen
      index.py               # SignalIndex save/load + query helpers
    agents/
      llm.py                 # complete_json(); SHORTS_LLM switch; token counts
      evidence.py            # per-kind claim validation (THE gate)
      scout.py               # heuristic ∪ LLM candidates
      critic.py              # scoring + kill threshold
      surgeon.py             # deterministic cut refinement
      hooks.py               # hook/captions + code-enforced constraints
      orchestrator.py        # Scout↔Critic ≤2 rounds; repair routing
    render/
      captions.py            # Word[] -> ASS karaoke (pure function)
      renderer.py            # cut/crop/burn/loudnorm/thumbnail
    qa.py                    # pure-code output gate
    modal_app.py             # T18 only
  scripts/make_fixtures.py   # synthetic fixtures + fetch 3 CC clips
  tests/
    conftest.py  fixtures/  llm_stubs/
    test_e2e.py              # the always-green skeleton guard
    test_<module>.py
```

---

### Task 0: Fixture factory

**Files:**
- Create: `worker/scripts/make_fixtures.py`, `worker/tests/conftest.py`, `worker/tests/fixtures/MANIFEST.json`
- Test: `worker/tests/test_fixtures.py`

**Interfaces:**
- Produces committed fixtures consumed by every later task:
  - `tests/fixtures/synth_av.mp4` (90s, constructed): espeak-ng TTS speech with known transcript text, a 2.0s silence gap at t=30.0, a spliced CC0 laughter burst at t=45.0, a loud sine burst (+12dB over base) at t=60.0, video = `testsrc2` with hard color-cuts at t=20/40/70 and a 1.0s black segment at t=75.0. Ground truth written to `fixtures/synth_av.truth.json` by the generator itself.
  - `tests/fixtures/real_talking_head.mp4`, `real_podcast_2p.mp4`, `real_screenshare.mp4` — CC-licensed, 60–90s, re-encoded 480p, ≤6MB each (spec §8 mandates all three).
  - `conftest.py` exposes `fixture(name) -> Path` and `approx_spans(a, b, tol_s)` comparator.

- [ ] **Step 1: Write `make_fixtures.py`** — pure ffmpeg `lavfi` + espeak-ng; emits mp4s + `synth_av.truth.json` containing the exact inserted times above. Real clips: download via yt-dlp from documented CC-BY URLs (chosen at implementation time; record URL + license in MANIFEST), re-encode 480p. Script is run ONCE by the implementer; outputs committed. CI never runs it.
- [ ] **Step 2: Write `test_fixtures.py`** — asserts each fixture exists, duration within MANIFEST ±0.5s, sha256 matches MANIFEST.
- [ ] **Step 3: Run generator, eyeball clips, commit fixtures + manifest.**
  Run: `uv run python scripts/make_fixtures.py && uv run pytest tests/test_fixtures.py -v` → PASS
- [ ] **Step 4: Commit** — `test(worker): fixture factory + committed fixtures`

### Task 1: Scaffold, all heavy deps, types, ffmpeg helpers, doctor

**Files:**
- Create: `worker/pyproject.toml`, `worker/src/shorts/types.py`, `worker/src/shorts/ffmpeg.py`, `worker/src/shorts/cli.py`, `worker/fonts/`
- Test: `worker/tests/test_ffmpeg.py`

**Interfaces (Produces — the contract every later task imports):**

```python
# types.py — complete file, frozen from day one. No logic, no methods except noted.
from dataclasses import dataclass, field
from pathlib import Path

@dataclass(frozen=True)
class Span:  t0: float; t1: float
@dataclass(frozen=True)
class Word:  text: str; t0: float; t1: float; conf: float; align_err_ms: float | None = None
@dataclass(frozen=True)
class Peak:  t: float; sigma: float
@dataclass(frozen=True)
class Curve: hop_s: float; values: list[float]
@dataclass(frozen=True)
class AudioEvent: label: str; t0: float; t1: float; conf: float   # label in {"laughter","applause"}
@dataclass(frozen=True)
class Box: x: float; y: float; w: float; h: float; conf: float    # normalized 0..1
@dataclass(frozen=True)
class FaceFrame: t: float; boxes: list[Box]; dominant: int | None
@dataclass(frozen=True)
class MediaInfo: duration_s: float; fps: float; width: int; height: int
@dataclass(frozen=True)
class SourceMedia: video: Path; wav16k: Path; info: MediaInfo

@dataclass
class SignalIndex:
    version: int; media: MediaInfo; language: str
    words: list[Word]; fillers: list[Span]
    speech: list[Span]; silences: list[Span]
    energy: Curve; peaks: list[Peak]
    rate: Curve; pitch: Curve; surges: list[Span]; monotone: list[Span]
    events: list[AudioEvent]; scenes: list[Span]
    faces: list[FaceFrame]; motion: Curve
    defects_black: list[Span]; defects_frozen: list[Span]

@dataclass(frozen=True)
class Claim: kind: str; t: float; value: float | str | None = None
@dataclass
class Candidate: t0: float; t1: float; source: str; evidence: list[Claim]; notes: str = ""
@dataclass
class Scored:
    candidate: Candidate; total: int
    components: dict[str, tuple[int, list[Claim]]]   # name -> (0..25 score, cited claims)
    verdict: str                                     # "keep" | "kill" | "borderline"
@dataclass
class Cut: t0: float; t1: float; payoff_word_i: int | None = None
@dataclass
class Hook: title: str; captions: dict[str, str]     # platform -> caption
@dataclass(frozen=True)
class QAFail: code: str; detail: str; route_to: str  # route_to: "surgeon"|"render"|"drop"
@dataclass
class QAReport: passed: bool; failures: list[QAFail] = field(default_factory=list)
@dataclass
class ClipResult:
    mp4: Path | None; thumb: Path | None; cut: Cut
    score: Scored | None; hook: Hook | None; qa: QAReport | None
    dropped_reason: str | None = None
```

```python
# ffmpeg.py
def probe(path: Path) -> MediaInfo: ...          # ffprobe -print_format json
def run(args: list[str]) -> str: ...             # ffmpeg wrapper; raises FfmpegError(stderr tail)
def extract_wav(video: Path, out: Path, sr: int = 16000) -> Path: ...
```

- [ ] **Step 1: `pyproject.toml` with ALL heavy deps** (faster-whisper, torch, torchaudio, silero-vad, librosa, panns-inference, scenedetect[opencv], mediapipe, opencv-python-headless, yt-dlp, anthropic, modal, pytest). One resolver fight, per critic directive 7.
  Run: `uv lock && uv lock --check` and `uv pip compile` sanity for linux platform. Expected: resolves on both platforms. If mediapipe/torch conflict: pin torch first, record pins in pyproject comments.
- [ ] **Step 2: `types.py` exactly as above; `ffmpeg.py`; failing test** `test_ffmpeg.py::test_probe` — probe on a 1s generated clip asserts duration/fps/size.
- [ ] **Step 3: `shorts doctor`** — imports every heavy module, checks ffmpeg/ffprobe/espeak on PATH, prints versions, exit 0/1.
  Run: `uv run shorts doctor` → exit 0.
- [ ] **Step 4: Commit** — `feat(worker): scaffold, types contract, ffmpeg helpers, doctor`

### Task 2: Walking skeleton (crude but complete e2e)

**Files:**
- Create: `worker/src/shorts/pipeline.py`, `worker/src/shorts/signals/transcript.py`, `worker/src/shorts/render/captions.py`, `worker/src/shorts/render/renderer.py`
- Modify: `worker/src/shorts/cli.py`
- Test: `worker/tests/test_e2e.py`

**Interfaces:**
- Produces: `pipeline.run(source: Path, out_dir: Path) -> list[ClipResult]`; `transcript.transcribe(wav: Path) -> tuple[str, list[Word]]` (language, words; faster-whisper, model from `SHORTS_WHISPER_MODEL`); `captions.words_to_ass(words: list[Word], style: str, resolution: tuple[int,int]) -> str` (basic style, no karaoke yet); `renderer.render_clip(video: Path, cut: Cut, ass: str, out: Path) -> Path` (center-crop `crop=ih*9/16:ih`, scale 1080×1920, burn subs).
- Crude picker lives INLINE in `pipeline.py`: first 30s of speech (`words[0].t0` → +30s). `# ponytail: crude picker, replaced in T6`.

- [ ] **Step 1: failing e2e test:**

```python
def test_e2e_produces_valid_clip(tmp_path):
    results = run(fixture("real_talking_head.mp4"), tmp_path)
    ok = [r for r in results if r.mp4]
    assert len(ok) >= 1
    info = probe(ok[0].mp4)
    assert (info.width, info.height) == (1080, 1920)
    assert 5 <= info.duration_s <= 65
    assert (tmp_path / "run.json").exists()
```

  Run: `uv run pytest tests/test_e2e.py -v` → FAIL (no pipeline module).
- [ ] **Step 2: implement the four modules, minimal.** whisper `tiny` in tests. `run.json` = list of clip dicts (paths, cut times).
- [ ] **Step 3:** `uv run pytest tests/ -v` → ALL PASS. `uv run shorts run tests/fixtures/real_talking_head.mp4 -o /tmp/sk && open /tmp/sk` — human eyeballs the ugly clip.
- [ ] **Step 4: Commit** — `feat(worker): walking skeleton e2e — video in, captioned 9:16 clip out`

### Task 3: SignalIndex + audio basics + query helpers

**Files:**
- Create: `worker/src/shorts/signals/audio.py`, `worker/src/shorts/signals/index.py`, `worker/src/shorts/signals/__init__.py`
- Modify: `worker/src/shorts/pipeline.py` (build + persist index; picker reads speech spans)
- Test: `worker/tests/test_signals_audio.py`, `worker/tests/test_index.py`

**Interfaces:**
- `audio.run_vad(wav) -> tuple[list[Span], list[Span]]` (speech, silences; silero ONNX)
- `audio.energy(wav) -> tuple[Curve, list[Peak]]` (RMS hop 0.05s; peaks = z>2.0 over 30s rolling window; **processes wav in 10-min chunks, 5s overlap**)
- `audio.fillers(words) -> list[Span]` (regex on word stream: um/uh/like,/you know)
- `index.build_signal_index(media: SourceMedia, workdir: Path) -> SignalIndex` (fills what exists; empty lists elsewhere)
- `SignalIndex` save/load: `index.save(idx, path)` / `index.load(path)` — JSON, schema version 1, round-trip equal
- Query helpers on module level: `peaks_in(idx, t0, t1) -> list[Peak]`, `nearest_silence(idx, t) -> Span | None`, `word_at(idx, t) -> Word | None`, `words_in(idx, t0, t1) -> list[Word]`, `faces_at(idx, t) -> FaceFrame | None`, `scene_span(idx, t) -> Span | None`, `events_in(idx, t0, t1, label=None) -> list[AudioEvent]`

- [ ] **Step 1: failing golden tests** — on `synth_av.mp4`: silence gap found within ±0.15s of truth t=30.0; energy peak within ±0.25s of truth t=60.0. Round-trip save/load equality on a hand-built index.
- [ ] **Step 2: implement; wire into pipeline** (writes `out/signals.json`).
- [ ] **Step 3:** full suite green incl. e2e. **Step 4: Commit.**

### Task 4: Video signals

**Files:**
- Create: `worker/src/shorts/signals/video.py`
- Modify: `worker/src/shorts/signals/__init__.py` (index now fills scenes/faces/motion/defects)
- Test: `worker/tests/test_signals_video.py`

**Interfaces:**
- `detect_scenes(video) -> list[Span]` (scenedetect ContentDetector)
- `detect_faces(video, fps=1.0) -> list[FaceFrame]` (mediapipe; `dominant` = largest box, sticky: keep previous dominant if IoU>0.3)
- `motion_curve(video) -> Curve` (OpenCV frame-diff, hop 0.5s)
- `detect_defects(video) -> tuple[list[Span], list[Span]]` (black, frozen; parse ffmpeg blackdetect/freezedetect stderr)

- [ ] **Step 1: failing goldens** — synth: scene cuts at 20/40/70 ±1 frame, black at 75.0 ±0.2s; real_talking_head: face in ≥80% of sampled seconds; real_podcast_2p: ≥2 boxes in ≥50% of samples; real_screenshare: faces list may be empty → asserts no crash, `dominant is None` rows allowed.
- [ ] **Step 2–4: implement, suite green, commit.**

### Task 5: Advanced audio + forced alignment

**Files:**
- Create: `worker/src/shorts/signals/audio_events.py`, `worker/src/shorts/signals/align.py`
- Modify: `worker/src/shorts/signals/audio.py` (rate/pitch/surges/monotone), `signals/__init__.py`
- Test: `worker/tests/test_signals_advanced.py`

**Interfaces:**
- `audio_events.detect(wav) -> list[AudioEvent]` (PANNs CNN14, chunked, labels filtered to laughter/applause, threshold 0.5, adjacent merged)
- `audio.prosody(wav, words) -> tuple[Curve, Curve, list[Span], list[Span]]` (rate wps hop 1s; pitch f0-variance hop 1s via librosa pyin on chunks; surges = rate > mean+1σ for ≥3s; monotone = pitch-var < mean−1σ for ≥10s)
- `align.align_words(wav, words, language) -> list[Word]` — torchaudio `forced_align` MMS_FA; transcript normalized (lowercase, strip punctuation); returns words with `align_err_ms` filled. For `language != "en"`: returns words unchanged with `align_err_ms=None`. `# ponytail: en-only alignment, MMS multilingual if needed`
- **DECISION POINT (record result in this task's commit message):** if p95 align_err_ms > 100 on all 3 real fixtures, escalate to plan owner before proceeding — fallback options: relax QA gate to p95≤150 OR isolated whisperX dep group. Do not silently proceed.

- [ ] **Step 1: failing goldens** — laughter event overlapping truth t=45.0 ±0.5s on synth; p95 align_err ≤100ms on real_talking_head.
- [ ] **Step 2–4: implement, suite green (index now COMPLETE — schema frozen, additive-only after this), commit.**

### Task 6: Heuristic Scout + multi-clip pipeline

**Files:**
- Create: `worker/src/shorts/agents/scout.py`
- Modify: `worker/src/shorts/pipeline.py` (crude picker DELETED)
- Test: `worker/tests/test_scout.py`

**Interfaces:**
- `scout.heuristic_candidates(idx: SignalIndex) -> list[Candidate]` — spec §4 overlap rules: (a) energy peak ∧ rate surge within 5s → candidate ±20s window; (b) laughter/applause event with ≥8s speech before it; (c) scene-stable span ≥20s with top-decile pitch variance. Each candidate carries `evidence=[Claim(...)]` citing the actual signals used. Dedupe by IoU>0.5 (keep higher-evidence one). Cap 20.
- Pipeline renders top 4 candidates by evidence count. e2e tightened: `len(ok) >= 2`.

- [ ] **Step 1: failing unit tests on hand-built tiny SignalIndex objects** (5-word index with one peak+surge → exactly one candidate; empty index → `[]`).
- [ ] **Step 2–4: implement, e2e asserts ≥2 clips, commit.**

### Task 7: Render upgrade — crop policy, caption grouping, karaoke, loudnorm

**Files:**
- Modify: `worker/src/shorts/render/captions.py`, `worker/src/shorts/render/renderer.py`
- Test: `worker/tests/test_captions.py`, `worker/tests/test_render.py`

**Interfaces:**
- `captions.words_to_ass(words, style, resolution) -> str` — words grouped **3–5 per Dialogue line** (break at punctuation or 1.2s gap); `\kf<centisec>` karaoke per word; styles `s1|s2|s3` as `[V4+ Styles]` preset strings; bottom-center, 20% safe margin.
- `renderer.render_clip(video, cut, idx, hook, style, out_dir) -> tuple[Path, Path]` (mp4, thumbnail) with **crop fallback chain** (critic directive 9): dominant face per scene-span → static face-centered crop; no faces → center crop; input already ≤9:16 aspect → scale+pad, no crop. Two-pass loudnorm to −14 LUFS. Thumbnail at cut.t0.
- Fonts committed `worker/fonts/`, passed via `subtitles=...:fontsdir=`.

- [ ] **Step 1: failing tests** — ASS golden-string snapshot (exact match on a 12-word input, all 3 styles); grouping property (no Dialogue line >5 words); render on real_screenshare (no faces → center crop, no crash); LUFS of rendered clip −14 ±1 measured via `ffmpeg -af ebur128`.
- [ ] **Step 2–4: implement, human eyeballs all 3 fixture renders, commit.**

### Task 8: QA gate (checks + partial success; NO routing yet)

**Files:**
- Create: `worker/src/shorts/qa.py`
- Modify: `worker/src/shorts/pipeline.py`
- Test: `worker/tests/test_qa.py`

**Interfaces:**
- `qa.check(mp4: Path, cut: Cut, idx: SignalIndex) -> QAReport` — codes: `RES` (not 1080×1920), `LUFS` (out of −14±1), `BLACK`/`FROZEN` (defect in output), `WORD_CLIP` (a word straddles cut boundary), `ALIGN` (p95 align_err>100ms inside cut, en only), `DUR` (<5s or >90s). All `route_to="drop"` for now. `# ponytail: routing lands in T14`
- Pipeline: failed clip → `ClipResult(dropped_reason=...)`, run continues (spec §7: partial success is success). `run.json` lists drops with reasons.

- [ ] **Step 1: failing tests** — corrupted renders made in-test via ffmpeg (wrong scale → RES; `volume=+8dB` → LUFS; inject 1s black → BLACK) each fail with exactly the right code; clean T7 render passes.
- [ ] **Step 2–4: implement, e2e asserts drops logged + run succeeds, commit.**

### Task 9: Modal hello-whisper spike (mandatory, half-day cap)

**Files:**
- Create: `worker/scripts/modal_spike.py` (throwaway, committed for reference)

- [ ] **Step 1:** Modal function: image with ffmpeg + faster-whisper + fonts, T4 GPU, transcribe 60s of real_podcast_2p uploaded from local, return word count + timing. Run `modal run scripts/modal_spike.py`. Expected: words > 100, wall time < 3min.
- [ ] **Step 2:** Record discoveries (image build time, weight caching, CUDA quirks) as comments in the spike file. Commit — `test(worker): modal spike, GPU transcription proven`.

### Task 10: LLM plumbing + evidence gate + agent log

**Files:**
- Create: `worker/src/shorts/agents/llm.py`, `worker/src/shorts/agents/evidence.py`, `worker/src/shorts/agent_log.py`
- Test: `worker/tests/test_evidence.py`, `worker/tests/test_llm.py`

**Interfaces:**
- `llm.complete_json(prompt: str, schema: dict, agent: str, log: AgentLog) -> dict` — anthropic SDK, model `claude-sonnet-5`, one retry on schema-invalid JSON, raises `LlmError` after. `SHORTS_LLM=stub` → raises `StubModeError` (callers must handle by using their deterministic path — this is what makes `--llm stub` a full no-key run). Token counts logged.
- `agent_log.AgentLog(path)` — `.emit(agent, action, payload, tokens_in=0, tokens_out=0)` appends JSONL; `.totals() -> dict` (per-agent tokens + cost at current pricing).
- `evidence.validate_claims(claims: list[Claim], idx: SignalIndex, window: Span) -> list[Violation]` — **per-kind semantics (critic directive 5, A's design verbatim):**

| kind | resolves iff |
|---|---|
| `energy_peak` | a Peak within ±0.5s of `t` and \|σ−value\| ≤ 0.5 |
| `laughter` / `applause` | an AudioEvent of that label overlaps `t` ±1.0s |
| `rate_surge` | a surge Span contains `t` |
| `silence` | a silence Span within ±0.5s of `t` |
| `scene_stable` | scene_span(t) duration ≥ 15s |
| `quote` | `value` (str) is a substring of `words_in(idx, t−1, t+len/4)` text, case/punct-insensitive |
| anything else | Violation("unknown kind") |

  Claims must also fall inside `window` ±2s. `Violation(claim, reason)` messages are verbatim re-ask material.

- [ ] **Step 1: failing gate tests against the REAL fixture index** (load `signals.json` built from synth_av): valid claim per kind passes; nonexistent peak, wrong σ, out-of-window t, unknown kind, fabricated quote each yield exactly one Violation with the right reason.
- [ ] **Step 2: implement all three modules.**
- [ ] **Step 3: LIVE SMOKE, same day (critic risk 2):** `SHORTS_LLM=live uv run pytest tests/test_llm.py -m live` — one real Claude call with the Scout schema; assert parsed JSON carries a well-formed `evidence` array. Adjust schema NOW if the model fights it.
- [ ] **Step 4: Commit.**

### Task 11: Scout LLM pass

**Files:**
- Modify: `worker/src/shorts/agents/scout.py`
- Test: `worker/tests/test_scout_llm.py`, stubs in `worker/tests/llm_stubs/scout_*.json`

**Interfaces:**
- `scout.candidates(idx, log) -> list[Candidate]` — heuristic pass + (live mode only) LLM semantic pass over transcript chunks (hot takes, stories, punchlines, questions; prompt includes the claim-kind table); LLM candidates pass `validate_claims` before admission (violations → one re-ask → discard); union deduped IoU>0.5. Stub mode = heuristic only.

- [ ] **Step 1: failing tests with handcrafted stubs** — one valid stub admitted; one citing a nonexistent peak rejected after re-ask; dedupe merges overlapping heuristic+LLM candidates.
- [ ] **Step 2–4: implement, live smoke behind flag, commit.**

### Task 12: Critic + orchestrator round loop

**Files:**
- Create: `worker/src/shorts/agents/critic.py`, `worker/src/shorts/agents/orchestrator.py`
- Modify: `worker/src/shorts/pipeline.py` (renders survivors instead of raw candidates)
- Test: `worker/tests/test_critic.py`

**Interfaces:**
- `critic.score(cand, idx, log) -> Scored` — components `hook_strength|payoff|emotion|quotability`, each 0–25 with ≥1 valid cited Claim or the component is voided (score 0) and verdict re-asked once; total = sum; verdict: ≥70 keep, ≤45 kill, else borderline. Stub mode: deterministic score from evidence count `# ponytail: stub scoring = 15*len(evidence) capped 90`.
- `orchestrator.run_crew(idx, log) -> list[Scored]` — Scout → Critic; borderline → back to Scout with notes; **max 2 rounds via plain for-loop**; target 5–8 keepers (fewer is fine); every decision logged.

- [ ] **Step 1: failing tests (stubs):** round loop terminates at 2 with always-borderline stubs; component without valid claim → voided; kill threshold enforced.
- [ ] **Step 2–4: implement, wire pipeline, e2e still ≥2 clips in stub mode, commit.**

### Task 13: Surgeon

**Files:**
- Create: `worker/src/shorts/agents/surgeon.py`
- Modify: `worker/src/shorts/pipeline.py`
- Test: `worker/tests/test_surgeon.py`

**Interfaces:**
- `surgeon.refine(cand, idx, log) -> Cut` — deterministic: snap t0 to nearest preceding silence edge (≥0.3s) else word start; strip leading fillers; never open mid-word; t1 snaps to word end + ≤0.8s; payoff_word_i = last word before strongest evidence claim. LLM tie-break ONLY when two snap targets within 2s (stub mode: earlier target).

- [ ] **Step 1: failing property tests on fixture index:** every refined cut opens on word.t0 or silence edge; no word straddles either boundary; leading fillers absent.
- [ ] **Step 2–4: implement, observe QA WORD_CLIP failures drop to 0 in e2e, commit.**

### Task 14: Repair routing

**Files:**
- Modify: `worker/src/shorts/qa.py` (route_to: WORD_CLIP/ALIGN→surgeon, LUFS/RES/BLACK/FROZEN→render), `worker/src/shorts/pipeline.py`
- Test: `worker/tests/test_repair.py`

**Interfaces:**
- Pipeline: QA fail → route to stage → re-run from there → re-check; **max 2 repair loops** per clip, then drop with reason. All routed repairs logged via AgentLog.

- [ ] **Step 1: failing test:** inject a cut that clips a word → assert one surgeon re-run fixes it; force permanent LUFS failure (mock renderer) → assert 2 loops then drop.
- [ ] **Step 2–4: implement, commit.**

### Task 15: Hook Writer + overlay

**Files:**
- Modify: `worker/src/shorts/agents/hooks.py` (create), `worker/src/shorts/render/renderer.py`, `worker/src/shorts/qa.py` (+`SAFE_AREA` code)
- Test: `worker/tests/test_hooks.py`

**Interfaces:**
- `hooks.write(cut, idx, log) -> Hook` — LLM; constraints enforced in code: title ≤8 words (`len(title.split())`), banned-phrase frozenset, profanity frozenset, caption caps {tiktok:150, reels:125, shorts:100}; violation → one re-ask → deterministic fallback title = first 6 words of the cut's transcript. Stub mode: fallback path.
- Renderer: hook rendered top safe-area, first 3s (ASS second style layer, not drawtext — one subtitle pass).

- [ ] **Step 1: failing tests:** stub responses violating each constraint rejected; fallback fires; ASS output contains hook Dialogue with 3s end; QA flags a 60-char hook as SAFE_AREA.
- [ ] **Step 2–4: implement, commit.**

### Task 16: yt-dlp ingest + input caps

**Files:**
- Create: `worker/src/shorts/ingest.py`
- Modify: `worker/src/shorts/cli.py`, `worker/src/shorts/pipeline.py`
- Test: `worker/tests/test_ingest.py`

**Interfaces:**
- `ingest.resolve(source: str, workdir: Path) -> SourceMedia` — local path passthrough or yt-dlp (max 1080p mp4); extracts 16k mono wav; enforces caps (≤3h, ≤2GB) with `IngestError("TOO_LONG"|"TOO_BIG")`; yt-dlp failures mapped: `GEO_BLOCKED`, `AGE_GATED`, `UNAVAILABLE`, `NETWORK` — user-readable messages per spec §7.

- [ ] **Step 1: failing tests:** mocked yt-dlp process per error class asserts mapping; oversize local file (ffprobe mocked) → TOO_LONG. Live network smoke behind `SHORTS_LIVE=1`.
- [ ] **Step 2–4: implement, commit.**

### Task 17: Checkpoint/resume, style re-render, final run.json contract

**Files:**
- Modify: `worker/src/shorts/pipeline.py`, `worker/src/shorts/cli.py`
- Test: `worker/tests/test_resume.py`

**Interfaces:**
- Stage checkpoints in workdir: `signals.json`, `candidates.json`, `scored.json`, `cuts.json`, `clips/` — stage skipped iff its artifact exists and is schema-valid. This IS the Modal retry story (spec §7), proven locally.
- `shorts render --from <workdir> --style s2` — re-renders clips from persisted cuts + index without re-transcription (spec §5 style switch).
- Final `run.json`: per clip — cut, score total + components **with cited evidence (the "why this clip" data, spec §5/§6)**, hook, qa result, paths; drops with reasons; `totals`: duration processed, per-agent tokens, estimated cost cents (spec §11).

- [ ] **Step 1: failing tests:** kill-and-resume (delete `scored.json`+later, rerun, assert transcribe/signals skipped via mtime); `render --from` produces new style without touching `signals.json`; run.json schema asserts all fields above.
- [ ] **Step 2–4: implement, commit.**

### Task 18: Modal deployment

**Files:**
- Create: `worker/src/shorts/modal_app.py`
- Test: manual smoke (no CI)

**Interfaces:**
- Modal app: image = debian-slim + ffmpeg + fonts + pinned wheels + pre-downloaded model weights (spike learnings). Functions: `transcribe_align` (T4 GPU), `analyze` (CPU 4-core), `crew` (CPU), `render` (CPU 4-core) — each a thin call into existing pipeline functions with checkpoint workdir on a Modal Volume; retries ×2 backoff per stage; entrypoint `process(source_url_or_r2key) -> run.json`.
- Zero logic in this file beyond wiring. Nothing outside it imports modal.

- [ ] **Step 1: implement; deploy to Modal dev; full live run on real_podcast_2p.**
  Expected (spec §8): ≥3 clips pass QA; run.json cost totals < $0.60.
- [ ] **Step 2: Commit** — `feat(worker): modal deployment; pipeline live in cloud`

---

## Exit criteria for Plan 1

1. `uv run pytest` fully green in stub mode with zero API keys, on a clean clone.
2. Human-verified: live end-to-end on all 3 real fixtures produces watchable, correctly-captioned clips (critic risk 5 — this is a human gate, not a test).
3. Modal live run per T18. Then Plan 2 (web app) begins — it consumes `process()` + `run.json` as its contract.

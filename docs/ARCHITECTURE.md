# Peakcut Architecture

This document explains how Peakcut turns a long video into short, vertical,
caption-ready clips — and why the design is shaped the way it is. It's meant for
someone reading the codebase for the first time.

## The one-line thesis

> Don't guess which moments are good — **measure** every second, have an agent
> crew **debate** the candidates against those measurements, and ship each clip
> with the **evidence** behind why it was kept.

Everything below serves that thesis. The product's differentiator is that a clip
is never a black-box score: it comes with its receipts.

## Two halves

```
repo/
├── worker/     Python — the pipeline (signals, agent crew, render, publish). Runs locally or on Modal (GPU).
├── web/        TypeScript / Next.js 16 — landing, auth, dashboard, job submission, live view, admin, billing.
├── clients/    Java SDK + CLI for the API.
└── docs/       This file, plus DEPLOY.md.
```

The split is deliberate: the *work* is ML/media (Python's ecosystem), the
*product* is a web app (TypeScript end-to-end type safety across DB → server →
client). Neither language is doing the other's job.

---

## The worker pipeline

```
source ─▶ ingest ─▶ signals ─▶ crew ─▶ surgeon ─▶ render ─▶ QA ─▶ publish
         (yt-dlp)  (measure)  (score)  (cut)      (9:16)   (gate)  (metadata)
```

Each stage writes a **checkpoint** (`media.json` → `signals.json` → `scored.json`
→ `cuts.json` → `clip_NNN/` → `run.json`). Re-running against the same output dir
**resumes** — it skips any stage whose checkpoint already exists and still matches
the source. This is why re-styling captions or regenerating publish metadata
needs no re-transcription, and why a crashed run picks up where it left off.

### 1. Ingest (`shorts/ingest.py`)
A URL goes through `yt-dlp` (IPv4-pinned, with retries, to survive transient TLS
drops); a local file is passed straight through. Duration/size caps are enforced
*before* the download so an over-long source fails fast. Produces `media.json`.

### 2. Signals — measure, don't guess (`shorts/signals/`)
No LLM here. The source is decomposed into a second-by-second `SignalIndex`:
- **Transcript + forced alignment** — faster-whisper for words, torchaudio MMS_FA
  for per-word alignment error (`align_err_ms`, later used by the QA gate).
- **Audio energy & peaks** — librosa RMS + z-scored peak detection.
- **Laughter / applause** — PANNs (CNN14) audio event tagging.
- **Speech activity** — Silero VAD (silences, speech spans).
- **Scene cuts** — PySceneDetect.
- **Faces** — MediaPipe face detection (used historically for cropping; the
  reframe is now blurred-fit, so faces inform scoring, not the crop).

Everything is indexed so any later claim ("energy spike at 14.0s") can be
**resolved** against a real measurement.

### 3. The agent crew (`shorts/agents/`)
The heart of the system — a bounded Scout↔Critic debate, then deterministic
finishing agents.

- **Scout** proposes candidate windows — heuristic rules over the signals plus, in
  live mode, an LLM pass. Candidates carry cited evidence claims.
- **Critic** scores each candidate on four components (hook, payoff, emotion,
  quotability; 0–25 each → 0–100). **A component only counts if at least one of
  its evidence claims resolves against the `SignalIndex`** — unresolved claims get
  one re-ask, then are voided to zero. This is the evidence gate that keeps the
  crew honest.
- **Orchestrator** runs the debate up to `MAX_ROUNDS`; borderline candidates go
  back to Scout once. Candidates in a round are **scored in parallel**
  (`ThreadPoolExecutor`), since each Critic call is independent — the single
  biggest wall-clock win (≈21 min → ≈6 min on a 24-min video). `AgentLog` is
  lock-guarded so the concurrent audit writes never interleave.
- **Surgeon** (deterministic, no LLM) snaps each kept candidate onto clean
  boundaries: **sentence-aware** t0/t1 (open on a whole sentence, close once the
  payoff's sentence finishes, using the transcript's own punctuation), a 30–90s
  duration floor/ceiling, and leading-filler stripping.
- **Hook Writer** titles the clip (constraints — length, no clickbait, no
  profanity — enforced in code, not trusted to the model).

### 4. Render (`shorts/render/`)
`ffmpeg` cuts `[t0, t1)`, reframes 16:9 → 9:16 as a **blurred-background fit**
(the whole frame scaled to fit, centered, with a blurred zoom of the same frame
filling the margins — nothing cropped), burns in **karaoke captions** + the hook
title (ASS), and loudness-normalizes to −14 LUFS (two-pass `loudnorm`).

### 5. QA gate (`shorts/qa.py`)
A rendered clip must pass: caption alignment (`p95 align_err_ms`), safe-area title
length, no black/frozen frames, and loudness. Failures route to a **bounded
repair loop** (≤2 attempts) — WORD_CLIP/ALIGN go to the Surgeon for a
deterministic re-cut, render-caused issues to a re-render — or the clip is
dropped with a recorded reason.

### 6. Publish (`shorts/publish/`)
A **Copywriter** step generates a YouTube Shorts `publish.json` per kept clip
(title + `#Shorts`, description, hashtags, tags). The **uploader**
(`shorts publish-youtube`) does a resumable `videos.insert` via the YouTube Data
API v3 — Desktop OAuth with a cached token, unlisted by default, one token file
per channel so personal/burner channels are just a `--token` swap.

### Modes
`SHORTS_LLM=stub` (default) runs the entire pipeline with **zero network** — every
agent falls back to a deterministic, signal-only path. `SHORTS_LLM=live` uses the
real crew. This is what makes the test suite fast and hermetic.

---

## The web app (`web/`)

Next.js 16 App Router, TypeScript strict, Drizzle ORM over node-postgres (a
lazy `Pool` so `next build` never opens a socket), Auth.js v5 (Google + a dev
credentials provider), Tailwind with
shadcn/Base UI, Framer Motion.

- **Landing** — the "clip receipt" thesis, animated; a real clip loops in the hero
  under an analysis scan.
- **Job submission** (`/dashboard/new`) — paste a URL or drag-drop a file; wired to
  an atomic `createJob` that debits the minute balance and inserts the job **in one
  transaction** (no stranded charge on failure).
- **Live job view** (`/jobs/[id]`) — polls the status route and renders an animated
  pipeline: a self-correcting ETA, a stage rail with a flowing pulse, and the
  **real agent-event stream**.
- **Admin cockpit** (`/admin`) — owner-only, gated at the proxy, page, and data
  layers (a non-admin gets a 404, never a redirect that reveals the route).
- **Credits & billing** — minutes debited atomically; a webhook grants/settles.

### The worker seam (`web/lib/worker.ts`)
`createJob` hands off to a `Worker`. `LocalWorker` spawns the Python pipeline as a
detached subprocess and imports its `run.json` back into the DB; `StubWorker`
(CI/e2e) flips status without spawning anything. The web app never contains
pipeline logic — it orchestrates and presents.

---

## The Java SDK (`clients/java/`)

A Java 17 client for the same API: `PeakcutClient` (create/upload job, status),
`JobPoller` (backoff polling with a live callback), immutable model types carrying
the full clip evidence, a retrying transport on the JDK `HttpClient` (no
third-party HTTP dependency), and a fat-jar CLI. See `clients/java/README.md`.

---

## Why the shapes are the way they are

- **Checkpoints over a monolith** — media/ML work is expensive and flaky; resuming
  a stage beats redoing it.
- **Evidence gate over trust** — the product's whole promise is "no black box," so
  every LLM claim is validated against a measurement or voided.
- **Deterministic finishers** — cuts, hooks, and QA are code, not model calls, so
  their behavior is testable and reproducible.
- **Stub mode** — a full, network-free run keeps CI fast and makes the pipeline
  debuggable without an API key.

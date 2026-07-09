# Shorts Factory — Design Spec

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan
**Working name:** Shorts Factory (product name TBD, does not block build)

## 1. What this is

A self-serve web app: a user pastes a YouTube link or uploads a video → a
signal-driven, multi-agent pipeline finds the best moments → the app renders
vertical (9:16) clips with word-by-word animated captions, face-aware
cropping, on-screen hooks, and per-clip virality scores. Users review,
download, and pay via credits.

**North star:** full production quality (face tracking, b-roll, emphasis
effects, sound cues) — built in stages, each stage shippable and sellable.

**Differentiator:** competitors run one LLM prompt over a transcript. We run
measured signals (audio, vision, speech) through an agent crew whose every
decision must cite measurements and is verified by code, not by another
prompt. LLM is ~20% of the system; signal processing and verification is the
rest.

## 2. Users and money

- **Market:** global (USD) + India (INR/UPI) from day one.
- **Buyers:** creators, podcasters, coaches, agencies repurposing long video.
- **Billing:** one merchant-of-record integration (Dodo Payments preferred;
  Paddle fallback) — handles both currencies and global tax with one rail.
- **Model:** processing-minute credits. Free tier ~60 min on signup.
  Subscription tiers grant monthly minutes; credit top-ups for overflow.
- **Run budget during build:** $20–50/mo (Modal free credits + LLM API +
  R2/Neon free tiers keep dev inside this).

## 3. Architecture (two deployables)

```
┌───────────────────────────┐        ┌──────────────────────────────┐
│  Web app — Next.js/Vercel │        │  Worker — Python on Modal    │
│  landing · auth · upload  │──DB──▶│  ingest → signals → agents   │
│  dashboard · clip review  │◀─DB───│  → render → QA → upload      │
│  credits · billing        │        │                              │
└───────────────────────────┘        └──────────────────────────────┘
         │                                      │
       Neon Postgres (jobs, clips, credits, agent logs)
         │                                      │
       Cloudflare R2 (source videos, rendered clips, thumbnails)
```

- **Web app:** Next.js (App Router) on Vercel. Auth via Auth.js. Direct
  browser→R2 multipart uploads (presigned URLs; big files never touch
  Vercel). Dashboard polls job status from Postgres.
- **Worker:** Python on Modal. Each pipeline job is a Modal function chain.
  GPU (T4) for Whisper transcription; CPU for everything else. Scales to
  zero.
- **Job handoff:** web app inserts a `jobs` row + triggers Modal via its
  REST endpoint. Worker updates stage/progress columns as it runs; the
  dashboard live-renders the pipeline ("Scout found 17 → Critic kept 7 →
  rendering 4/7"). No message queue in v1 — Postgres is the queue.
  (`ponytail:` a jobs table polled by the dashboard replaces a queue system;
  add a real queue only if concurrent-user contention shows up.)

## 4. The pipeline

### Layer 1 — Signal extraction (deterministic, zero LLM)

Runs first on every video; writes a **signal index** (JSON per video in R2 +
summary rows in Postgres) that all agents query.

| Signal | Tool | Output |
|---|---|---|
| Transcript, word timestamps | faster-whisper (Modal GPU) | words with start/end/confidence |
| Forced alignment check | whisperX alignment | per-word timing ≤100ms error |
| Silence/speech map | Silero VAD | speech segments, silence gaps |
| Audio energy + spikes | librosa RMS curve | excitement peaks, flat zones |
| Laughter/applause | audio event classifier (PANNs CNN14, CPU) | events with timestamps |
| Speech rate / pitch dynamics | librosa + word timings | surges, monotone zones |
| Scene cuts | PySceneDetect | shot boundaries |
| Faces (position, count) | MediaPipe face detection, sampled frames | per-second face boxes |
| Motion intensity | OpenCV frame-diff | motion curve |
| Black/frozen frames | ffmpeg blackdetect/freezedetect | defect ranges |
| Filler words | transcript regex ("um", "uh", "like,") | filler map |

### Layer 2 — Agent crew (tool-using, measurement-bound)

Agents are Python functions that combine signal-index queries with LLM calls
(Claude API). **Hard rule enforced in code:** any LLM verdict must reference
signal evidence; verdicts contradicting the signals are rejected by the
orchestrator (plain Python, not another LLM).

- **Scout** — nominates 15–20 candidate moments. Method: query signal index
  for overlaps (energy spike + speech-rate surge, laughter following speech,
  scene-stable monologue with high pitch dynamics), then LLM pass over
  transcript for semantic hooks (hot takes, stories, punchlines, questions).
  Union of both lists, deduplicated.
- **Critic** — scores each candidate 0–100 on: hook strength (first 2s),
  self-contained payoff, emotional charge, quotability. Every score
  component must cite signal evidence (e.g., "energy spike +2.1σ at 00:14").
  Kills candidates under threshold; sends borderline ones back to Scout with
  notes. Max 2 Scout↔Critic rounds, then proceed with survivors (cost
  ceiling, no infinite debates). Target: 5–8 survivors.
- **Surgeon** — deterministic-first cut refinement: snap cut-in/out to
  Silero VAD silence boundaries, align to word timestamps, never open
  mid-word, trim leading filler words, land the out-cut ≤0.8s after payoff
  word. LLM consulted only when boundaries are ambiguous (e.g., which
  sentence starts the story).
- **Hook Writer** — LLM writes the on-screen hook title + platform captions
  (TikTok/Reels/Shorts variants) per clip. Code-enforced constraints: hook
  ≤8 words, no clickbait-banned phrases list, profanity filter, caption
  length limits per platform.
- **QA Gate** — pure code, zero LLM. Blocks render/publish on: caption/audio
  misalignment >100ms (forced alignment), loudness outside −14 LUFS ±1 (EBU
  R128), black/frozen frames in output, cut clipping a word, wrong
  resolution/fps/bitrate, hook text overflowing safe area. Failure routes
  back to the responsible stage; max 2 repair loops, then clip is dropped
  with reason logged.
- **Producer (v3 only)** — plans b-roll insertion points, emoji/keyword
  emphasis, sound-effect cues, using motion/scene/semantic signals.

Every agent decision (input evidence, output, verdict) is logged to an
`agent_events` table — powers debugging and a user-facing "why this clip"
panel.

### Layer 3 — Render factory (deterministic)

- ffmpeg: cut, 9:16 crop using Layer-1 face boxes (crop window centers on
  the dominant face; static per shot in v1, smooth tracking in v2).
- Captions: ASS subtitles, word-by-word karaoke highlight style, burned in.
  2–3 preset caption styles in v1.
- Hook title rendered in top safe-area for first 3s.
- Loudness normalized to −14 LUFS. Output: 1080×1920 H.264 + AAC.
- Thumbnail per clip (frame at hook moment).

## 5. Web app surface (v1)

- **Landing page** with demo video and pricing.
- **Auth:** email magic link + Google OAuth (Auth.js).
- **New job:** paste YouTube URL (yt-dlp on worker; known TOS gray zone,
  accepted risk) or upload file (≤2 GB, ≤3 h, browser→R2 presigned
  multipart).
- **Job view:** live pipeline progress with agent activity feed, then clip
  grid: player, virality score, hook, captions, "why this clip" evidence
  panel, download button, caption-style switcher (re-render on demand).
- **Credits & billing:** minutes balance, tier management, top-ups via MoR
  checkout + webhooks.
- **Settings:** profile, delete account (purges R2 objects + rows).

## 6. Data model (Postgres)

- `users` (auth, plan, minutes_balance)
- `jobs` (user_id, source_type, source_url/r2_key, status, stage, progress,
  error, duration_min, cost_cents)
- `clips` (job_id, t_start/t_end, score, hook, captions jsonb, r2_key,
  thumb_key, status)
- `agent_events` (job_id, clip_id nullable, agent, action, evidence jsonb,
  verdict, tokens, created_at)
- `credit_ledger` (user_id, delta_minutes, reason, ref)
- `payments` (user_id, mor_event_id, amount, currency, raw jsonb)

## 7. Failure handling

- Every worker stage is retryable (Modal retries ×2 with backoff); job lands
  in `failed` with a user-readable reason after final failure; credits for
  failed jobs auto-refund via `credit_ledger`.
- yt-dlp failures (region lock, age gate, removed video) surface as clear
  user errors, not generic failures.
- Partial success is success: if 6 of 8 clips pass QA, ship 6, log 2 drops.
- Webhook (billing) handlers are idempotent on `mor_event_id`.
- Stuck-job sweeper: jobs with no stage update for 30 min → failed + refund.

## 8. Testing strategy

- **Signal layer:** golden-file tests — 3 short fixture videos (talking
  head, podcast 2-person, screen-share) with known laughter/silence/faces;
  assert extraction within tolerances.
- **Agent crew:** unit-test the code gates (evidence-citation enforcement,
  round limits, QA thresholds) with stubbed LLM responses; one live
  smoke test per agent behind an env flag.
- **Render:** assert output specs (resolution, LUFS, duration, caption
  presence) via ffprobe on fixture renders.
- **Web app:** Playwright happy path — signup → paste URL (fixture) → see
  clips → download; webhook idempotency tests.
- **End-to-end:** one full pipeline run on a fixture video in CI (Modal dev
  environment), asserting ≥3 clips pass QA.

## 9. Build stages

- **v1 (this spec):** everything above — full agentic pipeline, static
  face-aware crop, karaoke captions, hooks, scores, accounts, credits, MoR
  billing, live agent feed.
- **v2:** smooth face tracking (crop follows speaker), active-speaker
  detection for multi-person video, Critic feedback loop (learns from which
  clips users download/post), caption style editor.
- **v3:** Producer agent — b-roll library insertion, emphasis
  effects/emojis, sound cues, auto-post to platforms (official APIs).

## 10. Non-goals (v1)

No teams/collaboration, no auto-posting, no dubbing/translation, no custom
fonts upload, no API for third parties, no mobile app, no A/B thumbnail
tools. YAGNI until users ask.

## 11. Cost model (per 30-min source video)

- Whisper on Modal T4: ~2–3 min GPU ≈ $0.03–0.05
- Signal extraction CPU: ≈ $0.02
- Agent crew LLM calls (Scout+Critic+Surgeon+Hook, 2 rounds max):
  ~$0.15–0.40
- Render 6 clips: ≈ $0.02
- **Total ≈ $0.25–0.50** → priced at ~30 credits-minutes; healthy margin at
  any tier priced ≥$10/100min.

## 12. Build process (meta)

Multi-agent adversarial build: two architect agents independently draft the
implementation plan structure → a critic agent attacks both → merged plan.
Implementer agents build web app and worker in parallel isolated worktrees;
reviewer agents that didn't write the code review each PR-sized chunk;
silent-failure hunter passes over error handling; Ponytail (full mode)
referees all code toward the minimum that works. Orchestrated from the main
session; user sees stage summaries.

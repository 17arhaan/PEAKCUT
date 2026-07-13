# Peakcut

**Long video in. Clips that prove themselves out.**

Peakcut turns a long video (a YouTube link or an upload) into short, vertical, caption-ready clips — and ships every clip with the **evidence behind why it was picked**. Instead of a black-box "AI score," an agent crew debates each moment against *measured* signals (audio energy, laughter, speech-rate, scene cuts, faces) and every claim it makes is validated against those measurements before a clip is kept.

> No guessing. Each clip comes with its receipts: the energy spike, the laugh, the quotable line, and the verdict.

---

## How it works

```
source ─▶ ingest ─▶ signals ─▶ agent crew ─▶ surgeon ─▶ render ─▶ QA ─▶ publish
         (yt-dlp)  (measure)   (score+debate) (cut)     (9:16)   (gate) (metadata)
```

1. **Ingest** — pull audio + video + a transcript from a URL or upload (with duration/size caps).
2. **Measure signals** — no LLM here: forced-aligned transcript (faster-whisper + torchaudio), audio energy & peaks (librosa), laughter/applause (PANNs), speech VAD (Silero), scene cuts (PySceneDetect), face tracks (MediaPipe). All indexed second-by-second.
3. **Agent crew** — **Scout** proposes candidate windows, **Critic** scores each on four components (0–100) with **every claim validated against the measured signals** (unresolved evidence is voided), borderline windows go back for one refinement round. Candidates are scored **in parallel**.
4. **Surgeon** — deterministically snaps each cut to **sentence boundaries** (open on a whole thought, close once the payoff finishes) with a 30–90s duration floor/ceiling.
5. **Render** — reframes 16:9 → 9:16 as a **blurred-background fit** (nothing cropped), burns in **karaoke captions** + a hook title, and loudness-normalizes to −14 LUFS.
6. **QA** — a final gate (caption alignment, safe-area, black/frozen frames, loudness); failures route to a bounded deterministic repair loop or drop.
7. **Publish** — a **Copywriter** step writes a YouTube Shorts `publish.json` per clip (title, description, hashtags, tags).

Every stage is **checkpointed** (`signals.json` → `scored.json` → `cuts.json` → clips), so a run resumes without redoing expensive work, and re-styling or re-publishing needs no re-transcription.

---

## Repo layout

```
worker/   Python pipeline — signal extraction, agent crew, render, publish. Runs locally or on Modal (GPU).
web/      Next.js 16 app — landing, auth, dashboard, link/upload job submission, live job view, owner admin cockpit.
docs/     Design + build notes — start with docs/ARCHITECTURE.md.
DEPLOY.md Go-live runbook (Vercel / Neon / R2 / Modal).
clients/  API clients — a Java 17 SDK + CLI (clients/java).
```

---

## Worker (Python)

Requires `ffmpeg` + `espeak-ng` on PATH and [`uv`](https://docs.astral.sh/uv/).

```bash
cd worker
uv sync
uv run shorts doctor                                   # check deps

# stub mode (no API key, deterministic non-LLM path):
uv run shorts run "https://youtu.be/…" -o out/

# live mode (real agent crew):
export SHORTS_LLM=live ANTHROPIC_API_KEY=sk-ant-…
uv run shorts run "https://youtu.be/…" -o out/

uv run shorts render --from out/ --style s2           # re-style, no re-crew
uv run shorts publish-metadata --from out/            # write YouTube publish.json per clip
```

**Key env:** `SHORTS_LLM` (`stub`|`live`), `SHORTS_LLM_MODEL` (default `claude-sonnet-5`), `ANTHROPIC_API_KEY`, `SHORTS_WHISPER_DEVICE` (`cpu`/`cuda`). GPU deployment runs on **Modal** (`modal_app.py`).

Tests: `uv run pytest` (stub/offline by default; `live`-marked tests need `SHORTS_LLM=live`).

---

## Web (Next.js)

```bash
cd web
npm install
docker compose up -d db          # local Postgres
cp .env.example .env.local       # set DATABASE_URL, AUTH_SECRET, AUTH_DEV=1, ADMIN_EMAILS
npm run dev                       # http://localhost:3000
```

Next.js 16 (App Router) · Drizzle ORM · Auth.js v5 (Google + dev credentials) · Tailwind + shadcn/Base UI · Framer Motion. Credits are debited atomically on job creation; the owner-only admin cockpit (`/admin`) is gated at the proxy, page, and data layers.

Checks: `npm run lint` · `npx tsc --noEmit` · `npx vitest run` · `npx playwright test`.

---

## Status

Local pipeline + web app are feature-complete and green in CI. Live agent crew produces evidence-backed clips end-to-end; YouTube publish-metadata generation is done, upload wiring and production deploy are next.

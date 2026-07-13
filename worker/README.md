# Peakcut worker

The Python pipeline: signal extraction → agent crew → sentence-aware cuts →
9:16 blurred-fit render with karaoke captions → QA gate → publish metadata /
YouTube upload. Architecture deep-dive: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## Setup

```bash
cd worker
uv sync                 # deps (Python 3.12, managed by uv)
uv run shorts doctor    # verifies heavy imports + ffmpeg/ffprobe/espeak-ng on PATH
```

System deps: `ffmpeg` (built with libass), `espeak-ng`. On Linux, MediaPipe
also needs GL libs (`libgl1 libglib2.0-0 libgles2 libegl1` — see `.github/workflows/ci.yml`).

## CLI

```bash
uv run shorts run <video-or-url> -o out/myrun     # full pipeline -> clips + run.json
uv run shorts render --from out/myrun --style s2  # restyle captions, no re-transcription/crew
uv run shorts publish-metadata --from out/myrun   # publish.json per kept clip (title/desc/hashtags)
uv run shorts publish-youtube --from out/myrun \
    --client-secret client_secret.json \
    [--token ~/.peakcut/other-channel.json] [--privacy unlisted] [--limit 1]
```

Every stage checkpoints into the output dir (`media.json` → `signals.json` →
`scored.json` → `cuts.json` → `clip_NNN/` → `run.json`); re-running against the
same `-o` resumes instead of redoing work.

## Environment

| Var | Default | What it does |
|-----|---------|--------------|
| `SHORTS_LLM` | `stub` | `live` = real agent crew (needs `ANTHROPIC_API_KEY`); anything else stays on the deterministic no-network path. Fails closed. |
| `SHORTS_LLM_MODEL_<AGENT>` | — | Per-agent model override, e.g. `SHORTS_LLM_MODEL_CRITIC`. |
| `SHORTS_LLM_MODEL` | — | Global model override for every agent. |
| *(per-agent defaults)* | | Critic: `claude-haiku-4-5` (volume caller, kept honest by the evidence gate). Scout / Hook Writer / Copywriter: `claude-sonnet-5`. |
| `SHORTS_WHISPER_MODEL` | `small` | faster-whisper size; CI/tests use `tiny`. |
| `SHORTS_WHISPER_DEVICE` | auto | Force `cpu`/`cuda` for transcription. |

## Tests

```bash
uv run pytest tests/ -q                       # full suite (~16 min: real renders + models)
uv run pytest tests/ -q \
  --ignore=tests/test_resume.py --ignore=tests/test_repair.py \
  --ignore=tests/test_e2e.py --ignore=tests/test_pipeline.py   # fast suite (~2 min)
```

CI runs the fast suite on every push and the heavy integration suite nightly
(`workflow_dispatch` to run it on demand). Everything runs in stub mode — no
API keys, no network.

## Modal

```bash
modal deploy src/shorts/modal_app.py           # deploy the pipeline (app: shorts-factory)
modal run src/shorts/modal_app.py --source …   # one-off remote run
```

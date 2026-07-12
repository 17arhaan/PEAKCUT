"""T18: Modal deployment. The ONLY file in this package that imports `modal`
-- everything else in `shorts` stays a plain, Modal-agnostic library that
also runs locally via `shorts run`.

SIMPLIFICATION vs the plan's 4-function split (transcribe_align / analyze /
crew / render, each independently retryable/scalable): this is ONE function,
`process()`, that calls the existing `pipeline.run()` end-to-end against a
workdir on a Modal Volume, with a T4 GPU attached for the whisper
transcription step inside it.
# ponytail: single function, not 4. pipeline.run() is ALREADY one
# checkpointed sequence (media -> signals -> crew -> cuts/render/qa,
# T17) with its own resumability -- splitting it into 4 separate Modal
# functions would mean either (a) re-deriving each stage's boundary as a
# Modal call (duplicate wiring pipeline.py already owns) or (b) shipping
# the whole SignalIndex/AgentLog/checkpoint state between functions by
# hand. Neither adds real independent-retry value here: a crash anywhere
# in process() just re-invokes process() against the SAME workdir, and
# pipeline.run()'s own checkpoint files (media.json/signals.json/
# scored.json/cuts.json) skip every already-done stage on the retry --
# that IS the per-stage retry story, for free. Upgrade path: split into
# per-stage Modal functions when a stage needs independent horizontal
# scaling (e.g. rendering N clips in parallel across containers) --
# nothing here blocks that later.

IMAGE RECIPE: verbatim from the T9 spike (worker/scripts/modal_spike.py) for
the CUDA/cuDNN part -- debian_slim + apt ffmpeg + pip-installed
nvidia-cublas-cu12/nvidia-cudnn-cu12 wheels + LD_LIBRARY_PATH pointing at
their lib/ dirs (NOT an nvidia/cuda devel base image; ctranslate2 only needs
the runtime .so files). Whisper weights cached on the SAME Modal Volume
(`shorts-whisper-cache`, HF_HOME=/cache) the spike proved. The rest of the
worker's deps (torch/torchaudio, mediapipe, panns-inference, librosa,
scenedetect, opencv-contrib-python, yt-dlp, anthropic) are installed from
`requirements-modal.txt` -- a frozen export of the SAME uv.lock the local
dev environment resolves against (`uv export --no-hashes --no-dev
--no-emit-project --no-emit-package modal --no-emit-package pytest`), so
this image installs the exact versions T1's one resolver fight already
proved compatible, INCLUDING the opencv-python/opencv-contrib-python
override (see pyproject.toml's `[tool.uv] override-dependencies` comment).
DISCOVERED DURING T18: `uv export`'s marker-poisoning trick
(`sys_platform == 'never_actually_matches'`) only suppresses the TOP-LEVEL
opencv-python requirement in the exported file -- it can't rewrite
scenedetect's OWN published metadata, so a plain `pip install -r
requirements-modal.txt` still independently resolves scenedetect's
undeclared `opencv-python` dependency and installs both `cv2`-providing
distributions side by side (confirmed: this silently clobbered
opencv-contrib-python's files the first time this image was built). Fix:
requirements-modal.txt is generated with BOTH `scenedetect` and
`opencv-python` excluded (`--no-emit-package scenedetect --no-emit-package
opencv-python`), and scenedetect is pip-installed separately below with
`--no-deps` (its only other deps -- click/numpy/platformdirs/tqdm -- are
already pulled in by other packages in requirements-modal.txt; verified
via `importlib.metadata.distribution("scenedetect").requires`). Regenerate
requirements-modal.txt with the command above (plus the two
--no-emit-package flags) whenever pyproject.toml's dependencies change.

opencv-contrib-python is a GUI build (unlike opencv-python-headless) and
needs `libgl1`/`libglib2.0-0` present in the container -- apt-installed
below, per that same pyproject.toml comment.

WEIGHT CACHING: only the whisper model is volume-cached (proven by the
spike). The PANNs checkpoint (panns_inference downloads
~/panns_data/Cnn14_DecisionLevelMax.pth via a bare `wget` call on first use
-- hence `wget` is apt-installed below) and the MMS_FA forced-alignment
weights (torchaudio's own hub cache) are NOT volume-cached here -- they
re-download on every cold container start (~1min of one-time network I/O,
non-fatal, no correctness impact for a smoke run).
# ponytail: no volume cache for PANNs/MMS_FA weights. Upgrade path if this
# app gets called often enough for the redundant downloads to matter: mount
# a second Volume and point HOME (or panns_inference's `checkpoint_path=`
# arg directly, and TORCH_HOME for torchaudio) at it, same pattern as
# HF_HOME/shorts-whisper-cache below.

CREW MODE: SHORTS_LLM defaults to "stub" (agents/llm.py's own default) --
this deployment does NOT attach an ANTHROPIC_API_KEY secret, so the crew
runs the heuristic/deterministic stub path everywhere. To run the LIVE
crew: `modal secret create anthropic-api-key ANTHROPIC_API_KEY=sk-...`,
then add `secrets=[modal.Secret.from_name("anthropic-api-key")]` to the
`@app.function(...)` decorator below and pass `llm="live"` to `process()`.
Not wired further than that here -- YAGNI until the key exists (this
workspace has zero Modal Secrets as of T18; `modal secret list` confirms).
"""

import json
from pathlib import Path

import modal

# worker/ (src/shorts/../..) -- this module gets re-imported inside the
# remote container too (Modal hydrates the function by importing the same
# file), where it lives flat at /root/modal_app.py with only 2 parents, not
# 3 -- DISCOVERED DURING T18 (a bare `.parents[2]` IndexErrors there). The
# fallback value is never actually read remotely (the local dirs this feeds
# into add_local_dir/pip_install_from_requirements below were already
# resolved into the image during the LOCAL build pass; the container only
# needs the module to import without crashing to hydrate `process`).
_THIS_FILE = Path(__file__).resolve()
WORKER_DIR = _THIS_FILE.parents[2] if len(_THIS_FILE.parents) > 2 else _THIS_FILE.parent

CACHE_DIR = "/cache"  # whisper weights (HF_HOME) -- T9 spike's proven volume
DATA_DIR = "/data"  # pipeline checkpoint workdirs (media/signals/scored/cuts/clips)

app = modal.App("shorts-factory")

whisper_cache = modal.Volume.from_name("shorts-whisper-cache", create_if_missing=True)
pipeline_data = modal.Volume.from_name("shorts-pipeline-data", create_if_missing=True)

# ponytail: pip-installed cuDNN/cuBLAS wheels + LD_LIBRARY_PATH, not an
# nvidia/cuda devel base image -- see T9 spike (scripts/modal_spike.py) for
# why (ctranslate2 needs only the runtime .so files, no compiler).
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "ffmpeg", "wget", "libgl1", "libglib2.0-0",
        # mediapipe's face detector dlopens libGLESv2.so.2 + libEGL.so.1 at
        # runtime; libgl1 alone does NOT provide them on debian-slim.
        "libgles2", "libegl1",
    )
    .pip_install_from_requirements(str(WORKER_DIR / "requirements-modal.txt"))
    # scenedetect installed separately, --no-deps: it hard-declares
    # "opencv-python" (undeclared in requirements-modal.txt, which excludes
    # both scenedetect and opencv-python -- see module docstring). Its other
    # 4 real deps (click/numpy/platformdirs/tqdm) are already satisfied by
    # the main install above.
    .pip_install("scenedetect==0.7", extra_options="--no-deps")
    .pip_install("nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*")
    .env(
        {
            "LD_LIBRARY_PATH": (
                "/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:"
                "/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib"
            ),
            "HF_HOME": CACHE_DIR,
            "PYTHONPATH": "/app/src",
            "SHORTS_WHISPER_DEVICE": "cuda",
        }
    )
    # Local source last in the chain (Modal convention: these layers can't
    # be built on top of, so nothing should follow them). Mirrors the repo's
    # own worker/{src,fonts,models} layout exactly -- video.py and
    # renderer.py locate fonts/models via `Path(__file__).parents[3]`
    # relative to their own file, so /app/src/shorts/... + /app/fonts +
    # /app/models must line up the same way /app does locally as `worker/`.
    .add_local_dir(str(WORKER_DIR / "src"), remote_path="/app/src", ignore=["__pycache__", "*.pyc"])
    .add_local_dir(str(WORKER_DIR / "fonts"), remote_path="/app/fonts")
    .add_local_dir(str(WORKER_DIR / "models"), remote_path="/app/models")
)


@app.function(
    image=image,
    gpu="T4",
    volumes={CACHE_DIR: whisper_cache, DATA_DIR: pipeline_data},
    timeout=1800,
    retries=modal.Retries(max_retries=2, backoff_coefficient=2.0, initial_delay=5.0),
)
def process(run_id: str, source: str, video_bytes: bytes | None = None) -> dict:
    """Thin wiring only: resolve the workdir on the shared Volume, write an
    uploaded local file into it if given (`video_bytes`; a URL `source`
    needs no upload -- ingest.resolve() yt-dlps it straight into the
    container), then call the EXISTING pipeline.run() unchanged. Every
    retry (Modal's `retries=` above, or a manual re-invoke) re-runs against
    the SAME `run_id` workdir, so pipeline.py's own checkpoints (media/
    signals/scored/cuts.json) skip whatever already completed -- see module
    docstring."""
    from shorts.pipeline import run as run_pipeline

    workdir = Path(DATA_DIR) / run_id
    workdir.mkdir(parents=True, exist_ok=True)

    if video_bytes is not None:
        local_path = workdir / "input.mp4"
        if not local_path.exists():
            local_path.write_bytes(video_bytes)
        source = str(local_path)

    run_pipeline(source, workdir)
    whisper_cache.commit()  # persist any freshly-downloaded whisper weights
    pipeline_data.commit()  # persist checkpoints + rendered clips

    return json.loads((workdir / "run.json").read_text())


@app.local_entrypoint()
def main(source: str = "tests/fixtures/real_podcast_2p.mp4", run_id: str = "smoke"):
    """`cd worker && uv run modal run src/shorts/modal_app.py [--source ...] [--run-id ...]`.
    Local paths are read here and uploaded as bytes; anything that parses as
    a URL is passed straight through for the remote container's yt-dlp to
    fetch (no local upload)."""
    from urllib.parse import urlparse

    local = Path(source)
    is_url = urlparse(source).scheme in ("http", "https")
    video_bytes = local.read_bytes() if not is_url and local.exists() else None

    run_json = process.remote(run_id, source, video_bytes)

    clips = run_json.get("clips", [])
    kept = [c for c in clips if c.get("dropped_reason") is None]
    print(f"run.json: {len(clips)} clip(s) attempted, {len(kept)} kept")
    for c in clips:
        status = "DROPPED: " + c["dropped_reason"] if c.get("dropped_reason") else "kept"
        print(f"  clip {c['index']}: {c['cut']['t0']:.1f}-{c['cut']['t1']:.1f}s [{status}]")
    print(f"agent totals: {run_json.get('agent_totals')}")
    print(f"timings: {run_json.get('timings_s')}")
    assert len(clips) >= 1, "expected the pipeline to produce at least one clip attempt"
    print("OK: Modal pipeline run produced a valid run.json")

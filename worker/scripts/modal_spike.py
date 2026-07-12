"""Task 9: Modal hello-whisper spike.

De-risking spike for T18 (real Modal deployment). Proves a Modal T4-GPU
function can run faster-whisper (CTranslate2 backend) on GPU and records the
operational quirks T18 needs, so we do not rediscover them under deadline
pressure.

DISCOVERIES (for T18)
======================================================================
1. Image build time (cold, MEASURED): 3 layers built sequentially --
   apt-get ffmpeg layer 32.6s, pip-install (faster-whisper + nvidia cudnn/
   cublas wheels) layer 35.8s, env-var layer 2.8s = ~71s total cold build.
   This is a *small* image relative to most GPU specs in this repo (torch+
   torchaudio alone is ~2-3 min to build/pull on Modal; we didn't need
   torch here since ctranslate2 doesn't depend on it). Re-running with an
   unchanged image definition hits Modal's image layer cache and skips
   straight to "Created objects" in a couple seconds.

2. CUDA/cuDNN recipe that worked (the gold nugget for T18):
   faster-whisper's GPU path goes through ctranslate2, which -- unlike
   torch -- does NOT bundle CUDA/cuDNN inside its wheel. It dynamically
   links against libcublas/libcudnn at import time. Modal GPU containers
   already have the NVIDIA driver + CUDA runtime, but NOT cuDNN by default.
   Two options exist; we used the lighter one:
     (a) [USED] `debian_slim` base + pip-install the official NVIDIA cuDNN/
         cuBLAS wheels (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12==9.*`) and
         point `LD_LIBRARY_PATH` at their site-packages `lib/` dirs. This is
         exactly what the faster-whisper README recommends for pip-only
         installs (no docker/apt cuDNN needed). Image stays small (no CUDA
         devel toolkit, ~1-2GB vs 6GB+ for an nvidia/cuda devel base).
     (b) [NOT USED] `modal.Image.from_registry("nvidia/cuda:12.3.2-cudnn9-
         runtime-ubuntu22.04", add_python="3.12")` -- Modal's own docs
         recommend this for "complex" CUDA setups (things needing nvcc /
         the full toolkit). Overkill for ctranslate2, which only needs the
         runtime .so files, not a compiler -- so (a) is the right call for
         T18's whisper step specifically. Worth revisiting (b) only if a
         future GPU step (e.g. custom CUDA kernels) needs nvcc.
   Without the LD_LIBRARY_PATH env line, ctranslate2 raises
   `Could not locate cudnn_ops64_9.dll`-equivalent
   (`libcudnn_ops.so.9: cannot open shared object file`) at model load —
   this is the exact failure T18 will hit if this env var is dropped.

3. Model weights: faster-whisper auto-downloads CTranslate2-converted
   weights from the HF Hub into `~/.cache/huggingface` on first use of
   `WhisperModel(...)`. We mounted a Modal Volume at that cache path
   (`shorts-whisper-cache`) rather than baking weights into the image --
   this is Modal's documented recommendation (Volumes are preferred over
   baking into images: "weights don't need to be re-downloaded every time
   the image definition changes"; performance is comparable). Tradeoff:
   first invocation after a fresh Volume pays a ~5-10s HF download for the
   `small` model (~500MB); every invocation after that reads from the
   Volume and skips the download entirely. Baking into the image was
   considered and rejected: any unrelated image-definition tweak (e.g.
   bumping ffmpeg) would force a full weight re-download during the build,
   which is exactly the failure mode Modal's own docs warn about.

4. Cold start (container spin-up on a fresh/idle app, after the image is
   already built): ~15-20s to get a GPU container scheduled + Python
   interpreter + CUDA context up, before `@modal.enter()` even starts
   loading the model. Model load itself (from the warm Volume) adds a
   few more seconds. Total cold "first request" latency budget: expect
   ~25-35s beyond the transcription time itself. Warm containers (Modal
   keeps them alive briefly / `min_containers` can pin them) skip all of
   this.

5. GPU cost extrapolation: T4 on Modal is billed ~$0.000164/s (~$0.59/hr)
   as of writing. faster-whisper `small` on GPU transcribes real-time audio
   at roughly 15-20x real-time on a T4 (extrapolated from this spike's
   60s-clip wall time below). A 30-minute (1800s) video -> ~90-120s of GPU
   transcription time -> roughly $0.015-0.02 of GPU compute per video for
   the transcription step alone. Negligible next to LLM/API costs; not a
   reason to shop for a cheaper GPU tier.

MEASURED RESULT (this spike run, T4 GPU, model="small", 60s of
tests/fixtures/real_podcast_2p.mp4):
    word_count:  143   (bar was >100 -- passed)
    wall_time_s: 2.41  (bar was <180 -- passed by a wide margin; the
                        `small` model on a T4 is nowhere near the 3-min
                        budget, there's headroom to move up to `medium`
                        or `large-v3` for T18 if quality needs it)
    cold image build (sum of 3 layers): ~71s (see discovery #1)
======================================================================
"""

import subprocess
import time
from pathlib import Path

import modal

MODEL_NAME = "small"
CACHE_DIR = "/cache"
TRANSCRIBE_SECONDS = 60

app = modal.App("shorts-modal-spike")

volume = modal.Volume.from_name("shorts-whisper-cache", create_if_missing=True)

# ponytail: pip-installed cuDNN/cuBLAS wheels + LD_LIBRARY_PATH, not an
# nvidia/cuda devel base image -- ctranslate2 only needs the runtime .so
# files, no compiler. See discovery #2 above if this needs to change for T18.
image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install(
        "faster-whisper>=1.2.1",
        "nvidia-cublas-cu12",
        "nvidia-cudnn-cu12==9.*",
    )
    .env(
        {
            "LD_LIBRARY_PATH": (
                "/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:"
                "/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib"
            ),
            "HF_HOME": CACHE_DIR,
        }
    )
)


@app.function(
    image=image,
    gpu="T4",
    volumes={CACHE_DIR: volume},
    timeout=600,
)
def transcribe(video_bytes: bytes) -> dict:
    import tempfile

    from faster_whisper import WhisperModel

    with tempfile.TemporaryDirectory() as tmp:
        video_path = Path(tmp) / "in.mp4"
        audio_path = Path(tmp) / "clip.wav"
        video_path.write_bytes(video_bytes)

        # Extract + trim to TRANSCRIBE_SECONDS, downmix to 16kHz mono --
        # what faster-whisper wants anyway, and trimming here (rather than
        # handing faster-whisper the whole file) keeps GPU time bounded.
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(video_path),
                "-t", str(TRANSCRIBE_SECONDS),
                "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                str(audio_path),
            ],
            check=True,
            capture_output=True,
        )

        model = WhisperModel(
            MODEL_NAME, device="cuda", compute_type="float16", download_root=CACHE_DIR
        )
        volume.commit()  # persist any freshly-downloaded weights for next run

        start = time.monotonic()
        segments, _info = model.transcribe(str(audio_path), beam_size=5)
        text = " ".join(seg.text.strip() for seg in segments)
        wall_time_s = time.monotonic() - start

    words = text.split()
    return {
        "word_count": len(words),
        "wall_time_s": round(wall_time_s, 2),
        "sample_text": " ".join(words[:40]),
    }


@app.local_entrypoint()
def main(video_path: str = "tests/fixtures/real_podcast_2p.mp4"):
    data = Path(video_path).read_bytes()
    result = transcribe.remote(data)
    print(f"word_count:   {result['word_count']}")
    print(f"wall_time_s:  {result['wall_time_s']}")
    print(f"sample_text:  {result['sample_text']}")
    assert result["word_count"] > 100, "expected >100 words in 60s of real podcast audio"
    assert result["wall_time_s"] < 180, "transcription wall time should be < 3 min"
    print("OK: spike checks passed")

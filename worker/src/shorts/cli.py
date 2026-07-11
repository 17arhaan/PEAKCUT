"""`shorts` CLI entrypoint. Argparse only -- no config framework."""

import argparse
import importlib
import importlib.metadata
import shutil
import subprocess
import sys
from pathlib import Path

# Every heavy dependency added in T1's resolver fight. `doctor` imports each
# one to prove the environment (venv or Modal image) actually has a working
# install, not just a resolved lockfile.
HEAVY_MODULES = [
    "faster_whisper",
    "torch",
    "torchaudio",
    "silero_vad",
    "librosa",
    "panns_inference",
    "scenedetect",
    "mediapipe",
    "cv2",  # opencv-contrib-python; see pyproject.toml override-dependencies comment
    "yt_dlp",
    "anthropic",
    "modal",
    "pytest",
]

# binary -> flag that prints its version string
REQUIRED_BINARIES = {
    "ffmpeg": "-version",
    "ffprobe": "-version",
    "espeak-ng": "--version",
}


def _binary_version(binary: str, flag: str) -> str:
    proc = subprocess.run([binary, flag], capture_output=True, text=True, check=False)
    output = proc.stdout or proc.stderr
    return output.splitlines()[0] if output else "(no output)"


def doctor() -> int:
    """Import every heavy module and check ffmpeg/ffprobe/espeak-ng on PATH.
    Prints one line per check; returns 0 if everything is present, else 1."""
    ok = True

    for name in HEAVY_MODULES:
        try:
            mod = importlib.import_module(name)
        except Exception as exc:
            ok = False
            print(f"[FAIL] {name}: {exc!r}")
        else:
            version = getattr(mod, "__version__", None)
            if version is None:
                try:
                    version = importlib.metadata.version(name.replace("_", "-"))
                except importlib.metadata.PackageNotFoundError:
                    version = "?"
            print(f"[ok]   {name} {version}")

    for binary, flag in REQUIRED_BINARIES.items():
        path = shutil.which(binary)
        if path is None:
            ok = False
            print(f"[FAIL] {binary}: not found on PATH")
            continue
        print(f"[ok]   {binary} ({path}) {_binary_version(binary, flag)}")

    return 0 if ok else 1


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="shorts")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser(
        "doctor",
        help="import all heavy deps and check ffmpeg/ffprobe/espeak-ng on PATH",
    )

    run_parser = subparsers.add_parser(
        "run", help="run the pipeline on a video, writing clips to -o/--out"
    )
    run_parser.add_argument("source", help="path to the source video, or a video URL")
    run_parser.add_argument("-o", "--out", required=True, help="output directory")

    args = parser.parse_args(argv)

    if args.command == "doctor":
        sys.exit(doctor())
    elif args.command == "run":
        from shorts.pipeline import run as run_pipeline

        # args.source is passed through as a string, NOT wrapped in Path() --
        # Path() collapses a URL's "://" down to ":/" (single slash), which
        # breaks it. ingest.resolve() branches on local-path-vs-URL itself.
        results = run_pipeline(args.source, Path(args.out))
        print(f"wrote {len(results)} clip(s) to {args.out}")
        sys.exit(0)


if __name__ == "__main__":
    main()

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

    render_parser = subparsers.add_parser(
        "render",
        help="re-render a prior run's clips with a different caption style, no re-transcription/crew",
    )
    render_parser.add_argument(
        "--from", dest="workdir", required=True, help="a prior `shorts run`'s output directory"
    )
    render_parser.add_argument("--style", required=True, help="caption style to render with")

    meta_parser = subparsers.add_parser(
        "publish-metadata",
        help="write YouTube Shorts publish.json (title/description/hashtags/tags) for each kept clip",
    )
    meta_parser.add_argument(
        "--from", dest="workdir", required=True, help="a prior `shorts run`'s output directory"
    )

    yt_parser = subparsers.add_parser(
        "publish-youtube",
        help="upload each kept clip to YouTube Shorts (videos.insert; unlisted by default)",
    )
    yt_parser.add_argument(
        "--from", dest="workdir", required=True, help="a prior `shorts run`'s output directory"
    )
    yt_parser.add_argument(
        "--client-secret", required=True, help="path to the Desktop OAuth client_secret.json"
    )
    yt_parser.add_argument(
        "--token", default=None, help="OAuth token cache path (default ~/.peakcut/yt-token.json)"
    )
    yt_parser.add_argument(
        "--privacy", choices=["private", "unlisted", "public"], default=None,
        help="privacy for the uploads (default: unlisted)",
    )
    yt_parser.add_argument("--limit", type=int, default=None, help="upload at most N clips")

    export_parser = subparsers.add_parser(
        "export",
        help="copy kept clips into studio/gallery as <date>_<name>/NN_Hook_Title.mp4",
    )
    export_parser.add_argument(
        "--from", dest="workdir", required=True, help="a prior `shorts run`'s output directory"
    )
    export_parser.add_argument(
        "--name", required=True, help="gallery folder slug, e.g. the-office-pranks"
    )
    export_parser.add_argument(
        "--dest", default=None, help="gallery root (default: <repo>/studio/gallery)"
    )

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
    elif args.command == "render":
        from shorts.pipeline import render_style

        results = render_style(Path(args.workdir), args.style)
        print(f"wrote {len(results)} clip(s) styled {args.style!r} to {args.workdir}")
        sys.exit(0)
    elif args.command == "publish-metadata":
        from shorts.publish.generate import generate_youtube_metadata

        written = generate_youtube_metadata(Path(args.workdir))
        print(f"wrote {len(written)} publish.json file(s) under {args.workdir}")
        sys.exit(0)
    elif args.command == "publish-youtube":
        from shorts.publish.youtube import DEFAULT_TOKEN, publish_workdir_to_youtube

        token = Path(args.token) if args.token else DEFAULT_TOKEN
        results = publish_workdir_to_youtube(
            Path(args.workdir), Path(args.client_secret),
            token=token, privacy=args.privacy, limit=args.limit,
        )
        for title, video_id in results:
            print(f"uploaded {title!r} -> https://youtu.be/{video_id}")
        print(f"{len(results)} clip(s) uploaded")
        sys.exit(0)
    elif args.command == "export":
        from shorts.export import DEFAULT_GALLERY, export_run

        dest = Path(args.dest) if args.dest else DEFAULT_GALLERY
        export_run(Path(args.workdir), args.name, dest)
        sys.exit(0)


if __name__ == "__main__":
    main()

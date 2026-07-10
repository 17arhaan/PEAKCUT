#!/usr/bin/env python3
"""Fixture factory: builds every file under tests/fixtures/ + MANIFEST.json.

Run ONCE by the implementer; the outputs are committed to git. CI never runs
this script -- it downloads real clips and shells out to espeak-ng.

Requires on PATH: ffmpeg/ffprobe (static build with libass), espeak-ng.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from shorts.ffmpeg import probe, run

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
ASSETS = ROOT / "tests" / "assets"
FIXTURES.mkdir(parents=True, exist_ok=True)
ASSETS.mkdir(parents=True, exist_ok=True)

SR = 44100
VIDEO_W, VIDEO_H, FPS = 480, 270, 25

# Public-domain laughter burst (CC0-equivalent): released into the public
# domain by its author "ezwa" via pdsounds.org, redistributed on Commons.
# https://commons.wikimedia.org/wiki/File:Laughter.ogg
LAUGHTER_URL = "https://upload.wikimedia.org/wikipedia/commons/c/c6/Laughter.ogg"
LAUGHTER_LICENSE = "Public domain (pdsounds.org, dedicated by author ezwa)"

# (start_s, end_s, text) -- four speech chunks separated by the deliberate
# silence/laughter/tone events. Durations are targets; each chunk's espeak-ng
# output is time-stretched with atempo to hit its window exactly so the
# inserted-event timestamps below never drift.
SPEECH_CHUNKS = [
    (0.0, 30.0,
     "This is segment one of the synthetic audio and video fixture built "
     "for the shorts factory worker pipeline test suite. Continuous speech "
     "plays here to give the voice activity detector and the word aligner "
     "a long clean stretch of real English audio before the first "
     "deliberate quiet gap arrives a few seconds from now."),
    (32.0, 45.0,
     "Segment two begins right after a two second silence and keeps "
     "talking until an audience laughs on the recording just ahead."),
    (47.0, 60.0,
     "Segment three follows the laughter and runs until a loud test tone "
     "interrupts the speech to mark an energy peak."),
    (62.0, 90.0,
     "Segment four is the final and longest stretch of speech in the "
     "fixture, running all the way to the end of the ninety second clip. "
     "It exists to make sure signal extraction keeps working correctly "
     "across a long uninterrupted section of dialogue near the tail of "
     "the file."),
]

SILENCE_GAP = (30.0, 32.0)
LAUGHTER_BURST = (45.0, 47.0)
SINE_BURST = (60.0, 62.0)
SINE_FREQ_HZ = 880
SINE_GAIN_OVER_BASE_DB = 12.0
COLOR_CUTS_S = [20.0, 40.0, 70.0]
BLACK_SEGMENT = (75.0, 76.0)
VIDEO_SEGMENTS = [
    # (duration_s, hue_deg, black_window_relative_to_segment_start)
    (20.0, 0, None),
    (20.0, 120, None),
    (30.0, 240, None),
    (20.0, 60, (5.0, 6.0)),  # absolute 75.0-76.0
]

# Real clips: CC-BY-licensed, downloaded directly from Wikimedia Commons
# (license text verified on each file page -- see MANIFEST.json for the
# exact URL + license recorded per clip).
REAL_CLIPS = {
    "real_talking_head.mp4": dict(
        src_url="https://upload.wikimedia.org/wikipedia/commons/0/0a/Ronald_Wright%2C_The_Green_Interview.webm",
        page_url="https://commons.wikimedia.org/wiki/File:Ronald_Wright,_The_Green_Interview.webm",
        license="CC BY 3.0 Unported",
        ss=20.0, t=75.0,
    ),
    "real_podcast_2p.mp4": dict(
        src_url="https://upload.wikimedia.org/wikipedia/commons/f/f6/Interview_with_Jimmy_Wales_at_Wikimania_2025_Nairobi.webm",
        page_url="https://commons.wikimedia.org/wiki/File:Interview_with_Jimmy_Wales_at_Wikimania_2025_Nairobi.webm",
        license="CC BY 4.0",
        ss=155.0, t=75.0,
    ),
    "real_screenshare.mp4": dict(
        src_url="https://upload.wikimedia.org/wikipedia/commons/a/a5/Screencast_demo_of_Camstudio_and_Firefogg.ogv",
        page_url="https://commons.wikimedia.org/wiki/File:Screencast_demo_of_Camstudio_and_Firefogg.ogv",
        license="CC BY 3.0 Unported",
        ss=20.0, t=75.0,
    ),
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _duration_s(path: Path) -> float:
    """ffprobe duration for any media file, audio-only included.

    shorts.ffmpeg.probe() requires a video stream, so it can't be reused for
    the audio-only wav files built along the way here.
    """
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, check=True, text=True,
    )
    return float(proc.stdout.strip())


def _mean_volume_db(path: Path) -> float:
    """RMS level (dB) of an audio file via ffmpeg's volumedetect filter."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "info", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, check=True, text=True,
    )
    for line in proc.stderr.splitlines():
        if "mean_volume:" in line:
            return float(line.split("mean_volume:")[1].split("dB")[0].strip())
    raise RuntimeError(f"volumedetect produced no mean_volume for {path}")


def _download(url: str, dest: Path) -> Path:
    if not dest.exists():
        print(f"  downloading {url}")
        # Wikimedia rejects the default urllib User-Agent (HTTP 403); curl's
        # default UA is accepted, so shell out instead.
        subprocess.run(["curl", "-sL", "-f", url, "-o", str(dest)], check=True)
    return dest


def _atempo_chain(factor: float) -> str:
    """atempo only accepts [0.5, 2.0] per stage; chain stages for outliers."""
    stages = []
    f = factor
    while f < 0.5 or f > 2.0:
        stage = 2.0 if f > 2.0 else 0.5
        stages.append(stage)
        f /= stage
    stages.append(f)
    return ",".join(f"atempo={s:.6f}" for s in stages)


def _tts_chunk(text: str, target_s: float, dst: Path, tmp: Path) -> Path:
    raw = tmp / f"{dst.stem}_raw.wav"
    subprocess.run(
        ["espeak-ng", "-v", "en", "-s", "150", "-w", str(raw), text],
        check=True, capture_output=True,
    )
    factor = _duration_s(raw) / target_s
    run([
        "-y", "-i", str(raw),
        "-filter:a", _atempo_chain(factor),
        "-ar", str(SR), "-ac", "1",
        "-t", f"{target_s}",
        str(dst),
    ])
    return dst


def _laughter_burst(dst: Path) -> Path:
    src = _download(LAUGHTER_URL, ASSETS / "laughter_src.ogg")
    t0, t1 = LAUGHTER_BURST
    dur = t1 - t0
    run([
        "-y", "-i", str(src), "-ss", "0", "-t", f"{dur}",
        "-af", f"afade=t=in:d=0.05,afade=t=out:st={dur - 0.05}:d=0.05",
        "-ar", str(SR), "-ac", "1",
        str(dst),
    ])
    return dst


def _sine_burst(base_db: float, dst: Path, tmp: Path) -> Path:
    t0, t1 = SINE_BURST
    dur = t1 - t0
    raw = tmp / "sine_raw.wav"
    run([
        "-y", "-f", "lavfi", "-i", f"sine=frequency={SINE_FREQ_HZ}:duration={dur}:sample_rate={SR}",
        "-ac", "1", str(raw),
    ])
    gain = (base_db + SINE_GAIN_OVER_BASE_DB) - _mean_volume_db(raw)
    run([
        "-y", "-i", str(raw),
        "-af", f"volume={gain:.4f}dB,afade=t=in:d=0.02,afade=t=out:st={dur - 0.02}:d=0.02",
        "-ar", str(SR), "-ac", "1",
        str(dst),
    ])
    return dst


def _video_segment(duration: float, hue_deg: int, black_window: tuple[float, float] | None, dst: Path) -> Path:
    vf = f"hue=h={hue_deg}"
    if black_window:
        t0, t1 = black_window
        vf += f",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,{t0},{t1})'"
    run([
        "-y", "-f", "lavfi", "-i", f"testsrc2=size={VIDEO_W}x{VIDEO_H}:rate={FPS}:duration={duration}",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "32", "-pix_fmt", "yuv420p",
        "-an",
        str(dst),
    ])
    return dst


def build_synth_av(tmp: Path) -> None:
    print("building synth_av.mp4 ...")

    chunk_paths = []
    for i, (t0, t1, text) in enumerate(SPEECH_CHUNKS):
        dst = tmp / f"speech_{i}.wav"
        _tts_chunk(text, t1 - t0, dst, tmp)
        chunk_paths.append(dst)
    base_db = _mean_volume_db(chunk_paths[0])

    laughter_wav = _laughter_burst(tmp / "laughter.wav")
    sine_wav = _sine_burst(base_db, tmp / "sine.wav", tmp)

    bed = tmp / "bed.wav"
    run(["-y", "-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=mono", "-t", "90.0", str(bed)])

    delays_ms = [
        int(SPEECH_CHUNKS[0][0] * 1000),
        int(SPEECH_CHUNKS[1][0] * 1000),
        int(SPEECH_CHUNKS[2][0] * 1000),
        int(SPEECH_CHUNKS[3][0] * 1000),
        int(LAUGHTER_BURST[0] * 1000),
        int(SINE_BURST[0] * 1000),
    ]
    audio_inputs = [*chunk_paths, laughter_wav, sine_wav]
    filter_parts = [
        f"[{i + 1}]adelay={d}:all=1[a{i}]" for i, d in enumerate(delays_ms)
    ]
    mix_labels = "".join(f"[a{i}]" for i in range(len(audio_inputs)))
    filter_parts.append(f"[0]{mix_labels}amix=inputs={len(audio_inputs) + 1}:duration=first:normalize=0[aout]")

    audio_out = tmp / "synth_audio.wav"
    args = ["-y", "-i", str(bed)]
    for p in audio_inputs:
        args += ["-i", str(p)]
    args += [
        "-filter_complex", ";".join(filter_parts),
        "-map", "[aout]",
        "-ar", str(SR), "-ac", "1",
        str(audio_out),
    ]
    run(args)

    seg_paths = []
    for i, (duration, hue_deg, black_window) in enumerate(VIDEO_SEGMENTS):
        seg_paths.append(_video_segment(duration, hue_deg, black_window, tmp / f"seg_{i}.mp4"))
    concat_list = tmp / "concat.txt"
    concat_list.write_text("".join(f"file '{p}'\n" for p in seg_paths))
    video_concat = tmp / "video_concat.mp4"
    run(["-y", "-f", "concat", "-safe", "0", "-i", str(concat_list), "-c", "copy", str(video_concat)])

    out = FIXTURES / "synth_av.mp4"
    run([
        "-y", "-i", str(video_concat), "-i", str(audio_out),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "96k",
        "-shortest",
        str(out),
    ])

    truth = {
        "duration_s": 90.0,
        "video": {"width": VIDEO_W, "height": VIDEO_H, "fps": FPS},
        "color_cuts_s": COLOR_CUTS_S,
        "black_segment": {"t0": BLACK_SEGMENT[0], "t1": BLACK_SEGMENT[1]},
        "silence_gap": {"t0": SILENCE_GAP[0], "t1": SILENCE_GAP[1]},
        "laughter_burst": {
            "t0": LAUGHTER_BURST[0], "t1": LAUGHTER_BURST[1], "label": "laughter",
            "source_url": LAUGHTER_URL, "source_license": LAUGHTER_LICENSE,
        },
        "sine_burst": {
            "t0": SINE_BURST[0], "t1": SINE_BURST[1],
            "frequency_hz": SINE_FREQ_HZ, "gain_db_over_base": SINE_GAIN_OVER_BASE_DB,
        },
        "speech_base_mean_volume_db": round(base_db, 3),
        "speech_chunks": [
            {"t0": t0, "t1": t1, "text": text} for t0, t1, text in SPEECH_CHUNKS
        ],
    }
    (FIXTURES / "synth_av.truth.json").write_text(json.dumps(truth, indent=2) + "\n")
    print(f"  -> {out} ({_duration_s(out):.2f}s, {out.stat().st_size / 1e6:.2f}MB)")


def build_real_fixture(name: str, spec: dict, tmp: Path) -> None:
    print(f"building {name} ...")
    suffix = Path(spec["src_url"]).suffix
    src = _download(spec["src_url"], ASSETS / f"{name.rsplit('.', 1)[0]}_src{suffix}")
    dst = FIXTURES / name
    run([
        "-y", "-i", str(src),
        "-ss", str(spec["ss"]), "-t", str(spec["t"]),
        "-vf", "scale=-2:480",
        "-c:v", "libx264", "-preset", "medium",
        "-b:v", "480k", "-maxrate", "600k", "-bufsize", "1200k",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
        str(dst),
    ])
    size_mb = dst.stat().st_size / 1e6
    print(f"  -> {dst} ({probe(dst).duration_s:.2f}s, {size_mb:.2f}MB)")
    if size_mb > 6.0:
        raise RuntimeError(f"{name} is {size_mb:.2f}MB, over the 6MB fixture budget")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp_str:
        build_synth_av(Path(tmp_str))

    manifest = {
        "synth_av.mp4": {
            "duration_s": round(probe(FIXTURES / "synth_av.mp4").duration_s, 3),
            "sha256": _sha256(FIXTURES / "synth_av.mp4"),
        },
    }
    for name, spec in REAL_CLIPS.items():
        with tempfile.TemporaryDirectory() as tmp_str:
            build_real_fixture(name, spec, Path(tmp_str))
        manifest[name] = {
            "duration_s": round(probe(FIXTURES / name).duration_s, 3),
            "sha256": _sha256(FIXTURES / name),
            "url": spec["page_url"],
            "license": spec["license"],
        }

    (FIXTURES / "MANIFEST.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    total_mb = sum((FIXTURES / n).stat().st_size for n in manifest) / 1e6
    print(f"done. total fixture payload: {total_mb:.2f}MB")


if __name__ == "__main__":
    main()

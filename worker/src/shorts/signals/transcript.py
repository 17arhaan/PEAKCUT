"""Speech-to-text via faster-whisper. Model size comes from
SHORTS_WHISPER_MODEL (default "small"; tests set "tiny")."""

import os
from pathlib import Path

from faster_whisper import WhisperModel

from shorts.types import Word


def transcribe(wav: Path) -> tuple[str, list[Word]]:
    """Transcribe `wav` with word-level timestamps.

    Returns (language, words) where words are in chronological order across
    all segments.
    """
    model_size = os.environ.get("SHORTS_WHISPER_MODEL", "small")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    segments, info = model.transcribe(str(wav), word_timestamps=True)

    words: list[Word] = []
    for segment in segments:
        for w in segment.words or []:
            words.append(
                Word(
                    text=w.word.strip(),
                    t0=w.start,
                    t1=w.end,
                    conf=w.probability,
                )
            )

    return info.language, words

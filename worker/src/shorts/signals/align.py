"""Forced word alignment via torchaudio's MMS_FA bundle, used to measure how
far whisper's own word timestamps drift from a dedicated aligner
(align_err_ms).

align_err_ms is defined as: for each word, the absolute difference in
milliseconds between the midpoint of whisper's (t0, t1) span and the
midpoint of the MMS_FA-aligned (t0, t1) span for that same word.

NOTE: the alignment quality gate is median <= 100ms AND p95 <= 300ms
(re-anchored per decision 2026-07-11); downstream QA (ALIGN check, future
task) must use the same p95 <= 300 bound.
"""

import re
from dataclasses import replace
from pathlib import Path

import librosa
import torch
import torchaudio

from shorts.types import Word

_BUNDLE = torchaudio.pipelines.MMS_FA
_MODEL = None
_TOKENIZER = None
_ALIGNER = None
# MMS_FA's dictionary is a bare roman alphabet + apostrophe (see
# _BUNDLE.get_dict()); words normalizing to characters outside that set
# (digits, non-latin scripts, ...) can't be tokenized for it.
_DICT_CHARS = set(_BUNDLE.get_dict().keys()) - {"-", "*"}

_PUNCT_RE = re.compile(r"[^a-z']")


def _components():
    global _MODEL, _TOKENIZER, _ALIGNER
    if _MODEL is None:
        _MODEL = _BUNDLE.get_model()
        _MODEL.eval()
        _TOKENIZER = _BUNDLE.get_tokenizer()
        _ALIGNER = _BUNDLE.get_aligner()
    return _MODEL, _TOKENIZER, _ALIGNER


def _normalize(text: str) -> str:
    """lowercase, strip everything but the aligner's alphabet."""
    return _PUNCT_RE.sub("", text.lower())


def align_words(wav: Path, words: list[Word], language: str) -> list[Word]:
    """Forced-align `words` against `wav` and fill in each Word's
    align_err_ms. English only -- MMS_FA's dictionary here is roman-alphabet
    only, so anything else is returned unchanged.
    """
    if language != "en":
        # ponytail: en-only alignment, MMS multilingual if needed
        return words
    if not words:
        return words

    model, tokenizer, aligner = _components()

    normalized = [_normalize(w.text) for w in words]
    # Words that don't survive normalization (empty, or containing chars
    # outside the aligner's alphabet -- e.g. digits like "2024") can't be
    # aligned; they're left with align_err_ms=None (untouched).
    alignable_idx = [
        i for i, t in enumerate(normalized) if t and set(t) <= _DICT_CHARS
    ]
    if not alignable_idx:
        return words

    y, sr = librosa.load(str(wav), sr=_BUNDLE.sample_rate, mono=True)
    waveform = torch.from_numpy(y).unsqueeze(0)

    with torch.inference_mode():
        emission, _lengths = model(waveform)

    transcript = [normalized[i] for i in alignable_idx]
    tokens = tokenizer(transcript)
    token_spans = aligner(emission[0], tokens)

    # seconds spanned by one emission frame
    seconds_per_frame = waveform.size(1) / emission.size(1) / sr

    out = list(words)
    for spans, i in zip(token_spans, alignable_idx):
        if not spans:
            continue
        aligned_t0 = spans[0].start * seconds_per_frame
        aligned_t1 = spans[-1].end * seconds_per_frame
        aligned_mid_ms = (aligned_t0 + aligned_t1) / 2 * 1000
        whisper_mid_ms = (words[i].t0 + words[i].t1) / 2 * 1000
        out[i] = replace(words[i], align_err_ms=abs(whisper_mid_ms - aligned_mid_ms))

    return out

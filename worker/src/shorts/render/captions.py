"""Word-level transcript timing -> karaoke ASS subtitle track.

Words are grouped 3-5 per Dialogue line (breaking early at punctuation or a
>1.2s gap to the next word), each word gets a \\kf<centiseconds> karaoke
fill tag, and the caller picks one of three preset visual styles (s1/s2/s3).
"""

from shorts.types import Word

_MIN_GROUP = 3
_MAX_GROUP = 5
_GAP_BREAK_S = 1.2
_SAFE_MARGIN_V_FRAC = 0.20  # 20% safe margin off the bottom (platform UI overlap)
_SAFE_MARGIN_H_FRAC = 0.08

# Three preset "V4+ Styles" karaoke looks, selected by name via `style`.
# libass \kf semantics: the already-spoken portion of a word draws in
# PrimaryColour, the not-yet-spoken portion in SecondaryColour -- so
# "primary" below is each preset's highlight/sweep colour and "secondary"
# is its base (unspoken) text colour. Colours are ASS &HAABBGGRR.
_PRESETS = {
    "s1": {"fontname": "Inter", "primary": "&H0000FFFF", "secondary": "&H00FFFFFF", "outline": 3},
    "s2": {"fontname": "Noto Sans", "primary": "&H0000FF00", "secondary": "&H00FFFFFF", "outline": 3},
    "s3": {"fontname": "Inter", "primary": "&H00FF66FF", "secondary": "&H00CCCCCC", "outline": 4},
}
_OUTLINE_COLOUR = "&H00000000"
_BACK_COLOUR = "&H80000000"
_BOLD = 1
_SHADOW = 0
_ALIGNMENT = 2  # bottom-center

# Hook overlay: a second, plain (no \kf) style layered into the SAME ASS
# file/pass as the karaoke captions -- top safe area, first 3s of the clip.
_HOOK_STYLE_NAME = "hook"
_HOOK_FONTNAME = "Inter"
_HOOK_FONT_SCALE = 0.06  # larger than the karaoke captions' 0.045
_HOOK_TOP_MARGIN_FRAC = 0.15
_HOOK_ALIGNMENT = 8  # top-center
_HOOK_OUTLINE = 3
_HOOK_COLOUR = "&H00FFFFFF"  # opaque white -- plain text, no karaoke sweep
_HOOK_DISPLAY_S = 3.0  # hook overlay duration, clamped to clip length if shorter


def _ass_time(t: float) -> str:
    """Format seconds as an ASS timestamp: H:MM:SS.cc"""
    t = max(t, 0.0)
    centis = round(t * 100)
    h, rem = divmod(centis, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{cs:02d}"

def _escape(text: str) -> str:
    # ASS uses {} for override tags and \N for line breaks; keep it simple.
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def _ends_with_punctuation(text: str) -> bool:
    return text.rstrip()[-1:] in ".,!?;:"


def _group_words(words: list[Word]) -> list[list[Word]]:
    """Chunk words into Dialogue-line groups of 3-5, breaking early (once at
    least 3 words are in the current group) at a punctuation-ending word or
    a >1.2s gap to the next word; forced break once a group hits 5 words.
    A trailing group of fewer than 3 words is allowed (nothing left to add
    to it)."""
    groups: list[list[Word]] = []
    current: list[Word] = []
    for i, w in enumerate(words):
        current.append(w)
        if len(current) >= _MAX_GROUP:
            groups.append(current)
            current = []
            continue
        if len(current) >= _MIN_GROUP:
            next_word = words[i + 1] if i + 1 < len(words) else None
            gap = (next_word.t0 - w.t1) if next_word else 0.0
            if _ends_with_punctuation(w.text) or gap > _GAP_BREAK_S:
                groups.append(current)
                current = []
    if current:
        groups.append(current)
    return groups


def _karaoke_text(group: list[Word]) -> str:
    """Build the \\kf-tagged text for one Dialogue line. Each word's
    highlight duration folds in the gap to the *next* word in the group
    (rather than emitting a separate unhighlighted span for the gap), so
    the per-word \\kf durations always sum exactly to the line's
    (End - Start) -- the last word in the group just uses its own
    utterance duration, with no following word to fold into."""
    parts = []
    for i, w in enumerate(group):
        if i + 1 < len(group):
            duration = group[i + 1].t0 - w.t0
        else:
            duration = w.t1 - w.t0
        centis = max(round(duration * 100), 0)
        parts.append(f"{{\\kf{centis}}}{_escape(w.text)}")
    return " ".join(parts)


def words_to_ass(
    words: list[Word],
    style: str,
    resolution: tuple[int, int],
    hook_title: str | None = None,
    clip_duration_s: float | None = None,
) -> str:
    """Build ASS subtitle content for `style` (one of s1/s2/s3): words
    grouped 3-5 per Dialogue line with per-word \\kf karaoke timing,
    bottom-center with a 20% vertical / 8% horizontal safe margin.

    `hook_title`, if given, adds a SECOND Dialogue line + Style in the same
    file: plain text (no \\kf), bold, larger, top-center-aligned with a 15%
    top margin, shown from 0s to min(_HOOK_DISPLAY_S, clip_duration_s) --
    i.e. clip-relative time, matching the trimmed output's own 0-based
    timeline (ffmpeg's -ss-before--i trim resets PTS to ~0)."""
    preset = _PRESETS[style]
    width, height = resolution
    font_size = max(round(height * 0.045), 24)
    margin_v = round(height * _SAFE_MARGIN_V_FRAC)
    margin_h = round(width * _SAFE_MARGIN_H_FRAC)

    style_lines = (
        f"Style: {style},{preset['fontname']},{font_size},{preset['primary']},"
        f"{preset['secondary']},{_OUTLINE_COLOUR},{_BACK_COLOUR},{_BOLD},{preset['outline']},"
        f"{_SHADOW},{_ALIGNMENT},{margin_h},{margin_h},{margin_v}\n"
    )

    hook_dialogue = ""
    if hook_title:
        hook_font_size = max(round(height * _HOOK_FONT_SCALE), 24)
        hook_margin_v = round(height * _HOOK_TOP_MARGIN_FRAC)
        style_lines += (
            f"Style: {_HOOK_STYLE_NAME},{_HOOK_FONTNAME},{hook_font_size},{_HOOK_COLOUR},"
            f"{_HOOK_COLOUR},{_OUTLINE_COLOUR},{_BACK_COLOUR},{_BOLD},{_HOOK_OUTLINE},"
            f"{_SHADOW},{_HOOK_ALIGNMENT},{margin_h},{margin_h},{hook_margin_v}\n"
        )
        display_s = _HOOK_DISPLAY_S if clip_duration_s is None else min(_HOOK_DISPLAY_S, clip_duration_s)
        end = _ass_time(display_s)
        hook_dialogue = f"Dialogue: 0,0:00:00.00,{end},{_HOOK_STYLE_NAME},,0,0,0,,{_escape(hook_title)}\n"

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        f"{style_lines}\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = []
    for group in _group_words(words):
        start = _ass_time(group[0].t0)
        end = _ass_time(group[-1].t1)
        text = _karaoke_text(group)
        lines.append(f"Dialogue: 0,{start},{end},{style},,0,0,0,,{text}")

    return header + hook_dialogue + "\n".join(lines) + "\n"


if __name__ == "__main__":
    # ponytail: quick manual self-check, not a substitute for
    # tests/test_captions.py -- run `python -m shorts.render.captions`.
    demo_words = [
        Word(text="Hello,", t0=0.0, t1=0.3, conf=0.9),
        Word(text="world", t0=0.35, t1=0.6, conf=0.9),
        Word(text="this", t0=0.6, t1=0.8, conf=0.9),
        Word(text="is", t0=0.8, t1=0.95, conf=0.9),
    ]
    out = words_to_ass(demo_words, "s1", (1080, 1920))
    assert "\\kf" in out
    assert "Style: s1,Inter" in out
    assert out.count("Dialogue:") == 1
    print("captions self-check OK")

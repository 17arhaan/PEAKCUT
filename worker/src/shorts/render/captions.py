"""Convert word-level transcript timing into a basic ASS subtitle track.

No karaoke/word-highlight timing yet -- each caption is a fixed-size chunk
of words shown for its span. Upgraded in a later task.
"""

from shorts.types import Word

# ponytail: crude fixed-size chunking, replace with a smarter line-breaker
# once caption styling is a real task.
_WORDS_PER_CAPTION = 6


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


def words_to_ass(words: list[Word], style: str, resolution: tuple[int, int]) -> str:
    """Build ASS subtitle content: one basic bottom-centered style, captions
    chunked into fixed-size groups of words."""
    width, height = resolution
    font_size = max(int(height * 0.045), 24)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "WrapStyle: 0\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, "
        "Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        f"Style: {style},Arial,{font_size},&H00FFFFFF,&H00000000,&H80000000,1,3,0,2,60,60,80\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = []
    for i in range(0, len(words), _WORDS_PER_CAPTION):
        chunk = words[i : i + _WORDS_PER_CAPTION]
        if not chunk:
            continue
        text = _escape(" ".join(w.text for w in chunk))
        start = _ass_time(chunk[0].t0)
        end = _ass_time(chunk[-1].t1)
        lines.append(f"Dialogue: 0,{start},{end},{style},,0,0,0,,{text}")

    return header + "\n".join(lines) + "\n"

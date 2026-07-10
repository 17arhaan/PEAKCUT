"""Tests for shorts.render.captions: karaoke ASS generation.

Golden strings below were produced by running words_to_ass on the fixed
12-word input (see _GOLDEN_WORDS) and hand-verified by tracing the grouping
and \\kf-duration math word-by-word (see task-7-report.md for the trace):
group breaks land at a trailing comma (4 words), a >1.2s gap (3 words), and
the forced 5-word cap (also comma-terminated); each line's \\kf durations
sum exactly to (End - Start) in centiseconds.
"""

from shorts.render.captions import _group_words, words_to_ass
from shorts.types import Word

_GOLDEN_WORDS = [
    Word(text="This", t0=0.00, t1=0.20, conf=0.9),
    Word(text="is", t0=0.20, t1=0.35, conf=0.9),
    Word(text="a", t0=0.35, t1=0.42, conf=0.9),
    Word(text="test,", t0=0.42, t1=0.70, conf=0.9),
    Word(text="and", t0=2.00, t1=2.20, conf=0.9),
    Word(text="here", t0=2.20, t1=2.40, conf=0.9),
    Word(text="is", t0=2.40, t1=2.50, conf=0.9),
    Word(text="a", t0=4.00, t1=4.10, conf=0.9),
    Word(text="demonstration", t0=4.10, t1=4.80, conf=0.9),
    Word(text="of", t0=4.80, t1=4.90, conf=0.9),
    Word(text="karaoke", t0=4.90, t1=5.20, conf=0.9),
    Word(text="captions.", t0=5.20, t1=5.60, conf=0.9),
]

_GOLDEN = {
    "s1": (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        "Style: s1,Inter,86,&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,1,3,0,2,86,86,384\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:00.70,s1,,0,0,0,,{\\kf20}This {\\kf15}is {\\kf7}a {\\kf28}test,\n"
        "Dialogue: 0,0:00:02.00,0:00:02.50,s1,,0,0,0,,{\\kf20}and {\\kf20}here {\\kf10}is\n"
        "Dialogue: 0,0:00:04.00,0:00:05.60,s1,,0,0,0,,{\\kf10}a {\\kf70}demonstration {\\kf10}of "
        "{\\kf30}karaoke {\\kf40}captions.\n"
    ),
    "s2": (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        "Style: s2,Noto Sans,86,&H0000FF00,&H00FFFFFF,&H00000000,&H80000000,1,3,0,2,86,86,384\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:00.70,s2,,0,0,0,,{\\kf20}This {\\kf15}is {\\kf7}a {\\kf28}test,\n"
        "Dialogue: 0,0:00:02.00,0:00:02.50,s2,,0,0,0,,{\\kf20}and {\\kf20}here {\\kf10}is\n"
        "Dialogue: 0,0:00:04.00,0:00:05.60,s2,,0,0,0,,{\\kf10}a {\\kf70}demonstration {\\kf10}of "
        "{\\kf30}karaoke {\\kf40}captions.\n"
    ),
    "s3": (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 0\n\n"
        "[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV\n"
        "Style: s3,Inter,86,&H00FF66FF,&H00CCCCCC,&H00000000,&H80000000,1,4,0,2,86,86,384\n\n"
        "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        "Dialogue: 0,0:00:00.00,0:00:00.70,s3,,0,0,0,,{\\kf20}This {\\kf15}is {\\kf7}a {\\kf28}test,\n"
        "Dialogue: 0,0:00:02.00,0:00:02.50,s3,,0,0,0,,{\\kf20}and {\\kf20}here {\\kf10}is\n"
        "Dialogue: 0,0:00:04.00,0:00:05.60,s3,,0,0,0,,{\\kf10}a {\\kf70}demonstration {\\kf10}of "
        "{\\kf30}karaoke {\\kf40}captions.\n"
    ),
}


def test_words_to_ass_golden_s1():
    assert words_to_ass(_GOLDEN_WORDS, "s1", (1080, 1920)) == _GOLDEN["s1"]


def test_words_to_ass_golden_s2():
    assert words_to_ass(_GOLDEN_WORDS, "s2", (1080, 1920)) == _GOLDEN["s2"]


def test_words_to_ass_golden_s3():
    assert words_to_ass(_GOLDEN_WORDS, "s3", (1080, 1920)) == _GOLDEN["s3"]


def _word(text, t0, t1):
    return Word(text=text, t0=t0, t1=t1, conf=0.9)


def test_grouping_never_exceeds_five_words():
    """Property: no matter the punctuation/gap pattern, no group has >5
    words (and the golden's 3-word tail group shows groups can be shorter
    when a break condition fires early)."""
    # dense, no punctuation, no gaps -> pure forced-5 chunking
    dense = [_word(f"w{i}", i * 0.2, i * 0.2 + 0.15) for i in range(23)]
    # every word punctuated -> every group should break at the minimum (3)
    punctuated = [_word(f"w{i}.", i * 0.2, i * 0.2 + 0.15) for i in range(17)]
    # every word far apart -> gap-break every group at the minimum (3)
    gappy = [_word(f"w{i}", i * 3.0, i * 3.0 + 0.2) for i in range(14)]

    for words in (dense, punctuated, gappy, _GOLDEN_WORDS, []):
        for group in _group_words(words):
            assert 1 <= len(group) <= 5


def test_grouping_punctuated_words_break_at_minimum_group_size():
    words = [_word(f"w{i}.", i * 0.2, i * 0.2 + 0.15) for i in range(9)]
    groups = _group_words(words)
    assert all(len(g) == 3 for g in groups)


def test_grouping_covers_every_word_in_order():
    groups = _group_words(_GOLDEN_WORDS)
    flat = [w for g in groups for w in g]
    assert flat == _GOLDEN_WORDS

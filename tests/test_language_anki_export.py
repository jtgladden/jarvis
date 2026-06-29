"""Unit tests for the deterministic Anki export formatter.

Runnable with pytest or directly: ``python tests/test_language_anki_export.py``.
"""

import os
import sys
import tempfile

# build_anki_export lives in app.language_learning, which instantiates an OpenAI
# client at import time. Provide a dummy key so the import succeeds offline; the
# formatter itself never calls OpenAI. Point the store at a throwaway DB so the
# provenance test never touches real data.
os.environ.setdefault("OPENAI_API_KEY", "test-key")
os.environ["LANGUAGE_DB"] = os.path.join(tempfile.mkdtemp(), "language_test.db")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.language_learning import build_anki_export  # noqa: E402
from app.language_store import (  # noqa: E402
    get_vocab_for_export,
    init_language_store,
    save_vocab_record,
    seed_common_word_records,
)

HEADER = (
    "#separator:tab\n"
    "#html:true\n"
    "#notetype:Basic\n"
    "#deck:Jarvis::Tagalog\n"
    "#tags column:3\n"
)


def test_full_row_and_bare_row_and_escaping():
    rows = [
        {
            "phrase": "Kumusta",
            "translation": "How are you",
            "pronunciation": "koo-moos-tah",
            "notes": "casual greeting",
            "tags": ["word", "greeting"],
        },
        {
            "phrase": "Salamat",
            "translation": "Thank you",
            "pronunciation": "",
            "notes": "",
            "tags": [],
        },
        {
            "phrase": "line1\tline2",
            "translation": "first\nsecond",
            "pronunciation": "",
            "notes": "note\twith\ttabs",
            "tags": ["multi word tag"],
        },
    ]

    expected = HEADER + "\n".join(
        [
            "Kumusta\tHow are you<br>[koo-moos-tah]<br><i>casual greeting</i>\tjarvis tagalog all word greeting",
            "Salamat\tThank you\tjarvis tagalog all",
            "line1 line2\tfirst<br>second<br><i>note with tabs</i>\tjarvis tagalog all multi_word_tag",
        ]
    ) + "\n"

    assert build_anki_export("tagalog", rows, scope="all") == expected


def test_japanese_pronunciation_strips_kana():
    rows = [
        {
            "phrase": "猫",
            "translation": "cat",
            # kana leaking into the reading must be stripped to Latin-only
            "pronunciation": "nekoね",
            "notes": "",
            "tags": ["word"],
        }
    ]
    output = build_anki_export("japanese", rows, scope="due")
    lines = output.splitlines()

    assert lines[3] == "#deck:Jarvis::Japanese"
    # No kana anywhere in the note line, reading reduced to romaji.
    assert lines[-1] == "猫\tcat<br>[neko]\tjarvis japanese due word"


def test_legacy_merged_note_collapses_to_user_note():
    rows = [
        {
            "phrase": "は",
            "translation": "(topic marker)",
            "pronunciation": "wa",
            "notes": (
                "Use 'は' pronounced 'wa' to mark the topic of a sentence, not the subject.\n"
                "User note: Always use 'wa' to mark the topic, not the subject."
            ),
            "tags": ["word"],
        }
    ]
    output = build_anki_export("japanese", rows, scope="mine")
    # Only the learner's own note survives — no AI half, no doubling.
    assert output.splitlines()[-1] == (
        "は\t(topic marker)<br>[wa]<br><i>Always use 'wa' to mark the topic, not the subject.</i>"
        "\tjarvis japanese mine word"
    )


def test_mine_scope_excludes_seeded_words():
    init_language_store()
    user = "provenance-test-user"
    save_vocab_record(
        language="tagalog",
        phrase="bahay",
        translation="house",
        pronunciation="",
        notes="",
        tags=["word"],
        user_id=user,
    )
    seed_common_word_records(
        {"tagalog": [{"word": "ako", "translation": "I", "rank": 1, "part_of_speech": "pronoun"}]},
        user_id=user,
    )

    mine = {row["phrase"] for row in get_vocab_for_export(user_id=user, language="tagalog", scope="mine")}
    every = {row["phrase"] for row in get_vocab_for_export(user_id=user, language="tagalog", scope="all")}

    # "mine" keeps the user-added card but drops the seeded common-600 word.
    assert "bahay" in mine
    assert "ako" not in mine
    # "all" is the only scope that includes seeded words.
    assert {"bahay", "ako"} <= every


if __name__ == "__main__":
    test_full_row_and_bare_row_and_escaping()
    test_japanese_pronunciation_strips_kana()
    test_legacy_merged_note_collapses_to_user_note()
    test_mine_scope_excludes_seeded_words()
    print("All Anki export formatter tests passed.")

"""Unit tests for the person-page journal alias matcher.

Proves word-boundary matching: "Sam" must NOT match "Samantha" or "Samsung",
but must match the standalone name. Runnable with pytest or directly:
``python tests/test_people_journal_search.py``.

The matcher (``app.people.find_alias_match``) is pure and DB-free, but the
module imports ``app.photoprism_client`` at import time; point the config env
at throwaway values so the import succeeds offline.
"""

import os
import sys

os.environ.setdefault("OPENAI_API_KEY", "test-key")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.people import find_alias_match  # noqa: E402


def test_short_name_does_not_match_longer_words():
    assert find_alias_match("Talked to Samantha about the trip.", ["Sam"]) is None
    assert find_alias_match("I bought a new Samsung phone today.", ["Sam"]) is None
    assert find_alias_match("Samsonite luggage arrived.", ["Sam"]) is None


def test_standalone_name_matches():
    match = find_alias_match("Went hiking with Sam this morning.", ["Sam"])
    assert match is not None
    alias, snippet = match
    assert alias == "Sam"
    assert "Sam" in snippet


def test_possessive_and_punctuation_are_boundaries():
    assert find_alias_match("Sam's birthday was great.", ["Sam"]) is not None
    assert find_alias_match("Saw Sam, then left.", ["Sam"]) is not None
    assert find_alias_match("(Sam)", ["Sam"]) is not None


def test_case_insensitive_and_alias_fallthrough():
    match = find_alias_match("dinner with sam and family", ["Samuel", "Sam"])
    assert match is not None and match[0] == "Sam"


def test_multiword_alias():
    assert find_alias_match("Met John Smith downtown.", ["John Smith"]) is not None
    assert find_alias_match("Met John Smithson downtown.", ["John Smith"]) is None


def _run() -> None:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok - {name}")


if __name__ == "__main__":
    _run()
    print("All people journal-search tests passed.")

"""Person-page service: merge journal mentions + PhotoPrism photos into one
date-sorted, read-only timeline. Everything is queried live (no sync/cron)."""

import logging
import re
from concurrent.futures import ThreadPoolExecutor

from app.config import APP_DEFAULT_USER_ID
from app.journal_store import find_entries_matching_terms
from app.people_store import get_person, list_people
from app.photoprism_client import search_person_photos

logger = logging.getLogger(__name__)

_PHOTOS_PER_INSTANCE = 500
_SNIPPET_RADIUS = 60


def _boundary_pattern(alias: str) -> re.Pattern[str]:
    # (?<!\w) / (?!\w) is a Unicode-safe word boundary: "Sam" will not match
    # inside "Samantha" or "Samsung", but will match "Sam" and "Sam's".
    return re.compile(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", re.IGNORECASE)


def find_alias_match(text: str, aliases: list[str]) -> tuple[str, str] | None:
    """Return (matched_alias, snippet) for the first whole-word alias hit.

    Pure and DB-free so it can be unit-tested. Uses word-boundary matching to
    reject substring false positives.
    """
    if not text:
        return None
    for alias in aliases:
        alias = alias.strip()
        if not alias:
            continue
        match = _boundary_pattern(alias).search(text)
        if match:
            return alias, _snippet_around(text, match.start(), match.end())
    return None


def _snippet_around(text: str, start: int, end: int) -> str:
    left = max(0, start - _SNIPPET_RADIUS)
    right = min(len(text), end + _SNIPPET_RADIUS)
    snippet = re.sub(r"\s+", " ", text[left:right]).strip()
    if left > 0:
        snippet = "…" + snippet
    if right < len(text):
        snippet = snippet + "…"
    return snippet


def _search_journal(person: dict) -> list[dict]:
    aliases = _all_terms(person)
    rows = find_entries_matching_terms(aliases, user_id=person.get("user_id", APP_DEFAULT_USER_ID))
    items: list[dict] = []
    for row in rows:
        text = "\n".join(
            str(value)
            for key, value in row.items()
            if key != "entry_date" and value
        )
        match = find_alias_match(text, aliases)
        if match is None:
            continue  # LIKE prefilter hit but no whole-word match — skip
        matched_alias, snippet = match
        items.append(
            {
                "kind": "journal",
                "date": str(row["entry_date"]),
                "sort_key": f"{row['entry_date']}T00:00:00",
                "entry_id": str(row["entry_date"]),
                "matched_alias": matched_alias,
                "snippet": snippet,
            }
        )
    return items


def _all_terms(person: dict) -> list[str]:
    terms = [person["canonical_name"], *person.get("aliases", [])]
    seen: set[str] = set()
    unique: list[str] = []
    for term in terms:
        key = term.strip().lower()
        if key and key not in seen:
            seen.add(key)
            unique.append(term.strip())
    return unique


def _search_instance(ref: dict) -> list[dict]:
    """Search one PhotoPrism instance; tolerate the instance being down."""
    try:
        photos = search_person_photos(
            ref["instance_key"],
            ref["subject_name"] or ref["subject_uid"],
            count=_PHOTOS_PER_INSTANCE,
        )
    except Exception as exc:  # noqa: BLE001 — one instance down must not fail the page
        logger.warning(
            "PhotoPrism instance %s search failed for subject %s: %s",
            ref["instance_key"], ref.get("subject_name") or ref.get("subject_uid"), exc,
        )
        return []
    return [
        {
            "kind": "photo",
            "date": photo.get("taken_at", ""),
            "sort_key": photo.get("taken_at", ""),
            "uid": photo.get("uid", ""),
            "thumb_url": photo.get("thumb_url", ""),
            "instance_key": ref["instance_key"],
        }
        for photo in photos
    ]


def get_person_timeline(person_id: str, user_id: str = APP_DEFAULT_USER_ID) -> dict | None:
    """Load a person and build their merged, date-desc timeline.

    Runs the journal search once and one PhotoPrism search per instance ref in
    parallel. A downed instance yields no photos rather than failing the page.
    """
    person = get_person(person_id, user_id=user_id)
    if person is None:
        return None
    person = {**person, "user_id": user_id}

    refs = person.get("photoprism", [])
    with ThreadPoolExecutor(max_workers=max(1, len(refs) + 1)) as pool:
        journal_future = pool.submit(_search_journal, person)
        instance_futures = [pool.submit(_search_instance, ref) for ref in refs]
        timeline = journal_future.result()
        for future in instance_futures:
            timeline.extend(future.result())

    timeline.sort(key=lambda item: item["sort_key"], reverse=True)
    return {
        "id": person["id"],
        "canonical_name": person["canonical_name"],
        "aliases": person.get("aliases", []),
        "photoprism": refs,
        "timeline": timeline,
    }


def list_people_summaries(user_id: str = APP_DEFAULT_USER_ID) -> list[dict]:
    return list_people(user_id=user_id)

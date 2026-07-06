"""Person-page service: merge journal mentions + PhotoPrism photos into one
date-sorted, read-only timeline. Everything is queried live (no sync/cron)."""

import logging
import re
from concurrent.futures import ThreadPoolExecutor

from app.config import APP_DEFAULT_USER_ID
from app.journal_store import find_entries_matching_terms
from app.people_store import (
    alias_norm,
    get_alias_candidate_map,
    get_alias_default,
    get_alias_default_map,
    get_journal_mention,
    get_journal_mention_map,
    get_person,
    get_person_ids_for_alias,
    get_person_names,
    list_people,
)
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


def _entry_text(row: dict) -> str:
    """Join a journal row's prose columns into one searchable blob."""
    return "\n".join(
        str(value) for key, value in row.items() if key != "entry_date" and value
    )


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


# ---------------------------------------------------------------------------
# STEP 2 — alias resolver (shared by timeline and review queue)
# ---------------------------------------------------------------------------

def _apply_precedence(
    candidates: list[str],
    default_person_id: str | None,
    bound_person_id: str | None,
) -> str | None:
    """Resolution precedence: binding > single-candidate > default > None.

    A default only applies when the alias is genuinely ambiguous (>1 candidate);
    with exactly one candidate the alias is unambiguous and needs no default.
    Never guesses among multiple candidates.
    """
    if bound_person_id is not None:
        return bound_person_id
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1 and default_person_id is not None:
        return default_person_id
    return None


def candidates_for_alias(user_id: str, alias: str) -> list[str]:
    """Person ids that hold this alias (case-insensitive), from people_aliases."""
    return get_person_ids_for_alias(user_id, alias)


def resolve_alias(user_id: str, entry_date: str, alias: str) -> str | None:
    """Resolve one alias occurrence to a person id, or None if UNRESOLVED."""
    norm = alias_norm(alias)
    return _apply_precedence(
        candidates=candidates_for_alias(user_id, norm),
        default_person_id=get_alias_default(user_id, norm),
        bound_person_id=get_journal_mention(user_id, entry_date, norm),
    )


def _resolution_context(user_id: str) -> dict:
    """Preload the maps needed to resolve many occurrences without per-call I/O."""
    return {
        "candidates": get_alias_candidate_map(user_id),  # alias_norm -> {display, person_ids}
        "defaults": get_alias_default_map(user_id),       # alias_norm -> person_id
        "mentions": get_journal_mention_map(user_id),     # (date, alias_norm) -> person_id
        "names": get_person_names(user_id),               # person_id -> canonical_name
    }


def _resolve_with_ctx(ctx: dict, entry_date: str, norm: str) -> str | None:
    candidates = ctx["candidates"].get(norm, {}).get("person_ids", [])
    return _apply_precedence(
        candidates=candidates,
        default_person_id=ctx["defaults"].get(norm),
        bound_person_id=ctx["mentions"].get((entry_date, norm)),
    )


def _candidate_objects(ctx: dict, norm: str) -> list[dict]:
    return [
        {"id": pid, "canonical_name": ctx["names"].get(pid, "")}
        for pid in ctx["candidates"].get(norm, {}).get("person_ids", [])
    ]


# ---------------------------------------------------------------------------
# STEP 3 — person timeline with alias disambiguation applied
# ---------------------------------------------------------------------------

def _search_journal(person: dict, ctx: dict) -> list[dict]:
    terms = _all_terms(person)
    person_id = person["id"]
    user_id = person.get("user_id", APP_DEFAULT_USER_ID)
    rows = find_entries_matching_terms(terms, user_id=user_id)

    items: list[dict] = []
    for row in rows:
        text = _entry_text(row)
        entry_date = str(row["entry_date"])
        unique_hit: tuple[str, str] | None = None       # (alias, snippet)
        shared_hit: tuple[str, str, list[dict]] | None = None  # (alias, snippet, candidates)

        for term in terms:
            match = find_alias_match(text, [term])  # STEP 0: same word-boundary matcher
            if match is None:
                continue
            _, snippet = match
            norm = alias_norm(term)
            candidates = ctx["candidates"].get(norm, {}).get("person_ids", [])
            if len(candidates) <= 1:
                # Unique to this person (own canonical name, or an alias only
                # they hold) — always include, no disambiguation needed.
                unique_hit = (term, snippet)
                break
            # Shared alias: include only if it resolves to THIS person.
            if shared_hit is None and _resolve_with_ctx(ctx, entry_date, norm) == person_id:
                shared_hit = (term, snippet, _candidate_objects(ctx, norm))

        if unique_hit is not None:
            alias, snippet = unique_hit
            items.append(_journal_item(entry_date, alias, snippet))
        elif shared_hit is not None:
            alias, snippet, candidates = shared_hit
            item = _journal_item(entry_date, alias, snippet)
            item.update({"via_alias": alias, "shared": True, "candidates": candidates})
            items.append(item)
        # else: matched only shared aliases resolving elsewhere / UNRESOLVED — exclude
    return items


def _journal_item(entry_date: str, alias: str, snippet: str) -> dict:
    return {
        "kind": "journal",
        "date": entry_date,
        "sort_key": f"{entry_date}T00:00:00",
        "entry_id": entry_date,
        "matched_alias": alias,
        "snippet": snippet,
    }


# ---------------------------------------------------------------------------
# STEP 4 — unresolved review queue
# ---------------------------------------------------------------------------

def get_unresolved_review_queue(user_id: str = APP_DEFAULT_USER_ID) -> list[dict]:
    """Entries whose ambiguous alias occurrence resolves to nobody yet.

    Ambiguous aliases = alias strings held by >1 of the user's people. Uses the
    same word-boundary matcher and snippet fn as the timeline so they agree.
    """
    ctx = _resolution_context(user_id)
    ambiguous = {
        norm: info for norm, info in ctx["candidates"].items() if len(info["person_ids"]) > 1
    }
    if not ambiguous:
        return []

    items: list[dict] = []
    for norm, info in ambiguous.items():
        display = info["display"]
        rows = find_entries_matching_terms([display], user_id=user_id)
        for row in rows:
            text = _entry_text(row)
            match = find_alias_match(text, [display])
            if match is None:
                continue
            entry_date = str(row["entry_date"])
            if _resolve_with_ctx(ctx, entry_date, norm) is not None:
                continue  # already resolved (binding, default, or single candidate)
            items.append(
                {
                    "entry_date": entry_date,
                    "alias": display,
                    "snippet": match[1],
                    "candidates": _candidate_objects(ctx, norm),
                }
            )

    items.sort(key=lambda item: item["entry_date"], reverse=True)
    return items


def get_unresolved_count(user_id: str = APP_DEFAULT_USER_ID) -> int:
    return len(get_unresolved_review_queue(user_id=user_id))


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
    ctx = _resolution_context(user_id)

    refs = person.get("photoprism", [])
    with ThreadPoolExecutor(max_workers=max(1, len(refs) + 1)) as pool:
        journal_future = pool.submit(_search_journal, person, ctx)
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

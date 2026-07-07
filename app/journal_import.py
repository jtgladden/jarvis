"""Batch journal-import orchestration: page grouping, dedupe, and commit.

Sits between the vision extractor (``app.journal_scan``), the staging store
(``app.journal_import_store``), and the real journal store (``app.journal_store``).

Design assumption: the archive is **short, dated entries** (each entry has a date
heading; grouping is cheap). Pages are processed in contiguous groups with a
one-page overlap so an entry split across a group boundary is still seen whole in
one group; the overlap can emit the same entry twice, so fragments are deduped by
``(detected_date, normalized first ~40 chars)``.

NOTE: a free-flowing journal (one entry running for pages with dates buried
mid-text) would break both the grouping heuristic and this dedupe key — there the
grouping would need semantic entry-boundary detection and the dedupe would need a
longer/normalized text hash or overlap-region reconciliation. See callers.
"""

import logging
import re
from dataclasses import dataclass, field
from datetime import date as date_cls
from typing import Callable

from app.config import (
    APP_DEFAULT_USER_ID,
    JOURNAL_IMPORT_BATCH_PAGES,
    JOURNAL_IMPORT_LOW_CONFIDENCE,
    JOURNAL_IMPORT_OVERLAP_PAGES,
    OPENAI_JOURNAL_VISION_MODEL,
    estimate_vision_cost_usd,
)
from app.journal_ingest import delete_batch_pages, load_page_image
from app.journal_scan import _date_from_heading, extract_journal_entries
from app.journal_import_store import (
    delete_batch_fragments,
    delete_batch_groups,
    delete_groups_for_source,
    delete_batch_row,
    get_batch,
    group_already_extracted,
    insert_fragment,
    list_fragments,
    record_group,
    record_group_failure,
    record_token_usage,
    set_batch_status,
    set_fragments_status,
    update_fragment,
)
from app.journal_store import list_journal_entries, upsert_journal_entry

logger = logging.getLogger(__name__)

# Column in journal_entries that receives the transcribed markdown, per target.
_TARGET_COLUMN = {"journal": "journal_entry", "scripture": "scripture_study"}
_DEDUPE_PREFIX_CHARS = 60
_CONFIDENCE_RANK = {"low": 0, "medium": 1, "high": 2}


def record_usage(usage) -> float:
    """Record one call's tokens + estimated cost to the ledger; return the cost."""
    cost = estimate_vision_cost_usd(usage.model, usage.input_tokens, usage.output_tokens)
    record_token_usage(
        date_cls.today().isoformat(),
        usage.model,
        usage.input_tokens,
        usage.output_tokens,
        usage.total_tokens,
        cost,
    )
    return cost


@dataclass
class PageGroup:
    page_indices: list[int]
    page_range: str  # absolute-index label, e.g. "0-3" — idempotency key
    overlap_lead: int = 0  # leading pages shared with the previous group


@dataclass
class GroupResult:
    page_range: str
    skipped: bool = False
    failed: bool = False
    error: str = ""
    fragments_inserted: list[int] = field(default_factory=list)
    total_tokens: int = 0
    cost_usd: float = 0.0


# --- Page grouping -----------------------------------------------------------


def plan_groups(
    page_count: int,
    batch_pages: int | None = None,
    overlap_pages: int | None = None,
) -> list[PageGroup]:
    """Contiguous page windows with a carried-forward overlap.

    e.g. 10 pages, batch=4, overlap=1 -> [0-3, 3-6, 6-9, 9-9].
    """
    batch = max(1, batch_pages if batch_pages is not None else JOURNAL_IMPORT_BATCH_PAGES)
    overlap = overlap_pages if overlap_pages is not None else JOURNAL_IMPORT_OVERLAP_PAGES
    overlap = max(0, min(overlap, batch - 1))
    step = max(1, batch - overlap)

    groups: list[PageGroup] = []
    start = 0
    prev_end = 0  # exclusive end of the previous group (0 => no previous group)
    while start < page_count:
        end = min(start + batch, page_count)
        indices = list(range(start, end))
        # Leading pages this group shares with the previous group. Entries that
        # begin on these pages were already seen (whole) by the previous group.
        overlap_lead = max(0, prev_end - start) if prev_end else 0
        groups.append(PageGroup(page_indices=indices, page_range=f"{start}-{end - 1}", overlap_lead=overlap_lead))
        if end >= page_count:
            break
        prev_end = end
        start += step
    return groups


def count_groups(page_count: int, batch_pages: int | None = None, overlap_pages: int | None = None) -> int:
    return len(plan_groups(page_count, batch_pages, overlap_pages))


# --- Dedupe ------------------------------------------------------------------


def _normalize_prefix(text: str) -> str:
    # Alphanumerics only: the overlap re-transcribes the same page slightly
    # differently (punctuation/spacing/"pooped" vs "popped"), so stripping
    # non-alnum and comparing a longer run makes the same entry collide.
    collapsed = re.sub(r"[^a-z0-9]", "", (text or "").lower())
    return collapsed[:_DEDUPE_PREFIX_CHARS]


def _month_day(detected_date: str | None) -> str:
    """MM-DD from a full or partial detected_date, ignoring the year.

    The overlap can transcribe the same entry's year differently (or the model
    can hallucinate one), so the dedupe key keys on month/day only — the year is
    assigned deterministically later by resolve_fragment_years.
    """
    text = (detected_date or "").strip()
    full = _FULL_DATE_RE.match(text)
    if full:
        return f"{int(full.group(2)):02d}-{int(full.group(3)):02d}"
    partial = _PARTIAL_DATE_RE.match(text)
    if partial:
        return f"{int(partial.group(1)):02d}-{int(partial.group(2)):02d}"
    return ""


def make_dedupe_key(page_index: int, detected_date: str | None, text: str) -> str:
    """Structural identity of a fragment, robust to overlap re-transcription.

    The 1-page overlap sends each boundary page to the model twice, and it reads
    handwriting (especially proper nouns) slightly differently each pass — so
    text-prefix matching is unreliable. A dated entry is instead identified by
    ``(page_index, month-day)``: two fragments on the same page with the same
    date are the same entry. Undated fragments (rare after the continuation-tail
    drop) fall back to a text prefix, since they have no date to key on.
    """
    month_day = _month_day(detected_date)
    if month_day:
        return f"{page_index}|{month_day}"
    return f"{page_index}|{_normalize_prefix(text)}"


# --- Year resolution ---------------------------------------------------------
#
# The model returns detected_date as full (YYYY-MM-DD) only when a year is
# actually written, else partial (MM-DD), else null. Since a wrong year silently
# collides on entry_date, we resolve years DETERMINISTICALLY here rather than
# letting the model guess: carry the year forward from the last full date, roll
# it over when month/day goes backward (Dec -> Jan), and seed the run from the
# batch's default_year before any full date appears.

_FULL_DATE_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})$")
_PARTIAL_DATE_RE = re.compile(r"^(\d{1,2})-(\d{1,2})$")
# A year rollover is only credible when the previous partial date sits late in
# the year and the new one sits early — a real Dec->Jan wrap, not a stray step.
_ROLLOVER_MIN_PREV_MONTH = 6
_ROLLOVER_MAX_NEW_MONTH = 6


def _parse_detected(value: str | None) -> tuple | None:
    """Return ('full', y, m, d) | ('partial', m, d) | None, validating ranges."""
    text = (value or "").strip()
    full = _FULL_DATE_RE.match(text)
    if full:
        y, m, d = int(full.group(1)), int(full.group(2)), int(full.group(3))
        return ("full", y, m, d) if 1 <= m <= 12 and 1 <= d <= 31 else None
    partial = _PARTIAL_DATE_RE.match(text)
    if partial:
        m, d = int(partial.group(1)), int(partial.group(2))
        return ("partial", m, d) if 1 <= m <= 12 and 1 <= d <= 31 else None
    return None


def resolve_fragment_years(fragments: list[dict], default_year: int | None) -> dict[int, dict]:
    """Resolve each dated fragment to a full YYYY-MM-DD, in page order.

    Returns {fragment_id: {resolved_date, year_inferred, rollover, resolvable}}.
    Undated fragments (detected_date null / unparseable) are omitted. A partial
    date with no year available yet (no prior full date and no default_year) is
    included with ``resolvable=False`` so the caller can surface it for review
    instead of committing a wrong date.
    """
    result: dict[int, dict] = {}
    current_year = default_year
    prev_md: tuple[int, int] | None = None

    for fragment in sorted(fragments, key=lambda f: (f.get("page_index", 0), f.get("id", 0))):
        fid = int(fragment["id"])
        parsed = _parse_detected(fragment.get("detected_date"))
        if parsed is None:
            # Backstop for older fragments (and any the model under-filled): parse
            # the raw heading stored in date_text (e.g. "Feb 24th" -> 02-24).
            parsed = _parse_detected(_date_from_heading(str(fragment.get("date_text") or "")))
        if parsed is None:
            continue
        if parsed[0] == "full":
            _, year, month, day = parsed
            current_year = year
            prev_md = (month, day)
            result[fid] = {
                "resolved_date": f"{year:04d}-{month:02d}-{day:02d}",
                "year_inferred": False, "rollover": False, "resolvable": True,
            }
        else:
            _, month, day = parsed
            if current_year is None:
                result[fid] = {"resolved_date": None, "year_inferred": False,
                               "rollover": False, "resolvable": False}
                continue
            # Roll the year forward only at a plausible Dec->Jan boundary: the
            # previous entry is late in the year AND this one is early. A small
            # backward step (an out-of-order or misread date) must NOT bump the
            # year, since that would silently poison every later fragment.
            rollover = (
                prev_md is not None
                and (month, day) < prev_md
                and prev_md[0] >= _ROLLOVER_MIN_PREV_MONTH
                and month <= _ROLLOVER_MAX_NEW_MONTH
            )
            if rollover:
                current_year += 1
            prev_md = (month, day)
            result[fid] = {
                "resolved_date": f"{current_year:04d}-{month:02d}-{day:02d}",
                "year_inferred": True, "rollover": rollover, "resolvable": True,
            }
    return result


# --- Per-group extraction + staging ------------------------------------------


def extract_and_store_group(
    batch_id: int,
    source_file: str,
    group: PageGroup,
    page_loader: Callable[[int], tuple[str, str]],
    scan_target: str = "journal",
    *,
    model: str | None = None,
) -> GroupResult:
    """Extract one page group and stage deduped fragments.

    ``page_loader(index)`` returns ``(base64, media_type)`` for an absolute page
    index. Idempotent: if this (source_file, page_range) was already extracted,
    returns immediately without calling the model. Records per-call token usage
    and estimated cost to the ledger so daily-token / dollar caps can be enforced
    by the caller. Failures are isolated: the group is marked failed (for retry)
    and returned as ``failed``, never crashing the surrounding run.
    """
    if group_already_extracted(source_file, group.page_range):
        return GroupResult(page_range=group.page_range, skipped=True)

    used_model = model or OPENAI_JOURNAL_VISION_MODEL
    try:
        pages: list[str] = []
        media_types: list[str] = []
        for absolute_index in group.page_indices:
            b64, media_type = page_loader(absolute_index)
            pages.append(b64)
            media_types.append(media_type)

        result = extract_journal_entries(pages, media_types, scan_target, model=used_model)
    except Exception as exc:
        logger.exception("Group %s failed: %s", group.page_range, exc)
        record_group_failure(batch_id, source_file, group.page_range, str(exc))
        return GroupResult(page_range=group.page_range, failed=True, error=str(exc))

    cost = record_usage(result.usage)

    confidence = result.response.confidence
    inserted: list[int] = []
    for entry in result.entries:
        # Map the within-group start_page back to the absolute PDF page index.
        local = max(0, min(entry.start_page, len(group.page_indices) - 1))
        absolute_page = group.page_indices[local]
        detected_date = (entry.detected_date or None)
        # An undated entry that begins on a leading overlap page is the tail of an
        # entry the *previous* group already captured whole (with its date). Drop
        # it so it doesn't surface as a spurious "undated" duplicate.
        if detected_date is None and local < group.overlap_lead:
            logger.info("Group %s: dropped overlap continuation tail on page %d",
                        group.page_range, absolute_page)
            continue
        fragment_id = insert_fragment(
            batch_id=batch_id,
            page_index=absolute_page,
            detected_date=detected_date,
            date_detected=bool(detected_date),
            text_markdown=entry.text,
            confidence=confidence,
            dedupe_key=make_dedupe_key(absolute_page, detected_date, entry.text),
            source_model=result.usage.model,
            date_text=entry.date_text,
        )
        if fragment_id is not None:
            inserted.append(fragment_id)

    record_group(batch_id, source_file, group.page_range, len(inserted), result.usage.total_tokens)
    return GroupResult(
        page_range=group.page_range,
        fragments_inserted=inserted,
        total_tokens=result.usage.total_tokens,
        cost_usd=cost,
    )


# --- Deletion / force re-import ----------------------------------------------


def delete_import_batch(batch_id: int) -> bool:
    """Fully remove a batch: fragments, group records, cached pages, and the row."""
    if get_batch(batch_id) is None:
        return False
    delete_batch_pages(batch_id)
    delete_batch_row(batch_id)  # also clears its fragments + groups
    return True


def reset_batch_for_force(batch_id: int) -> None:
    """Prepare a batch for a fresh re-extraction: drop its not-yet-committed
    fragments and group-completion records so every group re-runs. Committed
    fragments and cached page images are kept (pages are reused, not re-rastered).

    Groups are cleared by ``source_file`` (not just batch_id): idempotency keys on
    (source_file, page_range), so a stale group row left under a prior batch of the
    same file would otherwise survive the reset and get skipped as already-done.
    """
    delete_batch_fragments(batch_id, statuses=("pending", "reviewed"))
    batch = get_batch(batch_id)
    if batch and batch.get("source_file"):
        delete_groups_for_source(str(batch["source_file"]))
    else:
        delete_batch_groups(batch_id)


# --- Triage: re-run low-confidence fragments on a stronger model -------------


def reextract_low_confidence_fragments(
    batch_id: int,
    *,
    model: str,
    threshold: str | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    """Re-transcribe uncertain fragments on a stronger model, using cached pages.

    The triage endgame: after a cheap bulk pass, re-run only fragments at/below
    ``threshold`` confidence (default JOURNAL_IMPORT_LOW_CONFIDENCE) on ``model``,
    reading each fragment's source page image from the cache (no re-rasterizing).
    Updates the fragment's text/confidence in place and tags its source_model.
    Skips fragments already produced by that model or missing a cached page.
    """
    ceiling = _CONFIDENCE_RANK.get((threshold or JOURNAL_IMPORT_LOW_CONFIDENCE).lower(), 1)
    candidates = [
        fragment
        for fragment in list_fragments(batch_id)
        if fragment.get("status") in ("pending", "reviewed")
        and _CONFIDENCE_RANK.get(str(fragment.get("confidence") or "medium"), 1) <= ceiling
        and str(fragment.get("source_model") or "") != model
    ]

    upgraded = 0
    reviewed = 0
    total_cost = 0.0
    for fragment in candidates:
        page_bytes = load_page_image(batch_id, int(fragment.get("page_index") or 0))
        if page_bytes is None:
            continue  # no cached source page (e.g. legacy batch) — leave as-is
        import base64 as _b64

        result = extract_journal_entries(
            [_b64.b64encode(page_bytes).decode("ascii")],
            "image/jpeg",
            get_batch(batch_id).get("scan_target") or "journal",  # type: ignore[union-attr]
            model=model,
        )
        total_cost += record_usage(result.usage)
        reviewed += 1
        # A single-page re-run yields one (occasionally more) entries; take the
        # richest transcription for this fragment's page.
        best = max(result.entries, key=lambda e: len(e.text), default=None)
        if best is None:
            continue
        # If the fragment had no resolved date and the stronger re-run found one,
        # recover it. Never clobber a date the user (or original) already set.
        recover_date = bool(best.detected_date) and not str(fragment.get("detected_date") or "").strip()
        update_fragment(
            int(fragment["id"]),
            text_markdown=best.text,
            confidence=result.response.confidence,
            source_model=result.usage.model,
            date_text=best.date_text or None,
            detected_date=best.detected_date if recover_date else None,
            set_date=recover_date,
        )
        upgraded += 1

    return {
        "batch_id": batch_id,
        "candidates": len(candidates),
        "reviewed": reviewed,
        "upgraded": upgraded,
        "cost_usd": total_cost,
    }


# --- Anomaly detection (review triage) ---------------------------------------

_ILLEGIBLE_RE = re.compile(r"\[illegible\]", re.IGNORECASE)


def _fragment_anomalies(fragment: dict, existing_dates: set[str], resolved: dict | None) -> list[str]:
    labels: list[str] = []
    text = str(fragment.get("text_markdown") or "")
    words = max(1, len(text.split()))
    illegible = len(_ILLEGIBLE_RE.findall(text))
    if illegible >= 3 or illegible / words > 0.05:
        labels.append("illegible_heavy")
    if str(fragment.get("confidence") or "medium") == "low":
        labels.append("low_confidence")
    if resolved is None:  # no date at all (nothing parseable from detected_date/date_text)
        labels.append("undated")
    elif not resolved.get("resolvable", True):  # partial date, year not yet determinable
        labels.append("year_unresolved")  # partial date, no year available yet
    resolved_date = (resolved or {}).get("resolved_date")
    if resolved_date and resolved_date in existing_dates:
        labels.append("date_exists")
    return labels


def analyze_batch(batch_id: int, user_id: str = APP_DEFAULT_USER_ID) -> dict:
    """Per-fragment anomaly labels, resolved dates, and batch-level summary.

    Cheap heuristics so a human can spend attention where it matters: illegible-
    heavy, low-confidence, undated, unresolved-year, date-conflict, chronology
    breaks, plus the deterministic year resolution (inferred years + rollovers,
    which are the boundaries worth a glance). Runs read-only for the reviewer;
    commit re-runs the same resolver to actually write.
    """
    batch = get_batch(batch_id) or {}
    default_year = batch.get("default_year")
    fragments = [f for f in list_fragments(batch_id) if f.get("status") in ("pending", "reviewed")]
    ordered = sorted(fragments, key=lambda f: (f.get("page_index", 0), f.get("id", 0)))

    resolved = resolve_fragment_years(ordered, default_year)
    existing = set(_existing_content_dates(user_id).keys())

    per_fragment: dict[int, list[str]] = {}
    for fragment in ordered:
        fid = int(fragment["id"])
        per_fragment[fid] = _fragment_anomalies(fragment, existing, resolved.get(fid))

    # Chronology on RESOLVED dates: earlier-than-max in page order is suspicious.
    max_date_so_far = ""
    out_of_order = 0
    for fragment in ordered:
        info = resolved.get(int(fragment["id"]))
        resolved_date = info.get("resolved_date") if info else None
        if not resolved_date:
            continue
        if max_date_so_far and resolved_date < max_date_so_far:
            per_fragment[int(fragment["id"])].append("date_out_of_order")
            out_of_order += 1
        else:
            max_date_so_far = resolved_date

    summary: list[str] = []
    def _count(label: str) -> int:
        return sum(1 for labels in per_fragment.values() if label in labels)

    for label, phrase in (
        ("low_confidence", "low-confidence"),
        ("illegible_heavy", "illegible-heavy"),
        ("undated", "undated"),
        ("year_unresolved", "with an unresolvable year (set a year or default_year)"),
        ("date_exists", "already in your journal (conflict)"),
    ):
        n = _count(label)
        if n:
            summary.append(f"{n} {phrase} fragment{'s' if n != 1 else ''}")
    inferred = sum(1 for info in resolved.values() if info.get("year_inferred"))
    rollovers = sum(1 for info in resolved.values() if info.get("rollover"))
    if inferred:
        summary.append(f"{inferred} inferred year{'s' if inferred != 1 else ''}"
                       + (f" ({rollovers} rollover)" if rollovers else ""))
    if out_of_order:
        summary.append(f"{out_of_order} date{'s' if out_of_order != 1 else ''} out of chronological order")

    return {"per_fragment": per_fragment, "summary": summary, "resolved": resolved}


# --- Commit ------------------------------------------------------------------


def _content_columns_for_target(scan_target: str) -> str:
    return _TARGET_COLUMN.get(scan_target, "journal_entry")


def _existing_content_dates(user_id: str) -> dict[str, dict]:
    """Map entry_date -> row for dates that already hold user-authored content."""
    entries = list_journal_entries(user_id)
    result: dict[str, dict] = {}
    for entry_date, row in entries.items():
        has_content = any(
            str(row.get(col) or "").strip()
            for col in ("journal_entry", "accomplishments", "gratitude_entry",
                        "scripture_study", "spiritual_notes")
        ) or bool(str(row.get("photo_data_url") or "").strip())
        if has_content:
            result[entry_date] = row
    return result


def existing_dates_for_batch(batch_id: int, user_id: str = APP_DEFAULT_USER_ID) -> list[str]:
    """RESOLVED dates in this batch that already have a real journal_entries row."""
    batch = get_batch(batch_id) or {}
    fragments = [f for f in list_fragments(batch_id) if f.get("status") in ("pending", "reviewed")]
    resolved = resolve_fragment_years(fragments, batch.get("default_year"))
    frag_dates = {
        info["resolved_date"]
        for info in resolved.values()
        if info.get("resolvable") and info.get("resolved_date")
    }
    existing = _existing_content_dates(user_id)
    return sorted(d for d in frag_dates if d in existing)


def commit_batch(
    batch_id: int,
    overwrite_existing: bool = False,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    """Commit a batch's reviewed fragments into journal_entries.

    Groups fragments by resolved date, orders by page_index, concatenates the
    markdown (blank line between fragments) into ONE body per date, and writes a
    single upsert per entry_date (never same-date fragments as separate rows,
    since entry_date is the identity of journal_entries).

    Non-destructive by default: a date that already has user content is reported
    as a conflict and skipped unless ``overwrite_existing`` is set; even then,
    the entry's other columns are preserved. Undated fragments are skipped and
    reported (assign a date or merge them in review first). Idempotent:
    already-committed fragments are ignored.
    """
    batch = get_batch(batch_id)
    if batch is None:
        raise ValueError(f"batch {batch_id} not found")

    scan_target = batch.get("scan_target") or "journal"
    target_column = _content_columns_for_target(scan_target)

    fragments = [
        f for f in list_fragments(batch_id)
        if f.get("status") in ("pending", "reviewed")
    ]

    # Year-resolution pass (page order) BEFORE group-by-date. Feeds group-by-date
    # and the collision guard; it does not replace them.
    resolved = resolve_fragment_years(fragments, batch.get("default_year"))

    # Group by RESOLVED full date, preserving page order. A partial date whose
    # year couldn't be resolved is left pending and surfaced for review — never
    # committed as a partial (which would corrupt entry_date identity).
    by_date: dict[str, list[dict]] = {}
    skipped_undated: list[int] = []
    unresolved_years: list[int] = []
    for fragment in sorted(fragments, key=lambda f: (f.get("page_index", 0), f.get("id", 0))):
        fid = int(fragment["id"])
        info = resolved.get(fid)
        if info is None:  # no date at all (no detected_date, no parseable heading)
            skipped_undated.append(fid)
            continue
        if not info.get("resolvable"):  # partial date, year not yet determinable
            unresolved_years.append(fid)
            continue
        by_date.setdefault(info["resolved_date"], []).append(fragment)

    existing = _existing_content_dates(user_id)

    committed_dates: list[str] = []
    committed_fragment_ids: list[int] = []
    conflicts: list[dict] = []

    for entry_date, group_fragments in sorted(by_date.items()):
        fragment_ids = [int(f["id"]) for f in group_fragments]
        if entry_date in existing and not overwrite_existing:
            conflicts.append({"entry_date": entry_date, "fragment_ids": fragment_ids})
            continue

        body = "\n\n".join(
            str(f.get("text_markdown") or "").strip()
            for f in group_fragments
            if str(f.get("text_markdown") or "").strip()
        )

        # Preserve any existing columns; only the target column receives the scan.
        base = existing.get(entry_date, {})
        fields = {
            "journal_entry": str(base.get("journal_entry") or ""),
            "accomplishments": str(base.get("accomplishments") or ""),
            "gratitude_entry": str(base.get("gratitude_entry") or ""),
            "scripture_study": str(base.get("scripture_study") or ""),
            "spiritual_notes": str(base.get("spiritual_notes") or ""),
        }
        fields[target_column] = body

        upsert_journal_entry(
            entry_date=entry_date,
            journal_entry=fields["journal_entry"],
            accomplishments=fields["accomplishments"],
            gratitude_entry=fields["gratitude_entry"],
            scripture_study=fields["scripture_study"],
            spiritual_notes=fields["spiritual_notes"],
            study_links_json=str(base.get("study_links_json") or "[]"),
            photo_data_url=base.get("photo_data_url"),
            calendar_items_json=str(base.get("calendar_items_json") or "[]"),
            user_id=user_id,
        )
        # Record which committed fragments had their year supplied by the resolver.
        for fid in fragment_ids:
            if resolved.get(fid, {}).get("year_inferred"):
                update_fragment(fid, year_inferred=True)
        set_fragments_status(fragment_ids, "committed")
        committed_dates.append(entry_date)
        committed_fragment_ids.extend(fragment_ids)

    # The batch is fully committed only when nothing remains pending/conflicted.
    remaining = [f for f in list_fragments(batch_id) if f.get("status") in ("pending", "reviewed")]
    if not remaining:
        set_batch_status(batch_id, "committed")

    return {
        "batch_id": batch_id,
        "committed_dates": committed_dates,
        "committed_fragment_ids": committed_fragment_ids,
        "conflicts": conflicts,
        "skipped_undated": skipped_undated,
        "unresolved_years": unresolved_years,
    }

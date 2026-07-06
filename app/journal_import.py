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
    JOURNAL_IMPORT_OVERLAP_PAGES,
    OPENAI_JOURNAL_VISION_MODEL,
)
from app.journal_scan import extract_journal_entries
from app.journal_import_store import (
    get_batch,
    group_already_extracted,
    insert_fragment,
    list_fragments,
    record_group,
    record_token_usage,
    set_batch_status,
    set_fragments_status,
)
from app.journal_store import list_journal_entries, upsert_journal_entry

logger = logging.getLogger(__name__)

# Column in journal_entries that receives the transcribed markdown, per target.
_TARGET_COLUMN = {"journal": "journal_entry", "scripture": "scripture_study"}
_DEDUPE_PREFIX_CHARS = 40


@dataclass
class PageGroup:
    page_indices: list[int]
    page_range: str  # absolute-index label, e.g. "0-3" — idempotency key


@dataclass
class GroupResult:
    page_range: str
    skipped: bool = False
    fragments_inserted: list[int] = field(default_factory=list)
    total_tokens: int = 0


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
    while start < page_count:
        end = min(start + batch, page_count)
        indices = list(range(start, end))
        groups.append(PageGroup(page_indices=indices, page_range=f"{start}-{end - 1}"))
        if end >= page_count:
            break
        start += step
    return groups


def count_groups(page_count: int, batch_pages: int | None = None, overlap_pages: int | None = None) -> int:
    return len(plan_groups(page_count, batch_pages, overlap_pages))


# --- Dedupe ------------------------------------------------------------------


def _normalize_prefix(text: str) -> str:
    collapsed = re.sub(r"\s+", " ", (text or "")).strip().lower()
    return collapsed[:_DEDUPE_PREFIX_CHARS]


def make_dedupe_key(detected_date: str | None, text: str) -> str:
    return f"{(detected_date or '').strip()}|{_normalize_prefix(text)}"


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
    to the ledger so a daily cap can be enforced by the caller.
    """
    if group_already_extracted(source_file, group.page_range):
        return GroupResult(page_range=group.page_range, skipped=True)

    pages: list[str] = []
    media_types: list[str] = []
    for absolute_index in group.page_indices:
        b64, media_type = page_loader(absolute_index)
        pages.append(b64)
        media_types.append(media_type)

    result = extract_journal_entries(
        pages, media_types, scan_target, model=model or OPENAI_JOURNAL_VISION_MODEL
    )

    usage = result.usage
    today = date_cls.today().isoformat()
    record_token_usage(today, usage.input_tokens, usage.output_tokens, usage.total_tokens)

    confidence = result.response.confidence
    inserted: list[int] = []
    for entry in result.entries:
        # Map the within-group start_page back to the absolute PDF page index.
        local = max(0, min(entry.start_page, len(group.page_indices) - 1))
        absolute_page = group.page_indices[local]
        detected_date = (entry.detected_date or None)
        fragment_id = insert_fragment(
            batch_id=batch_id,
            page_index=absolute_page,
            detected_date=detected_date,
            date_detected=bool(detected_date),
            text_markdown=entry.text,
            confidence=confidence,
            dedupe_key=make_dedupe_key(detected_date, entry.text),
        )
        if fragment_id is not None:
            inserted.append(fragment_id)

    record_group(batch_id, source_file, group.page_range, len(inserted), usage.total_tokens)
    return GroupResult(
        page_range=group.page_range,
        skipped=False,
        fragments_inserted=inserted,
        total_tokens=usage.total_tokens,
    )


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
    """Resolved dates in this batch that already have a real journal_entries row."""
    fragments = list_fragments(batch_id)
    frag_dates = {
        str(f["detected_date"]).strip()
        for f in fragments
        if f.get("detected_date") and f.get("status") in ("pending", "reviewed")
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

    # Group by resolved (non-null) date, preserving page order.
    by_date: dict[str, list[dict]] = {}
    skipped_undated: list[int] = []
    for fragment in sorted(fragments, key=lambda f: (f.get("page_index", 0), f.get("id", 0))):
        resolved = str(fragment.get("detected_date") or "").strip()
        if not resolved:
            skipped_undated.append(int(fragment["id"]))
            continue
        by_date.setdefault(resolved, []).append(fragment)

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
    }

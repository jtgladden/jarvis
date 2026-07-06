"""Batch-digitize a paper-journal archive: PDF(s) -> staged fragments.

Rasterizes each PDF's pages, feeds contiguous page groups (with a 1-page overlap)
to the vision extractor, and stages deduped, dated markdown fragments in
data/journal_import.db for later review + commit via the /journal/review UI.
Nothing is written to the real journal store here — that's the commit step.

Detached-friendly, resumable, non-destructive:
- Resumable: extraction is keyed on (source_file, page_range); a re-run skips
  already-extracted groups and continues where it left off. Safe to kill/restart.
- Daily token cap: the free/low tier that includes gpt-5.4 is ~250k tokens/day.
  The processor records per-call usage (Responses API returns it) and stops when
  the day's cap is reached, so a long run drips across days instead of spilling
  into billed rates. Re-run tomorrow to continue.
- Dry-run: --dry-run reports how many PDFs/pages/groups would be processed and
  the day's remaining token budget, without calling the model.

Usage (from repo root):
  python scripts/import_journal_pdfs.py /path/to/journals --scan-target journal
  python scripts/import_journal_pdfs.py one.pdf --dry-run
  nohup python scripts/import_journal_pdfs.py /nas/journals \
      --log data/journal_import.log >> data/journal_import.log 2>&1 & disown

Future (not built): triage the bulk on the cheap high-quota model
(OPENAI_JOURNAL_VISION_TRIAGE_MODEL) and re-run only low-confidence fragments on
the premium model. Fragments already carry `confidence` and `status`, so that
path is open without schema changes.
"""

from __future__ import annotations

import argparse
import base64
import logging
import os
import sys
from datetime import date as date_cls

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.config import (  # noqa: E402
    JOURNAL_IMPORT_BATCH_PAGES,
    JOURNAL_IMPORT_DAILY_TOKEN_CAP,
    JOURNAL_IMPORT_OVERLAP_PAGES,
    JOURNAL_IMPORT_RASTER_DPI,
    OPENAI_JOURNAL_VISION_MODEL,
)
from app.journal_import import extract_and_store_group, plan_groups  # noqa: E402
from app.journal_import_store import (  # noqa: E402
    get_tokens_used_today,
    get_or_create_batch,
    init_journal_import_store,
    set_batch_status,
)

logger = logging.getLogger("journal_import")


class DailyTokenCapReached(Exception):
    """Raised to stop the run cleanly when the day's token cap is hit."""


def _configure_logging(log_path: str | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_path:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
        handlers.append(logging.FileHandler(log_path, encoding="utf-8"))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=handlers,
    )


def _discover_pdfs(target: str) -> list[str]:
    if os.path.isfile(target):
        return [target] if target.lower().endswith(".pdf") else []
    if os.path.isdir(target):
        found: list[str] = []
        for root, _dirs, files in os.walk(target):
            for name in sorted(files):
                if name.lower().endswith(".pdf"):
                    found.append(os.path.join(root, name))
        return sorted(found)
    return []


def _open_pdf(path: str):
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise SystemExit(
            "PyMuPDF is required (pip install PyMuPDF). Original error: %s" % exc
        )
    return fitz.open(path)


def _make_page_loader(document, dpi: int):
    """Return a loader that rasterizes a single PDF page to (base64_jpeg, media_type)."""

    def load(page_index: int) -> tuple[str, str]:
        page = document.load_page(page_index)
        pixmap = page.get_pixmap(dpi=dpi)
        image_bytes = pixmap.tobytes("jpeg")
        return base64.b64encode(image_bytes).decode("ascii"), "image/jpeg"

    return load


def _remaining_budget(cap: int) -> int:
    if cap <= 0:
        return sys.maxsize
    used = get_tokens_used_today(date_cls.today().isoformat())
    return max(0, cap - used)


def process_pdf(
    path: str,
    scan_target: str,
    *,
    batch_pages: int,
    overlap_pages: int,
    dpi: int,
    daily_cap: int,
    model: str,
) -> dict:
    document = _open_pdf(path)
    page_count = document.page_count
    source_file = os.path.abspath(path)
    batch = get_or_create_batch(source_file, page_count, scan_target, model)
    batch_id = int(batch["id"])
    groups = plan_groups(page_count, batch_pages, overlap_pages)
    loader = _make_page_loader(document, dpi)

    fragments_added = 0
    groups_processed = 0
    groups_skipped = 0
    tokens_used = 0
    try:
        set_batch_status(batch_id, "pending")
        for group in groups:
            if _remaining_budget(daily_cap) <= 0:
                logger.warning(
                    "Daily token cap (%d) reached — stopping before %s pages %s. "
                    "Re-run to resume.", daily_cap, os.path.basename(path), group.page_range,
                )
                raise DailyTokenCapReached()

            result = extract_and_store_group(
                batch_id, source_file, group, loader, scan_target, model=model
            )
            if result.skipped:
                groups_skipped += 1
                continue
            groups_processed += 1
            fragments_added += len(result.fragments_inserted)
            tokens_used += result.total_tokens
            logger.info(
                "%s pages %s -> %d fragment(s), %d tokens (day used %d/%s)",
                os.path.basename(path), group.page_range,
                len(result.fragments_inserted), result.total_tokens,
                get_tokens_used_today(date_cls.today().isoformat()),
                daily_cap or "∞",
            )
        set_batch_status(batch_id, "extracted")
    except DailyTokenCapReached:
        set_batch_status(batch_id, "pending")  # leave resumable
        raise
    except Exception as exc:  # pragma: no cover - operational safety
        logger.exception("Extraction failed for %s: %s", path, exc)
        set_batch_status(batch_id, "error", error=str(exc))
    finally:
        document.close()

    return {
        "path": path,
        "batch_id": batch_id,
        "page_count": page_count,
        "groups_processed": groups_processed,
        "groups_skipped": groups_skipped,
        "fragments_added": fragments_added,
        "tokens_used": tokens_used,
    }


def run_dry_run(pdfs: list[str], batch_pages: int, overlap_pages: int, daily_cap: int) -> None:
    total_pages = 0
    total_groups = 0
    print(f"[dry-run] {len(pdfs)} PDF(s) found")
    for path in pdfs:
        document = _open_pdf(path)
        try:
            page_count = document.page_count
        finally:
            document.close()
        groups = len(plan_groups(page_count, batch_pages, overlap_pages))
        total_pages += page_count
        total_groups += groups
        print(f"[dry-run]   {os.path.basename(path)}: {page_count} pages -> {groups} group(s)")
    remaining = _remaining_budget(daily_cap)
    print(
        f"[dry-run] totals: {total_pages} pages, {total_groups} group(s) "
        f"(~{total_groups} model calls). Would NOT call the model."
    )
    print(
        f"[dry-run] token budget today: {'unlimited' if daily_cap <= 0 else remaining} "
        f"remaining of {daily_cap or '∞'}"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Batch-digitize journal PDFs into staged fragments.")
    parser.add_argument("target", help="A single PDF or a directory of PDFs (searched recursively).")
    parser.add_argument("--scan-target", choices=["journal", "scripture"], default="journal")
    parser.add_argument("--model", default=OPENAI_JOURNAL_VISION_MODEL, help="Vision model override.")
    parser.add_argument("--batch-pages", type=int, default=JOURNAL_IMPORT_BATCH_PAGES)
    parser.add_argument("--overlap-pages", type=int, default=JOURNAL_IMPORT_OVERLAP_PAGES)
    parser.add_argument("--dpi", type=int, default=JOURNAL_IMPORT_RASTER_DPI)
    parser.add_argument(
        "--daily-token-cap", type=int, default=JOURNAL_IMPORT_DAILY_TOKEN_CAP,
        help="Stop when the day's token usage reaches this. 0 disables.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Count work without calling the model.")
    parser.add_argument("--log", default=None, help="Also append logs to this file.")
    args = parser.parse_args(argv)

    _configure_logging(args.log)

    pdfs = _discover_pdfs(args.target)
    if not pdfs:
        print(f"No PDF files found at {args.target!r}.")
        return 1

    if args.dry_run:
        run_dry_run(pdfs, args.batch_pages, args.overlap_pages, args.daily_token_cap)
        return 0

    init_journal_import_store()
    logger.info(
        "Starting import: %d PDF(s), model=%s, batch=%d overlap=%d dpi=%d cap=%s",
        len(pdfs), args.model, args.batch_pages, args.overlap_pages, args.dpi,
        args.daily_token_cap or "∞",
    )

    summaries: list[dict] = []
    stopped_for_cap = False
    dates_seen: set[str] = set()
    try:
        for path in pdfs:
            summary = process_pdf(
                path, args.scan_target,
                batch_pages=args.batch_pages,
                overlap_pages=args.overlap_pages,
                dpi=args.dpi,
                daily_cap=args.daily_token_cap,
                model=args.model,
            )
            summaries.append(summary)
    except DailyTokenCapReached:
        stopped_for_cap = True

    total_fragments = sum(s["fragments_added"] for s in summaries)
    total_pages = sum(s["page_count"] for s in summaries)
    total_tokens = sum(s["tokens_used"] for s in summaries)
    logger.info(
        "Done. batches=%d pages=%d fragments=%d tokens=%d%s",
        len(summaries), total_pages, total_fragments, total_tokens,
        " (STOPPED at daily token cap — re-run to resume)" if stopped_for_cap else "",
    )
    print("\n=== Import summary ===")
    print(f"PDFs processed:      {len(summaries)}")
    print(f"Pages:               {total_pages}")
    print(f"Fragments staged:    {total_fragments}")
    print(f"Tokens used (run):   {total_tokens}")
    print(f"Tokens used (today): {get_tokens_used_today(date_cls.today().isoformat())}")
    if stopped_for_cap:
        print("NOTE: stopped at the daily token cap. Re-run tomorrow to resume where it left off.")
    print("Review + commit at /journal/review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

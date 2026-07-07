"""Batch-digitize a paper-journal archive: PDF(s) -> staged fragments.

Rasterizes each PDF's pages (preprocessed + cached for review thumbnails), feeds
contiguous page groups (with a 1-page overlap) to the vision extractor, and
stages deduped, dated markdown fragments in data/journal_import.db for later
review + commit via /journal/review. Nothing touches the real journal store here.

Detached-friendly, resumable, non-destructive, budget-aware:
- Resumable: extraction is keyed on (source_file, page_range). A re-run skips
  completed groups and retries failed ones. Safe to kill/restart.
- Budget: stops before exceeding a USD budget (--budget-usd, est. from token
  usage) AND/OR a daily token cap. Re-run later to resume.
- Triage (cost): --triage runs the bulk on the cheap high-quota model; then
  --upgrade-low-confidence re-runs only low-confidence fragments on the premium
  model using cached pages. For a ~300-page archive this is the difference
  between weeks of free-tier dripping and a few dollars in an afternoon.
- Dry-run: --dry-run reports pages/groups/est. cost without calling the model.

Usage (from repo root):
  python scripts/import_journal_pdfs.py /path/to/journals --triage
  python scripts/import_journal_pdfs.py one.pdf --dry-run
  python scripts/import_journal_pdfs.py /nas/journals --upgrade-low-confidence
  python scripts/import_journal_pdfs.py /nas/journals --retry-failed
  nohup python scripts/import_journal_pdfs.py /nas/journals \
      --triage --budget-usd 10 --log data/journal_import.log \
      >> data/journal_import.log 2>&1 & disown
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
    JOURNAL_IMPORT_BUDGET_USD,
    JOURNAL_IMPORT_DAILY_TOKEN_CAP,
    JOURNAL_IMPORT_OVERLAP_PAGES,
    JOURNAL_IMPORT_RASTER_DPI,
    OPENAI_JOURNAL_VISION_MODEL,
    OPENAI_JOURNAL_VISION_TRIAGE_MODEL,
    estimate_vision_cost_usd,
)
from app.journal_import import (  # noqa: E402
    extract_and_store_group,
    plan_groups,
    reextract_low_confidence_fragments,
    reset_batch_for_force,
)
from app.journal_ingest import (  # noqa: E402
    has_page_image,
    load_page_image,
    preprocess_jpeg,
    save_page_image,
)
from app.journal_import_store import (  # noqa: E402
    get_or_create_batch,
    get_total_spend_usd,
    get_tokens_used_today,
    init_journal_import_store,
    list_group_statuses,
    set_batch_status,
)

logger = logging.getLogger("journal_import")

# Rough per-page input tokens (from observed original-detail scans) for dry-run
# cost estimates only.
_EST_TOKENS_PER_PAGE = 12_000


class BudgetReached(Exception):
    """Raised to stop the run cleanly when a spend/token cap is hit."""


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
        raise SystemExit("PyMuPDF is required (pip install PyMuPDF). Error: %s" % exc)
    return fitz.open(path)


def _make_page_loader(document, batch_id: int, dpi: int):
    """Rasterize+preprocess a single PDF page on demand and cache it to disk.

    Cached pages are reused (no re-rasterizing) and power review thumbnails.
    """
    def load(page_index: int) -> tuple[str, str]:
        cached = load_page_image(batch_id, page_index) if has_page_image(batch_id, page_index) else None
        if cached is None:
            pixmap = document.load_page(page_index).get_pixmap(dpi=dpi)
            cached = preprocess_jpeg(pixmap.tobytes("jpeg"))
            save_page_image(batch_id, page_index, cached)
        return base64.b64encode(cached).decode("ascii"), "image/jpeg"

    return load


def _budget_blocked(daily_cap: int, budget_usd: float) -> str | None:
    if daily_cap > 0 and get_tokens_used_today(date_cls.today().isoformat()) >= daily_cap:
        return f"daily token cap ({daily_cap})"
    if budget_usd > 0 and get_total_spend_usd() >= budget_usd:
        return f"USD budget (${budget_usd:.2f})"
    return None


def process_pdf(
    path: str,
    scan_target: str,
    *,
    model: str,
    batch_pages: int,
    overlap_pages: int,
    dpi: int,
    daily_cap: int,
    budget_usd: float,
    retry_failed: bool,
    force: bool = False,
    default_year: int | None = None,
) -> dict:
    document = _open_pdf(path)
    page_count = document.page_count
    source_file = os.path.abspath(path)
    batch = get_or_create_batch(source_file, page_count, scan_target, model, default_year=default_year)
    batch_id = int(batch["id"])
    if force:
        # Fresh re-extraction: drop prior pending/reviewed fragments + group
        # records so every group re-runs (on `model`), with full multi-page context.
        reset_batch_for_force(batch_id)
        logger.info("Force: reset batch %d (%s) for re-extraction on %s", batch_id, os.path.basename(path), model)
    groups = plan_groups(page_count, batch_pages, overlap_pages)
    loader = _make_page_loader(document, batch_id, dpi)

    only_ranges: set[str] | None = None
    if retry_failed and not force:  # force already cleared group records
        only_ranges = {g["page_range"] for g in list_group_statuses(batch_id) if g.get("status") == "failed"}

    fragments_added = groups_processed = groups_skipped = groups_failed = 0
    tokens_used = 0
    try:
        set_batch_status(batch_id, "pending")
        for group in groups:
            if only_ranges is not None and group.page_range not in only_ranges:
                continue
            blocker = _budget_blocked(daily_cap, budget_usd)
            if blocker:
                logger.warning(
                    "%s reached before %s pages %s — stopping (resumable).",
                    blocker, os.path.basename(path), group.page_range,
                )
                raise BudgetReached()

            result = extract_and_store_group(batch_id, source_file, group, loader, scan_target, model=model)
            if result.skipped:
                groups_skipped += 1
                continue
            if result.failed:
                groups_failed += 1
                logger.error("%s pages %s FAILED: %s", os.path.basename(path), group.page_range, result.error)
                continue
            groups_processed += 1
            fragments_added += len(result.fragments_inserted)
            tokens_used += result.total_tokens
            logger.info(
                "%s pages %s -> %d fragment(s), %d tokens, $%.4f (spend $%.2f)",
                os.path.basename(path), group.page_range, len(result.fragments_inserted),
                result.total_tokens, result.cost_usd, get_total_spend_usd(),
            )
        set_batch_status(batch_id, "error" if groups_failed else "extracted")
    except BudgetReached:
        set_batch_status(batch_id, "pending")  # leave resumable
        raise
    finally:
        document.close()

    return {
        "path": path, "batch_id": batch_id, "page_count": page_count,
        "groups_processed": groups_processed, "groups_skipped": groups_skipped,
        "groups_failed": groups_failed, "fragments_added": fragments_added,
        "tokens_used": tokens_used,
    }


def run_dry_run(pdfs: list[str], batch_pages: int, overlap_pages: int, model: str, budget_usd: float) -> None:
    total_pages = total_groups = total_page_images = 0
    print(f"[dry-run] {len(pdfs)} PDF(s) found")
    for path in pdfs:
        document = _open_pdf(path)
        try:
            page_count = document.page_count
        finally:
            document.close()
        groups = plan_groups(page_count, batch_pages, overlap_pages)
        page_images = sum(len(g.page_indices) for g in groups)  # includes overlap re-reads
        total_pages += page_count
        total_groups += len(groups)
        total_page_images += page_images
        print(f"[dry-run]   {os.path.basename(path)}: {page_count} pages -> {len(groups)} group(s)")
    est_tokens = total_page_images * _EST_TOKENS_PER_PAGE
    est_cost = estimate_vision_cost_usd(model, est_tokens, int(est_tokens * 0.02))
    print(
        f"[dry-run] totals: {total_pages} pages, {total_groups} group(s), "
        f"~{total_page_images} page-images (incl. overlap)."
    )
    print(f"[dry-run] est. ~{est_tokens:,} input tokens, ~${est_cost:.2f} on {model} (budget ${budget_usd:.2f}).")
    print(f"[dry-run] already spent this account: ${get_total_spend_usd():.2f}. Would NOT call the model.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Batch-digitize journal PDFs into staged fragments.")
    parser.add_argument("target", help="A single PDF or a directory of PDFs (searched recursively).")
    parser.add_argument("--scan-target", choices=["journal", "scripture"], default="journal")
    parser.add_argument("--default-year", type=int, default=None,
                        help="Year for this book, used to resolve partial (MM-DD) dates that appear "
                             "before any full date. Rollover (Dec->Jan) is handled automatically.")
    parser.add_argument("--model", default=None, help="Vision model override (defaults to premium, or mini with --triage).")
    parser.add_argument("--triage", action="store_true", help="Run the bulk pass on the cheap high-quota model.")
    parser.add_argument("--upgrade-low-confidence", action="store_true",
                        help="After the bulk pass, re-run fragments up to --upgrade-threshold on the premium model.")
    parser.add_argument("--upgrade-threshold", choices=["low", "medium", "high"], default=None,
                        help="Confidence ceiling for --upgrade-low-confidence. 'high' re-runs EVERYTHING "
                             "not already produced by the premium model. Default: medium.")
    parser.add_argument("--retry-failed", action="store_true", help="Only re-run groups previously marked failed.")
    parser.add_argument("--force", action="store_true",
                        help="Re-extract from scratch: drop prior pending/reviewed fragments and re-run every "
                             "group (full multi-page context) on the chosen model. Committed entries are kept.")
    parser.add_argument("--batch-pages", type=int, default=JOURNAL_IMPORT_BATCH_PAGES)
    parser.add_argument("--overlap-pages", type=int, default=JOURNAL_IMPORT_OVERLAP_PAGES)
    parser.add_argument("--dpi", type=int, default=JOURNAL_IMPORT_RASTER_DPI)
    parser.add_argument("--daily-token-cap", type=int, default=JOURNAL_IMPORT_DAILY_TOKEN_CAP,
                        help="Stop when the day's token usage reaches this. 0 disables.")
    parser.add_argument("--budget-usd", type=float, default=JOURNAL_IMPORT_BUDGET_USD,
                        help="Stop when estimated spend reaches this. 0 disables.")
    parser.add_argument("--dry-run", action="store_true", help="Count work + estimate cost without calling the model.")
    parser.add_argument("--log", default=None, help="Also append logs to this file.")
    args = parser.parse_args(argv)

    _configure_logging(args.log)

    bulk_model = args.model or (OPENAI_JOURNAL_VISION_TRIAGE_MODEL if args.triage else OPENAI_JOURNAL_VISION_MODEL)

    pdfs = _discover_pdfs(args.target)
    if not pdfs:
        print(f"No PDF files found at {args.target!r}.")
        return 1

    if args.dry_run:
        run_dry_run(pdfs, args.batch_pages, args.overlap_pages, bulk_model, args.budget_usd)
        return 0

    init_journal_import_store()
    logger.info(
        "Import start: %d PDF(s), bulk_model=%s, batch=%d overlap=%d dpi=%d daily_cap=%s budget=$%.2f%s",
        len(pdfs), bulk_model, args.batch_pages, args.overlap_pages, args.dpi,
        args.daily_token_cap or "∞", args.budget_usd,
        " [retry-failed]" if args.retry_failed else "",
    )

    summaries: list[dict] = []
    stopped = False
    skipped_files: list[str] = []
    try:
        import fitz  # PyMuPDF (already required; imported for its exception types)
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise SystemExit("PyMuPDF is required (pip install PyMuPDF). Error: %s" % exc)
    try:
        for path in pdfs:
            try:
                if os.path.getsize(path) == 0:
                    logger.warning("Skipping empty PDF (0 bytes): %s", path)
                    skipped_files.append(path)
                    continue
                summaries.append(process_pdf(
                    path, args.scan_target, model=bulk_model,
                    batch_pages=args.batch_pages, overlap_pages=args.overlap_pages, dpi=args.dpi,
                    daily_cap=args.daily_token_cap, budget_usd=args.budget_usd, retry_failed=args.retry_failed,
                    force=args.force, default_year=args.default_year,
                ))
            except fitz.FileDataError as exc:
                logger.warning("Skipping unreadable/corrupt PDF %s: %s", path, exc)
                skipped_files.append(path)
    except BudgetReached:
        stopped = True

    # Optional triage endgame: upgrade low-confidence fragments on the premium model.
    upgraded = 0
    if args.upgrade_low_confidence and not stopped:
        for summary in summaries:
            if _budget_blocked(args.daily_token_cap, args.budget_usd):
                stopped = True
                break
            try:
                res = reextract_low_confidence_fragments(
                    summary["batch_id"], model=OPENAI_JOURNAL_VISION_MODEL, threshold=args.upgrade_threshold
                )
                upgraded += res["upgraded"]
                logger.info("Batch %d triage: upgraded %d/%d ($%.4f)",
                            summary["batch_id"], res["upgraded"], res["candidates"], res["cost_usd"])
            except Exception as exc:  # pragma: no cover
                logger.exception("Triage failed for batch %d: %s", summary["batch_id"], exc)

    total_fragments = sum(s["fragments_added"] for s in summaries)
    total_pages = sum(s["page_count"] for s in summaries)
    total_failed = sum(s["groups_failed"] for s in summaries)
    spent = get_total_spend_usd()

    print("\n=== Import summary ===")
    print(f"PDFs processed:      {len(summaries)}")
    if skipped_files:
        print(f"PDFs skipped:        {len(skipped_files)} (empty/corrupt)")
        for p in skipped_files:
            print(f"  - {os.path.basename(p)}")
    print(f"Pages:               {total_pages}")
    print(f"Fragments staged:    {total_fragments}")
    print(f"Failed groups:       {total_failed}{' (re-run with --retry-failed)' if total_failed else ''}")
    if args.upgrade_low_confidence:
        print(f"Low-conf upgraded:   {upgraded}")
    print(f"Spend (est, total):  ${spent:.2f} of ${args.budget_usd:.2f} budget")
    print(f"Tokens used today:   {get_tokens_used_today(date_cls.today().isoformat()):,}")
    if stopped:
        print("NOTE: stopped at a budget/token cap. Re-run to resume where it left off.")
    print("Review + commit at /journal/review.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

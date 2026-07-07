"""Vision extraction of handwritten journal / scripture pages.

One shared code path for both the live single-page phone flow and the batch
archive pipeline: give it an ordered list of page images and it returns dated,
markdown entries with per-entry provenance (the page index where each begins).

Uses the OpenAI **Responses API** (``client.responses.create``) because the
extraction model (``gpt-5.4``) is a Responses-API model, not Chat Completions.
Handwriting/scan settings follow OpenAI's document guidance: ``input_image``
detail ``"original"`` (no downscaling), high verbosity for faithful
transcription, and low reasoning effort (plain transcription is not multi-step
visual reasoning, so we don't spend reasoning tokens there).
"""

import json
import logging
import re
import time
from dataclasses import dataclass, field

from openai import (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

from app.config import (
    JOURNAL_IMPORT_MAX_RETRIES,
    JOURNAL_IMPORT_RASTER_DPI,
    JOURNAL_IMPORT_RETRY_BASE_SECONDS,
    OPENAI_API_KEY,
    OPENAI_JOURNAL_VISION_IMAGE_DETAIL,
    OPENAI_JOURNAL_VISION_MODEL,
    OPENAI_JOURNAL_VISION_TIMEOUT_SECONDS,
)
from app.schemas import JournalDayExtract, JournalImageExtractResponse

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)

# Transient failures worth retrying during a long unattended run.
_RETRYABLE_ERRORS = (RateLimitError, APITimeoutError, APIConnectionError, InternalServerError)


def _create_response_with_retry(**kwargs):
    """Call the Responses API with exponential backoff on transient errors."""
    attempts = max(1, JOURNAL_IMPORT_MAX_RETRIES)
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return client.with_options(
                timeout=OPENAI_JOURNAL_VISION_TIMEOUT_SECONDS
            ).responses.create(**kwargs)
        except _RETRYABLE_ERRORS as exc:
            last_exc = exc
            if attempt == attempts - 1:
                break
            delay = JOURNAL_IMPORT_RETRY_BASE_SECONDS * (2 ** attempt)
            logger.warning(
                "[scan] transient API error (attempt %d/%d): %s — retrying in %.0fs",
                attempt + 1, attempts, exc, delay,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc

_DATA_URL_PREFIX_RE = re.compile(r"^data:[^;]+;base64,", re.IGNORECASE)

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_NUMERIC_DATE_RE = re.compile(r"(\d{1,2})\s*[/\-]\s*(\d{1,2})(?:\s*[/\-]\s*(\d{2,4}))?")
_MONTH_NAME_RE = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?",
    re.IGNORECASE,
)


def _normalize_detected(value: str) -> str | None:
    """Accept the model's detected_date only if it's YYYY-MM-DD or MM-DD."""
    v = (value or "").strip()
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", v)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return f"{y:04d}-{mo:02d}-{d:02d}" if 1 <= mo <= 12 and 1 <= d <= 31 else None
    m = re.match(r"^(\d{1,2})-(\d{1,2})$", v)
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        return f"{mo:02d}-{d:02d}" if 1 <= mo <= 12 and 1 <= d <= 31 else None
    return None


def _date_from_heading(date_text: str) -> str | None:
    """Parse a written date heading into YYYY-MM-DD (year present) or MM-DD.

    Handles 'Feb 24th', 'Sat. March 2', 'Tuesday, May 31', 'May 31, 2024',
    '5/31', '5/31/26', '05-31-2024', etc. Deterministic backstop for when the
    model captures the heading in date_text but doesn't fill detected_date.
    """
    text = (date_text or "").strip().lower()
    if not text:
        return None
    m = _MONTH_NAME_RE.search(text)
    if m:
        month = _MONTHS.get(m.group(1)[:3].lower())
        day = int(m.group(2))
        year = m.group(3)
        if month and 1 <= day <= 31:
            if year:
                return f"{int(year):04d}-{month:02d}-{day:02d}"
            return f"{month:02d}-{day:02d}"
    m = _NUMERIC_DATE_RE.search(text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        year = m.group(3)
        if 1 <= month <= 12 and 1 <= day <= 31:
            if year:
                yi = int(year)
                yi = 2000 + yi if yi < 100 else yi
                return f"{yi:04d}-{month:02d}-{day:02d}"
            return f"{month:02d}-{day:02d}"
    return None


def _resolve_detected(detected_raw: str | None, date_text: str | None) -> str | None:
    """detected_date, normalized — falling back to parsing the written heading."""
    return _normalize_detected(detected_raw or "") or _date_from_heading(date_text or "")

_JSON_SHAPE = (
    "Return ONLY valid JSON with this exact shape:\n"
    "{\n"
    '  "entries": [\n'
    '    { "detected_date": "YYYY-MM-DD or MM-DD or null", "date_text": "date heading exactly as written, or null",'
    ' "text": "verbatim markdown body", "start_page": 0 }\n'
    "  ],\n"
    '  "confidence": "high | medium | low",\n'
    '  "notes": "any issues such as blurry image, cut-off edges, or ambiguous dates"\n'
    "}"
)

# How to handle dates. CRITICAL: never fabricate a year. A downstream resolver
# assigns years deterministically from the whole book, so guessing here would
# silently overwrite real entries (the date is the entry's identity).
_DATE_RULES = (
    "DATES — read carefully and NEVER guess a year:\n"
    "- Whenever an entry has a date heading, copy it VERBATIM into `date_text` "
    "(e.g. 'Sat. March 2', 'Feb 24', '5/31', 'Tuesday the 3rd').\n"
    "- Set `detected_date` from ONLY what is written on the page:\n"
    "    * If the year is written on the page, use full `YYYY-MM-DD`.\n"
    "    * If only month and day are written (no year), use partial `MM-DD` — "
    "do NOT add a year, do NOT infer one from other pages.\n"
    "    * If there is no date heading, use null (and do not invent a date; a "
    "page with no heading is a continuation of the previous entry).\n"
    "- Zero-pad months and days (March 2 -> '03-02'). Only include a year when "
    "you can actually read four digits of a year near that heading."
)

# Shared rules for reproducing source formatting as markdown.
_MARKDOWN_RULES = (
    "Return each entry body as MARKDOWN that reproduces the source formatting:\n"
    "- paragraph breaks as blank lines\n"
    "- lists as `-` or `1.`\n"
    "- emphasized or underlined words as *emphasis*\n"
    "- indented or set-off quotations as `>` blockquotes\n"
    "Do NOT add any formatting the page does not have. Do NOT put the date "
    "heading inside the markdown body — the date goes in detected_date / date_text."
)

# Multi-page continuation + provenance rules (shared by single and batch calls).
def _paging_rules(page_count: int) -> str:
    if page_count <= 1:
        return (
            "This is a single page. Each date heading (e.g. 'May 31', '5/31/26', "
            "'Tuesday, May 31', 'May 31st') starts a new entry. If there are no "
            "date headings, treat the whole page as one entry with detected_date "
            "null. Set start_page to 0 for every entry."
        )
    return (
        f"These are {page_count} CONSECUTIVE pages of one journal, given in order "
        "(page 0 first). A date heading (e.g. 'May 31', '5/31/26', 'Tuesday, "
        "May 31', 'May 31st') starts a new entry. If a page's top has NO date "
        "heading, it is a CONTINUATION of the previous entry — do not start a new "
        "entry and do not invent a date for it; attach its text to the still-open "
        "entry. For each entry, set start_page to the 0-based page index where "
        "that entry begins."
    )


def _journal_instructions(page_count: int) -> str:
    return "\n\n".join(
        [
            "You transcribe handwritten personal journal pages verbatim.",
            _paging_rules(page_count),
            "Transcribe every word from top to bottom within each entry. Do NOT "
            "summarize, skip, or stop early. For illegible words write [illegible]. "
            "The last word in each section must appear in the text.",
            _DATE_RULES,
            _MARKDOWN_RULES,
            _JSON_SHAPE,
        ]
    )


def _scripture_instructions(page_count: int) -> str:
    # A focused scripture-tuned prompt (verse structure + reference headings),
    # not a superset of the journal prompt.
    return "\n\n".join(
        [
            "You transcribe handwritten scripture-study pages verbatim.",
            _paging_rules(page_count),
            "Scripture-study pages are organized around scripture references and "
            "verse notes. Treat a reference/heading that starts a study block the "
            "same way you would a date heading: if the block also carries a study "
            "date, put it in detected_date; otherwise leave detected_date null. "
            "Preserve scripture references exactly as written (book, chapter, "
            "verse). Keep quoted verses as `>` blockquotes and personal notes as "
            "ordinary paragraphs. Transcribe every word; mark illegible words "
            "[illegible].",
            _DATE_RULES,
            _MARKDOWN_RULES,
            _JSON_SHAPE,
        ]
    )


def _instructions_for(scan_target: str, page_count: int) -> str:
    if scan_target == "scripture":
        return _scripture_instructions(page_count)
    return _journal_instructions(page_count)


def _strip_data_url(value: str) -> str:
    return _DATA_URL_PREFIX_RE.sub("", value or "").strip()


def _media_type_for(index: int, media_type: str | list[str]) -> str:
    if isinstance(media_type, list):
        if not media_type:
            return "image/jpeg"
        return media_type[index] if index < len(media_type) else media_type[-1]
    return media_type or "image/jpeg"


def _is_pdf(media_type: str) -> bool:
    return (media_type or "").split(";")[0].strip().lower() == "application/pdf"


def _pdf_to_image_pages(pdf_b64: str, dpi: int) -> list[str]:
    """Rasterize a base64 PDF into base64 JPEG page images (in page order).

    The vision model only accepts image MIME types, so a PDF uploaded through the
    scan endpoints (web/phone) is rasterized here — same path the batch CLI uses.
    """
    import base64 as _base64

    try:
        import fitz  # PyMuPDF
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise ValueError(
            "PDF upload requires PyMuPDF (pip install PyMuPDF)."
        ) from exc

    document = fitz.open(stream=_base64.b64decode(pdf_b64), filetype="pdf")
    try:
        pages: list[str] = []
        for index in range(document.page_count):
            pixmap = document.load_page(index).get_pixmap(dpi=dpi)
            pages.append(_base64.b64encode(pixmap.tobytes("jpeg")).decode("ascii"))
        return pages
    finally:
        document.close()


def _expand_to_image_pages(
    pages: list[str], media_type: str | list[str]
) -> list[tuple[str, str]]:
    """Normalize input pages to (base64, image MIME) pairs, rasterizing PDFs.

    Rasterized PDF pages are JPEG; real image uploads keep their declared MIME so
    a PNG isn't mislabeled.
    """
    expanded: list[tuple[str, str]] = []
    for index, raw in enumerate(pages):
        cleaned = _strip_data_url(raw)
        if not cleaned:
            continue
        page_media_type = _media_type_for(index, media_type)
        if _is_pdf(page_media_type):
            expanded.extend(
                (image_b64, "image/jpeg")
                for image_b64 in _pdf_to_image_pages(cleaned, JOURNAL_IMPORT_RASTER_DPI)
            )
        else:
            expanded.append((cleaned, page_media_type or "image/jpeg"))
    return expanded


@dataclass
class VisionUsage:
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


@dataclass
class VisionExtractionResult:
    response: JournalImageExtractResponse
    usage: VisionUsage
    page_count: int = 0
    entries: list[JournalDayExtract] = field(default_factory=list)


def _coerce_confidence(value: object) -> str:
    text = str(value or "").strip().lower()
    return text if text in {"high", "medium", "low"} else "medium"


def extract_journal_entries(
    pages: list[str],
    media_type: str | list[str] = "image/jpeg",
    scan_target: str = "journal",
    *,
    model: str | None = None,
) -> VisionExtractionResult:
    """Transcribe an ordered list of page images into dated markdown entries.

    ``pages`` are base64 strings (data-URL prefix tolerated). Returns the parsed
    response plus per-call token usage from the Responses API so callers can
    enforce a daily token budget.
    """
    # PDF inputs are rasterized to images here; after this, every page is an image.
    image_pages = _expand_to_image_pages(pages, media_type)
    page_count = len(image_pages)
    used_model = model or OPENAI_JOURNAL_VISION_MODEL
    if page_count == 0:
        raise ValueError("no page images provided")

    content: list[dict] = [
        {"type": "input_text", "text": _instructions_for(scan_target, page_count)}
    ]
    for b64, page_media_type in image_pages:
        content.append(
            {
                "type": "input_image",
                "image_url": f"data:{page_media_type};base64,{b64}",
                "detail": OPENAI_JOURNAL_VISION_IMAGE_DETAIL,
            }
        )

    response = _create_response_with_retry(
        model=used_model,
        input=[{"role": "user", "content": content}],
        text={"verbosity": "high", "format": {"type": "json_object"}},
        reasoning={"effort": "low"},
    )

    raw = (response.output_text or "{}").strip()
    usage = VisionUsage(model=used_model)
    if getattr(response, "usage", None) is not None:
        usage.input_tokens = int(getattr(response.usage, "input_tokens", 0) or 0)
        usage.output_tokens = int(getattr(response.usage, "output_tokens", 0) or 0)
        usage.total_tokens = int(
            getattr(response.usage, "total_tokens", 0)
            or (usage.input_tokens + usage.output_tokens)
        )

    logger.info(
        "[scan] model=%s pages=%d tokens(in=%d out=%d total=%d) raw=%dchars",
        used_model, page_count, usage.input_tokens, usage.output_tokens,
        usage.total_tokens, len(raw),
    )
    print(f"[scan] model={used_model} pages={page_count} "
          f"tokens(in={usage.input_tokens} out={usage.output_tokens} total={usage.total_tokens})")
    print(f"[scan] raw response ({len(raw)} chars):\n{raw[:2000]}")
    if len(raw) > 2000:
        print(f"[scan] ... (truncated for log, full length {len(raw)})")

    try:
        data = json.loads(raw)
    except Exception as exc:
        logger.warning("[scan] JSON parse failed: %s", exc)
        data = {}

    raw_entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(raw_entries, list):
        raw_entries = []

    entries: list[JournalDayExtract] = []
    for item in raw_entries:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        try:
            start_page = int(item.get("start_page") or 0)
        except (TypeError, ValueError):
            start_page = 0
        start_page = max(0, min(start_page, page_count - 1))
        date_text = str(item.get("date_text") or "").strip() or None
        entries.append(
            JournalDayExtract(
                # Normalize the model's date; if it left it blank but read a
                # heading, parse the heading ourselves (Feb 24th -> 02-24).
                detected_date=_resolve_detected(item.get("detected_date"), date_text),
                date_text=date_text,
                text=text,
                start_page=start_page,
            )
        )

    response_model = JournalImageExtractResponse(
        entries=entries,
        confidence=_coerce_confidence(data.get("confidence") if isinstance(data, dict) else None),
        notes=str((data.get("notes") if isinstance(data, dict) else "") or "").strip(),
    )
    print(f"[scan] {len(entries)} entries — " +
          ", ".join(f"p{e.start_page}:{e.detected_date or e.date_text or 'no-date'}:{len(e.text)}c" for e in entries))

    return VisionExtractionResult(
        response=response_model,
        usage=usage,
        page_count=page_count,
        entries=entries,
    )

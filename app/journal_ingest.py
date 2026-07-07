"""Ingestion: turn an uploaded image/PDF into preprocessed page images.

Shared by the web scan endpoint and the batch CLI so both rasterize + preprocess
identically and cache the resulting page images. Caching serves two purposes:
  1. Review thumbnails — the reviewer can show the original page next to a
     fragment (provenance via ``start_page``).
  2. Reuse — re-running / triage re-extraction never re-rasterizes.

Page images live on disk under ``JOURNAL_IMPORT_PAGES_DIR/<batch_id>/<index>.jpg``
(regenerable from source PDFs, so gitignored — not in the DB).
"""

import base64
import logging
import os

from app.config import (
    JOURNAL_ENTRY_PHOTOS_DIR,
    JOURNAL_IMPORT_PAGES_DIR,
    JOURNAL_IMPORT_PREPROCESS,
    JOURNAL_IMPORT_RASTER_DPI,
)

logger = logging.getLogger(__name__)


def _is_pdf(media_type: str) -> bool:
    return (media_type or "").split(";")[0].strip().lower() == "application/pdf"


def rasterize_to_jpegs(data: bytes, media_type: str, dpi: int | None = None) -> list[bytes]:
    """Return one JPEG per page: rasterize a PDF, or pass an image through as one page."""
    resolution = dpi or JOURNAL_IMPORT_RASTER_DPI
    if not _is_pdf(media_type):
        # A single uploaded image is one page; re-encode to JPEG for uniformity.
        return [_reencode_jpeg(data)]

    try:
        import fitz  # PyMuPDF
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise ValueError("PDF handling requires PyMuPDF (pip install PyMuPDF).") from exc

    document = fitz.open(stream=data, filetype="pdf")
    try:
        pages: list[bytes] = []
        for index in range(document.page_count):
            pixmap = document.load_page(index).get_pixmap(dpi=resolution)
            pages.append(pixmap.tobytes("jpeg"))
        return pages
    finally:
        document.close()


def _reencode_jpeg(data: bytes) -> bytes:
    try:
        from PIL import Image
        import io

        Image.MAX_IMAGE_PIXELS = None  # trusted local scans; skip bomb check
        with Image.open(io.BytesIO(data)) as image:
            buffer = io.BytesIO()
            image.convert("RGB").save(buffer, format="JPEG", quality=92)
            return buffer.getvalue()
    except Exception:
        # If PIL can't read it, hand the original bytes through unchanged.
        return data


def preprocess_jpeg(data: bytes) -> bytes:
    """Grayscale + autocontrast to lift handwriting legibility before the model.

    Deliberately conservative: no binarization or aggressive denoise (those can
    erase faint pencil). Controlled by JOURNAL_IMPORT_PREPROCESS; a no-op if
    Pillow is unavailable or the image can't be decoded.
    """
    if not JOURNAL_IMPORT_PREPROCESS:
        return data
    try:
        from PIL import Image, ImageOps
        import io

        Image.MAX_IMAGE_PIXELS = None  # trusted local scans; skip bomb check
        with Image.open(io.BytesIO(data)) as image:
            processed = ImageOps.grayscale(image)
            processed = ImageOps.autocontrast(processed, cutoff=1)
            buffer = io.BytesIO()
            processed.save(buffer, format="JPEG", quality=92)
            return buffer.getvalue()
    except Exception as exc:  # pragma: no cover - best-effort enhancement
        logger.warning("Page preprocess skipped: %s", exc)
        return data


# --- Page-image cache --------------------------------------------------------


def _pages_dir() -> str:
    return os.getenv("JOURNAL_IMPORT_PAGES_DIR", JOURNAL_IMPORT_PAGES_DIR)


def page_image_path(batch_id: int, page_index: int) -> str:
    return os.path.join(_pages_dir(), str(batch_id), f"{page_index}.jpg")


def save_page_image(batch_id: int, page_index: int, jpeg_bytes: bytes) -> str:
    path = page_image_path(batch_id, page_index)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(jpeg_bytes)
    return path


def has_page_image(batch_id: int, page_index: int) -> bool:
    return os.path.exists(page_image_path(batch_id, page_index))


def load_page_image(batch_id: int, page_index: int) -> bytes | None:
    path = page_image_path(batch_id, page_index)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()


def delete_batch_pages(batch_id: int) -> None:
    """Remove a batch's cached page-image directory (best-effort)."""
    import shutil

    directory = os.path.join(_pages_dir(), str(batch_id))
    shutil.rmtree(directory, ignore_errors=True)


# --- Permanent per-entry source photos ---------------------------------------
# These survive batch deletion (the cache above does not), so a committed entry
# can always show the scanned page(s) it came from.


def _entry_photos_dir() -> str:
    return os.getenv("JOURNAL_ENTRY_PHOTOS_DIR", JOURNAL_ENTRY_PHOTOS_DIR)


def _safe_segment(value: str) -> str:
    """Keep a path segment to a safe charset (no traversal, no separators)."""
    return "".join(ch for ch in str(value) if ch.isalnum() or ch in ("-", "_"))


def entry_photo_dir(user_id: str, entry_date: str) -> str:
    return os.path.join(_entry_photos_dir(), _safe_segment(user_id), _safe_segment(entry_date))


def entry_photo_path(user_id: str, entry_date: str, index: int) -> str:
    return os.path.join(entry_photo_dir(user_id, entry_date), f"{int(index)}.jpg")


def save_entry_photos(user_id: str, entry_date: str, images: list[bytes]) -> list[str]:
    """Write an entry's source page images, replacing any existing set. Returns paths."""
    import shutil

    directory = entry_photo_dir(user_id, entry_date)
    shutil.rmtree(directory, ignore_errors=True)
    if not images:
        return []
    os.makedirs(directory, exist_ok=True)
    paths: list[str] = []
    for index, data in enumerate(images):
        path = entry_photo_path(user_id, entry_date, index)
        with open(path, "wb") as handle:
            handle.write(data)
        paths.append(path)
    return paths


def load_entry_photo(user_id: str, entry_date: str, index: int) -> bytes | None:
    path = entry_photo_path(user_id, entry_date, index)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return handle.read()


def prepare_and_store_pages(
    batch_id: int, data: bytes, media_type: str, dpi: int | None = None
) -> list[str]:
    """Rasterize + preprocess an upload and cache every page. Returns base64 JPEGs
    (preprocessed) in page order, ready to hand to the extractor."""
    raw_pages = rasterize_to_jpegs(data, media_type, dpi)
    encoded: list[str] = []
    for index, page_bytes in enumerate(raw_pages):
        processed = preprocess_jpeg(page_bytes)
        save_page_image(batch_id, index, processed)
        encoded.append(base64.b64encode(processed).decode("ascii"))
    return encoded

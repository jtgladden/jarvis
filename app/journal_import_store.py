"""Staging store for the batch journal-digitization pipeline.

One `.db` per domain (house style): ``data/journal_import.db`` holds scanned
fragments awaiting review + commit into the real ``journal_entries`` store, plus
provenance so extraction can run detached over a big pile of PDFs and be
reviewed/committed later. Idempotent, resumable: extraction is keyed on
``(source_file, page_range)`` so re-running skips already-extracted groups.

A ``token_ledger`` table tracks per-day token usage so a long run can honor a
daily cap and drip across days (Responses API returns usage per call).
"""

import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import JOURNAL_IMPORT_DB

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("JOURNAL_IMPORT_DB", JOURNAL_IMPORT_DB)
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def _ensure_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_file TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            scan_target TEXT NOT NULL DEFAULT 'journal',
            model TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending',
            error TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_fragments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            page_index INTEGER NOT NULL DEFAULT 0,
            detected_date TEXT,
            date_detected INTEGER NOT NULL DEFAULT 0,
            text_markdown TEXT NOT NULL DEFAULT '',
            confidence TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'pending',
            dedupe_key TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # Records which (source_file, page_range) groups have already been extracted,
    # so re-running the processor skips completed work rather than duplicating.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            source_file TEXT NOT NULL,
            page_range TEXT NOT NULL,
            fragment_count INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (source_file, page_range)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS token_ledger (
            day TEXT PRIMARY KEY,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_scan_fragments_batch ON scan_fragments(batch_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_scan_fragments_dedupe ON scan_fragments(batch_id, dedupe_key)"
    )


def init_journal_import_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.commit()


# --- Batches -----------------------------------------------------------------


def get_batch_by_source(source_file: str) -> dict | None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT * FROM scan_batches WHERE source_file = ? ORDER BY id DESC LIMIT 1",
            (source_file,),
        ).fetchone()
    return dict(row) if row else None


def create_batch(source_file: str, page_count: int, scan_target: str, model: str) -> int:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        cursor = connection.execute(
            """
            INSERT INTO scan_batches (source_file, page_count, scan_target, model, status)
            VALUES (?, ?, ?, ?, 'pending')
            """,
            (source_file, page_count, scan_target, model),
        )
        connection.commit()
        return int(cursor.lastrowid)


def get_or_create_batch(source_file: str, page_count: int, scan_target: str, model: str) -> dict:
    existing = get_batch_by_source(source_file)
    if existing is not None:
        return existing
    batch_id = create_batch(source_file, page_count, scan_target, model)
    return get_batch(batch_id)  # type: ignore[return-value]


def set_batch_status(batch_id: int, status: str, error: str | None = None) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            "UPDATE scan_batches SET status = ?, error = ? WHERE id = ?",
            (status, error, batch_id),
        )
        connection.commit()


def _batch_dict_with_counts(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    counts = connection.execute(
        """
        SELECT
            COUNT(*) AS fragment_count,
            SUM(CASE WHEN status IN ('pending', 'reviewed') THEN 1 ELSE 0 END) AS pending_count,
            SUM(CASE WHEN status = 'committed' THEN 1 ELSE 0 END) AS committed_count
        FROM scan_fragments WHERE batch_id = ?
        """,
        (row["id"],),
    ).fetchone()
    data = dict(row)
    data["fragment_count"] = int(counts["fragment_count"] or 0)
    data["pending_count"] = int(counts["pending_count"] or 0)
    data["committed_count"] = int(counts["committed_count"] or 0)
    return data


def get_batch(batch_id: int) -> dict | None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT * FROM scan_batches WHERE id = ?", (batch_id,)
        ).fetchone()
        if row is None:
            return None
        return _batch_dict_with_counts(connection, row)


def list_batches() -> list[dict]:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = connection.execute(
            "SELECT * FROM scan_batches ORDER BY id DESC"
        ).fetchall()
        return [_batch_dict_with_counts(connection, row) for row in rows]


# --- Groups (idempotency / resume) -------------------------------------------


def group_already_extracted(source_file: str, page_range: str) -> bool:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT 1 FROM scan_groups WHERE source_file = ? AND page_range = ?",
            (source_file, page_range),
        ).fetchone()
        return row is not None


def record_group(
    batch_id: int, source_file: str, page_range: str, fragment_count: int, total_tokens: int
) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            """
            INSERT OR IGNORE INTO scan_groups
                (batch_id, source_file, page_range, fragment_count, total_tokens)
            VALUES (?, ?, ?, ?, ?)
            """,
            (batch_id, source_file, page_range, fragment_count, total_tokens),
        )
        connection.commit()


# --- Fragments ---------------------------------------------------------------


def fragment_dedupe_exists(batch_id: int, dedupe_key: str) -> bool:
    if not dedupe_key:
        return False
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT 1 FROM scan_fragments WHERE batch_id = ? AND dedupe_key = ?",
            (batch_id, dedupe_key),
        ).fetchone()
        return row is not None


def insert_fragment(
    batch_id: int,
    page_index: int,
    detected_date: str | None,
    date_detected: bool,
    text_markdown: str,
    confidence: str,
    dedupe_key: str,
) -> int | None:
    """Insert one fragment, skipping if its dedupe_key already exists in the batch.

    Returns the new fragment id, or None when skipped as a duplicate. The dedupe
    key is ``(detected_date, normalized first ~40 chars)`` — reliable for short,
    dated archive entries (see app/journal_import.py for the caveat on
    free-flowing journals, which would need a different strategy).
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        if dedupe_key:
            existing = connection.execute(
                "SELECT 1 FROM scan_fragments WHERE batch_id = ? AND dedupe_key = ?",
                (batch_id, dedupe_key),
            ).fetchone()
            if existing is not None:
                return None
        cursor = connection.execute(
            """
            INSERT INTO scan_fragments
                (batch_id, page_index, detected_date, date_detected, text_markdown,
                 confidence, status, dedupe_key)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            """,
            (
                batch_id,
                page_index,
                detected_date,
                1 if date_detected else 0,
                text_markdown,
                confidence,
                dedupe_key,
            ),
        )
        connection.commit()
        return int(cursor.lastrowid)


def list_fragments(batch_id: int) -> list[dict]:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = connection.execute(
            """
            SELECT * FROM scan_fragments
            WHERE batch_id = ?
            ORDER BY page_index ASC, id ASC
            """,
            (batch_id,),
        ).fetchall()
        return [dict(row) for row in rows]


def get_fragment(fragment_id: int) -> dict | None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT * FROM scan_fragments WHERE id = ?", (fragment_id,)
        ).fetchone()
        return dict(row) if row else None


def update_fragment(
    fragment_id: int,
    detected_date: str | None = None,
    text_markdown: str | None = None,
    status: str | None = None,
    *,
    set_date: bool = False,
) -> dict | None:
    """Patch a fragment. Only provided fields change; ``set_date`` allows setting
    the date to NULL explicitly (distinct from "leave unchanged")."""
    sets: list[str] = []
    params: list[object] = []
    if set_date:
        sets.append("detected_date = ?")
        params.append(detected_date)
        # A user-set date counts as detected for review flagging.
        sets.append("date_detected = 1")
    if text_markdown is not None:
        sets.append("text_markdown = ?")
        params.append(text_markdown)
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if not sets:
        return get_fragment(fragment_id)

    params.append(fragment_id)
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            f"UPDATE scan_fragments SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        connection.commit()
    return get_fragment(fragment_id)


def set_fragments_status(fragment_ids: list[int], status: str) -> None:
    if not fragment_ids:
        return
    placeholders = ",".join("?" for _ in fragment_ids)
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            f"UPDATE scan_fragments SET status = ? WHERE id IN ({placeholders})",
            [status, *fragment_ids],
        )
        connection.commit()


# --- Token ledger (daily cap / stop-and-resume) ------------------------------


def record_token_usage(day: str, input_tokens: int, output_tokens: int, total_tokens: int) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            """
            INSERT INTO token_ledger (day, input_tokens, output_tokens, total_tokens, call_count, updated_at)
            VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(day) DO UPDATE SET
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens,
                total_tokens = total_tokens + excluded.total_tokens,
                call_count = call_count + 1,
                updated_at = CURRENT_TIMESTAMP
            """,
            (day, input_tokens, output_tokens, total_tokens),
        )
        connection.commit()


def get_tokens_used_today(day: str) -> int:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT total_tokens FROM token_ledger WHERE day = ?", (day,)
        ).fetchone()
        return int(row["total_tokens"]) if row else 0

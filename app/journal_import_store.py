"""Staging store for the batch journal-digitization pipeline.

One `.db` per domain (house style): ``data/journal_import.db`` holds scanned
fragments awaiting review + commit into the real ``journal_entries`` store, plus
provenance so extraction can run detached over a big pile of PDFs and be
reviewed/committed later. Idempotent, resumable: extraction is keyed on
``(source_file, page_range)`` so re-running skips already-extracted groups.

A ``token_ledger`` (keyed by day + model) tracks token usage AND estimated USD
spend, so a long run can honor a daily token cap AND a hard dollar budget.
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


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


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
            default_year INTEGER,
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
            date_text TEXT,
            date_detected INTEGER NOT NULL DEFAULT 0,
            text_markdown TEXT NOT NULL DEFAULT '',
            confidence TEXT NOT NULL DEFAULT 'medium',
            status TEXT NOT NULL DEFAULT 'pending',
            dedupe_key TEXT NOT NULL DEFAULT '',
            source_model TEXT NOT NULL DEFAULT '',
            year_inferred INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    # Which (source_file, page_range) groups have been processed, and their
    # outcome. status: 'done' | 'failed'. Only 'done' counts as already-extracted,
    # so a failed group is retried on the next run.
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS scan_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id INTEGER NOT NULL,
            source_file TEXT NOT NULL,
            page_range TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'done',
            error TEXT,
            attempts INTEGER NOT NULL DEFAULT 1,
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
            day TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (day, model)
        )
        """
    )
    _ensure_columns(connection)
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_scan_fragments_batch ON scan_fragments(batch_id)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_scan_fragments_dedupe ON scan_fragments(batch_id, dedupe_key)"
    )


def _ensure_columns(connection: sqlite3.Connection) -> None:
    """Migration-safe column adds for stores created by earlier versions."""
    frag_cols = _columns(connection, "scan_fragments")
    if "source_model" not in frag_cols:
        connection.execute("ALTER TABLE scan_fragments ADD COLUMN source_model TEXT NOT NULL DEFAULT ''")
    if "date_text" not in frag_cols:
        connection.execute("ALTER TABLE scan_fragments ADD COLUMN date_text TEXT")
    if "year_inferred" not in frag_cols:
        connection.execute("ALTER TABLE scan_fragments ADD COLUMN year_inferred INTEGER NOT NULL DEFAULT 0")

    if "default_year" not in _columns(connection, "scan_batches"):
        connection.execute("ALTER TABLE scan_batches ADD COLUMN default_year INTEGER")

    group_cols = _columns(connection, "scan_groups")
    if "status" not in group_cols:
        connection.execute("ALTER TABLE scan_groups ADD COLUMN status TEXT NOT NULL DEFAULT 'done'")
    if "error" not in group_cols:
        connection.execute("ALTER TABLE scan_groups ADD COLUMN error TEXT")
    if "attempts" not in group_cols:
        connection.execute("ALTER TABLE scan_groups ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1")

    # token_ledger gained a 'model' PK component + cost tracking. If an old
    # single-key ledger exists, rebuild it preserving prior token counts.
    ledger_cols = _columns(connection, "token_ledger")
    if ledger_cols and "model" not in ledger_cols:
        connection.execute("ALTER TABLE token_ledger RENAME TO token_ledger_legacy")
        connection.execute(
            """
            CREATE TABLE token_ledger (
                day TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd REAL NOT NULL DEFAULT 0,
                call_count INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (day, model)
            )
            """
        )
        connection.execute(
            """
            INSERT INTO token_ledger (day, model, input_tokens, output_tokens, total_tokens, cost_usd, call_count)
            SELECT day, '', input_tokens, output_tokens, total_tokens, 0, call_count FROM token_ledger_legacy
            """
        )
        connection.execute("DROP TABLE token_ledger_legacy")


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


def create_batch(
    source_file: str, page_count: int, scan_target: str, model: str, default_year: int | None = None
) -> int:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        cursor = connection.execute(
            """
            INSERT INTO scan_batches (source_file, page_count, scan_target, model, status, default_year)
            VALUES (?, ?, ?, ?, 'pending', ?)
            """,
            (source_file, page_count, scan_target, model, default_year),
        )
        connection.commit()
        return int(cursor.lastrowid)


def get_or_create_batch(
    source_file: str, page_count: int, scan_target: str, model: str, default_year: int | None = None
) -> dict:
    existing = get_batch_by_source(source_file)
    if existing is not None:
        if default_year is not None and existing.get("default_year") != default_year:
            set_batch_default_year(int(existing["id"]), default_year)
            existing = get_batch(int(existing["id"]))  # type: ignore[assignment]
        return existing
    batch_id = create_batch(source_file, page_count, scan_target, model, default_year)
    return get_batch(batch_id)  # type: ignore[return-value]


def set_batch_default_year(batch_id: int, default_year: int | None) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            "UPDATE scan_batches SET default_year = ? WHERE id = ?", (default_year, batch_id)
        )
        connection.commit()


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
            SUM(CASE WHEN status = 'committed' THEN 1 ELSE 0 END) AS committed_count,
            SUM(CASE WHEN status IN ('pending', 'reviewed') AND confidence = 'low' THEN 1 ELSE 0 END) AS low_confidence_count
        FROM scan_fragments WHERE batch_id = ?
        """,
        (row["id"],),
    ).fetchone()
    groups = connection.execute(
        "SELECT COUNT(*) AS n FROM scan_groups WHERE batch_id = ? AND status = 'failed'",
        (row["id"],),
    ).fetchone()
    data = dict(row)
    data["fragment_count"] = int(counts["fragment_count"] or 0)
    data["pending_count"] = int(counts["pending_count"] or 0)
    data["committed_count"] = int(counts["committed_count"] or 0)
    data["low_confidence_count"] = int(counts["low_confidence_count"] or 0)
    data["failed_group_count"] = int(groups["n"] or 0)
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


# --- Groups (idempotency / resume / retry) -----------------------------------


def group_already_extracted(source_file: str, page_range: str) -> bool:
    """True only for a successfully-completed group, so failures get retried."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT 1 FROM scan_groups WHERE source_file = ? AND page_range = ? AND status = 'done'",
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
            INSERT INTO scan_groups
                (batch_id, source_file, page_range, status, error, attempts, fragment_count, total_tokens)
            VALUES (?, ?, ?, 'done', NULL, 1, ?, ?)
            ON CONFLICT(source_file, page_range) DO UPDATE SET
                batch_id = excluded.batch_id,
                status = 'done', error = NULL, attempts = attempts + 1,
                fragment_count = excluded.fragment_count, total_tokens = excluded.total_tokens
            """,
            (batch_id, source_file, page_range, fragment_count, total_tokens),
        )
        connection.commit()


def record_group_failure(batch_id: int, source_file: str, page_range: str, error: str) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            """
            INSERT INTO scan_groups
                (batch_id, source_file, page_range, status, error, attempts)
            VALUES (?, ?, ?, 'failed', ?, 1)
            ON CONFLICT(source_file, page_range) DO UPDATE SET
                batch_id = excluded.batch_id,
                status = 'failed', error = excluded.error, attempts = attempts + 1
            """,
            (batch_id, source_file, page_range, error[:500]),
        )
        connection.commit()


def list_group_statuses(batch_id: int) -> list[dict]:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = connection.execute(
            "SELECT * FROM scan_groups WHERE batch_id = ? ORDER BY page_range", (batch_id,)
        ).fetchall()
        return [dict(row) for row in rows]


# --- Deletion (force re-import / remove batch) -------------------------------


def delete_batch_fragments(batch_id: int, statuses: tuple[str, ...] | None = None) -> int:
    """Delete a batch's fragments, optionally only those in ``statuses``."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            cursor = connection.execute(
                f"DELETE FROM scan_fragments WHERE batch_id = ? AND status IN ({placeholders})",
                [batch_id, *statuses],
            )
        else:
            cursor = connection.execute("DELETE FROM scan_fragments WHERE batch_id = ?", (batch_id,))
        connection.commit()
        return cursor.rowcount


def delete_batch_groups(batch_id: int) -> None:
    """Forget a batch's group-completion records so its groups re-run."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute("DELETE FROM scan_groups WHERE batch_id = ?", (batch_id,))
        connection.commit()


def delete_groups_for_source(source_file: str) -> int:
    """Forget ALL group records for a source file, regardless of batch_id.

    Idempotency keys on (source_file, page_range), so this is the correct scope
    to clear before a forced re-extraction — it also removes rows orphaned under
    a prior batch of the same file.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        cursor = connection.execute("DELETE FROM scan_groups WHERE source_file = ?", (source_file,))
        connection.commit()
        return cursor.rowcount


def delete_batch_row(batch_id: int) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute("DELETE FROM scan_fragments WHERE batch_id = ?", (batch_id,))
        connection.execute("DELETE FROM scan_groups WHERE batch_id = ?", (batch_id,))
        connection.execute("DELETE FROM scan_batches WHERE id = ?", (batch_id,))
        connection.commit()


# --- Fragments ---------------------------------------------------------------


def insert_fragment(
    batch_id: int,
    page_index: int,
    detected_date: str | None,
    date_detected: bool,
    text_markdown: str,
    confidence: str,
    dedupe_key: str,
    source_model: str = "",
    date_text: str | None = None,
) -> int | None:
    """Insert one fragment, skipping if its dedupe_key already exists in the batch.

    Returns the new fragment id, or None when skipped as a duplicate. The dedupe
    key is ``(month-day, normalized alnum prefix)`` — reliable for short, dated
    archive entries (see app/journal_import.py for the caveat on free-flowing
    journals, which would need a different strategy). On a duplicate, if the
    incoming text is longer, the existing fragment's body is upgraded in place —
    the overlap's later group sees a boundary-spanning entry whole where the
    earlier group truncated it at its last page.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        if dedupe_key:
            existing = connection.execute(
                "SELECT id, text_markdown FROM scan_fragments WHERE batch_id = ? AND dedupe_key = ?",
                (batch_id, dedupe_key),
            ).fetchone()
            if existing is not None:
                if len(text_markdown or "") > len(existing["text_markdown"] or ""):
                    connection.execute(
                        "UPDATE scan_fragments SET text_markdown = ? WHERE id = ?",
                        (text_markdown, existing["id"]),
                    )
                    connection.commit()
                return None
        cursor = connection.execute(
            """
            INSERT INTO scan_fragments
                (batch_id, page_index, detected_date, date_text, date_detected, text_markdown,
                 confidence, status, dedupe_key, source_model)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
            """,
            (
                batch_id,
                page_index,
                detected_date,
                date_text,
                1 if date_detected else 0,
                text_markdown,
                confidence,
                dedupe_key,
                source_model,
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
    confidence: str | None = None,
    source_model: str | None = None,
    date_text: str | None = None,
    year_inferred: bool | None = None,
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
        sets.append("date_detected = 1")  # a user-set date counts as detected
    if date_text is not None:
        sets.append("date_text = ?")
        params.append(date_text)
    if year_inferred is not None:
        sets.append("year_inferred = ?")
        params.append(1 if year_inferred else 0)
    if text_markdown is not None:
        sets.append("text_markdown = ?")
        params.append(text_markdown)
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if confidence is not None:
        sets.append("confidence = ?")
        params.append(confidence)
    if source_model is not None:
        sets.append("source_model = ?")
        params.append(source_model)
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


# --- Token ledger (daily cap + dollar budget / stop-and-resume) --------------


def record_token_usage(
    day: str, model: str, input_tokens: int, output_tokens: int, total_tokens: int, cost_usd: float
) -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute(
            """
            INSERT INTO token_ledger (day, model, input_tokens, output_tokens, total_tokens, cost_usd, call_count, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(day, model) DO UPDATE SET
                input_tokens = input_tokens + excluded.input_tokens,
                output_tokens = output_tokens + excluded.output_tokens,
                total_tokens = total_tokens + excluded.total_tokens,
                cost_usd = cost_usd + excluded.cost_usd,
                call_count = call_count + 1,
                updated_at = CURRENT_TIMESTAMP
            """,
            (day, model or "", input_tokens, output_tokens, total_tokens, cost_usd),
        )
        connection.commit()


def get_tokens_used_today(day: str) -> int:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) AS t FROM token_ledger WHERE day = ?", (day,)
        ).fetchone()
        return int(row["t"] or 0)


def get_total_spend_usd() -> float:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        row = connection.execute("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM token_ledger").fetchone()
        return float(row["c"] or 0.0)


def get_spend_summary() -> dict:
    """Totals for observability: cumulative spend, today's tokens, per-model rows."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        totals = connection.execute(
            "SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(call_count),0) AS calls FROM token_ledger"
        ).fetchone()
        by_model = connection.execute(
            """
            SELECT model, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost, SUM(call_count) AS calls
            FROM token_ledger GROUP BY model ORDER BY cost DESC
            """
        ).fetchall()
    return {
        "total_cost_usd": float(totals["cost"] or 0.0),
        "total_tokens": int(totals["tokens"] or 0),
        "total_calls": int(totals["calls"] or 0),
        "by_model": [
            {
                "model": row["model"] or "(unknown)",
                "tokens": int(row["tokens"] or 0),
                "cost_usd": float(row["cost"] or 0.0),
                "calls": int(row["calls"] or 0),
            }
            for row in by_model
        ],
    }

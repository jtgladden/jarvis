"""Storage for Layer 1 derived journal signals.

This is a DERIVED store: every row here is produced by extracting an existing
journal entry (see ``app/journal_signal_extract.py``). It lives in its own
SQLite database (``data/journal_signals.db``) and is keyed to the source entry
by ``(user_id, entry_date)`` — the journal's own primary key. Nothing in here
ever writes back to ``journal_entries``; the source is read-only to this layer.

Three tables:

* ``entry_signals``  — one row per extracted entry: the extraction bookkeeping
  (version, model, source hash, timestamp), the mood scalar, and the full
  validated extraction payload as JSON (themes/people/events/habits).
* ``habit_events``   — the habits flattened to one row per habit-mention-per-entry.
  This is what Layer 2 aggregates with plain SQL (no JSON digging).
* ``theme_events``   — themes flattened the same way, for theme-trend analytics.

``habit_events`` / ``theme_events`` are rebuilt (delete + reinsert) for an entry
whenever it is re-extracted, so re-running extraction is idempotent.
"""

import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import APP_DEFAULT_USER_ID, JOURNAL_SIGNALS_DB

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("JOURNAL_SIGNALS_DB", JOURNAL_SIGNALS_DB)
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
        CREATE TABLE IF NOT EXISTS entry_signals (
            user_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            extraction_version INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL DEFAULT '',
            source_hash TEXT NOT NULL DEFAULT '',
            extracted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            mood_score INTEGER,
            mood_label TEXT NOT NULL DEFAULT '',
            signals_json TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (user_id, entry_date)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS habit_events (
            user_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            habit_slug TEXT NOT NULL,
            habit_label TEXT NOT NULL DEFAULT '',
            evidence TEXT NOT NULL DEFAULT ''
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS theme_events (
            user_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            theme_slug TEXT NOT NULL,
            theme_label TEXT NOT NULL DEFAULT ''
        )
        """
    )
    # Analytics query by (user, slug, date-range); index the hot paths.
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_habit_events_user_slug_date "
        "ON habit_events (user_id, habit_slug, entry_date)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_habit_events_user_date "
        "ON habit_events (user_id, entry_date)"
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_theme_events_user_slug_date "
        "ON theme_events (user_id, theme_slug, entry_date)"
    )


def init_journal_signals_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.commit()


def get_extraction_states(user_id: str = APP_DEFAULT_USER_ID) -> dict[str, dict[str, object]]:
    """Return ``{entry_date: {"extraction_version", "source_hash"}}`` for every
    already-extracted entry. The batch driver uses this to decide which entries
    are unextracted or stale (version bumped or source text changed) so it only
    re-processes what it must — the idempotency check.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = connection.execute(
            """
            SELECT entry_date, extraction_version, source_hash
            FROM entry_signals
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchall()
    return {
        row["entry_date"]: {
            "extraction_version": int(row["extraction_version"]),
            "source_hash": row["source_hash"],
        }
        for row in rows
    }


def upsert_entry_signals(
    entry_date: str,
    extraction_version: int,
    model: str,
    source_hash: str,
    mood_score: int | None,
    mood_label: str,
    signals_json: str,
    habits: list[tuple[str, str, str]],
    themes: list[tuple[str, str]],
    user_id: str = APP_DEFAULT_USER_ID,
) -> None:
    """Write one entry's extraction result, replacing any prior result for it.

    All writes for the entry happen in a single transaction: the ``entry_signals``
    row is upserted and the entry's ``habit_events`` / ``theme_events`` are fully
    rebuilt (deleted then reinserted). Re-running extraction on the same entry
    therefore leaves the store in a clean, non-duplicated state.

    ``habits`` is a list of ``(slug, label, evidence)`` and ``themes`` a list of
    ``(slug, label)``.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        connection.execute("BEGIN")
        connection.execute(
            """
            INSERT INTO entry_signals (
                user_id, entry_date, extraction_version, model, source_hash,
                extracted_at, mood_score, mood_label, signals_json
            )
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                extraction_version = excluded.extraction_version,
                model = excluded.model,
                source_hash = excluded.source_hash,
                extracted_at = CURRENT_TIMESTAMP,
                mood_score = excluded.mood_score,
                mood_label = excluded.mood_label,
                signals_json = excluded.signals_json
            """,
            (
                user_id,
                entry_date,
                extraction_version,
                model,
                source_hash,
                mood_score,
                mood_label,
                signals_json,
            ),
        )
        connection.execute(
            "DELETE FROM habit_events WHERE user_id = ? AND entry_date = ?",
            (user_id, entry_date),
        )
        connection.execute(
            "DELETE FROM theme_events WHERE user_id = ? AND entry_date = ?",
            (user_id, entry_date),
        )
        if habits:
            connection.executemany(
                """
                INSERT INTO habit_events (user_id, entry_date, habit_slug, habit_label, evidence)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (user_id, entry_date, slug, label, evidence)
                    for slug, label, evidence in habits
                ],
            )
        if themes:
            connection.executemany(
                """
                INSERT INTO theme_events (user_id, entry_date, theme_slug, theme_label)
                VALUES (?, ?, ?, ?)
                """,
                [(user_id, entry_date, slug, label) for slug, label in themes],
            )
        connection.commit()


def _date_filtered_rows(
    connection: sqlite3.Connection,
    table: str,
    columns: str,
    user_id: str,
    start_date: str | None,
    end_date: str | None,
) -> list[sqlite3.Row]:
    clauses = ["user_id = ?"]
    params: list[str] = [user_id]
    if start_date is not None:
        clauses.append("entry_date >= ?")
        params.append(start_date)
    if end_date is not None:
        clauses.append("entry_date <= ?")
        params.append(end_date)
    return connection.execute(
        f"SELECT {columns} FROM {table} WHERE {' AND '.join(clauses)} ORDER BY entry_date ASC",
        params,
    ).fetchall()


def list_habit_events(
    start_date: str | None = None,
    end_date: str | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[dict[str, str]]:
    """Flattened habit mentions in ``[start_date, end_date]`` (inclusive ISO)."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = _date_filtered_rows(
            connection, "habit_events",
            "entry_date, habit_slug, habit_label, evidence",
            user_id, start_date, end_date,
        )
    return [
        {
            "entry_date": row["entry_date"],
            "habit_slug": row["habit_slug"],
            "habit_label": row["habit_label"],
            "evidence": row["evidence"],
        }
        for row in rows
    ]


def list_theme_events(
    start_date: str | None = None,
    end_date: str | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[dict[str, str]]:
    """Flattened theme mentions in ``[start_date, end_date]`` (inclusive ISO)."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = _date_filtered_rows(
            connection, "theme_events",
            "entry_date, theme_slug, theme_label",
            user_id, start_date, end_date,
        )
    return [
        {
            "entry_date": row["entry_date"],
            "theme_slug": row["theme_slug"],
            "theme_label": row["theme_label"],
        }
        for row in rows
    ]


def list_extracted_dates(
    start_date: str | None = None,
    end_date: str | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[str]:
    """Dates that have an extraction row — i.e. journaled days Layer 2 can trust.

    Used as the denominator when computing how often a habit appears: a habit's
    absence only counts against it on days the user actually journaled.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        rows = _date_filtered_rows(
            connection, "entry_signals", "entry_date", user_id, start_date, end_date
        )
    return [row["entry_date"] for row in rows]


def get_signals_status(user_id: str = APP_DEFAULT_USER_ID) -> dict[str, int]:
    """Small summary for a status endpoint: how much has been extracted."""
    with _db_lock, closing(_connect()) as connection:
        _ensure_schema(connection)
        extracted = connection.execute(
            "SELECT COUNT(*) AS c FROM entry_signals WHERE user_id = ?", (user_id,)
        ).fetchone()["c"]
        distinct_habits = connection.execute(
            "SELECT COUNT(DISTINCT habit_slug) AS c FROM habit_events WHERE user_id = ?",
            (user_id,),
        ).fetchone()["c"]
        distinct_themes = connection.execute(
            "SELECT COUNT(DISTINCT theme_slug) AS c FROM theme_events WHERE user_id = ?",
            (user_id,),
        ).fetchone()["c"]
    return {
        "extracted_entries": int(extracted),
        "distinct_habits": int(distinct_habits),
        "distinct_themes": int(distinct_themes),
    }

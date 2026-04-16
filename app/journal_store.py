import json
import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import APP_DEFAULT_USER_ID

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("JOURNAL_DB", "data/journal_entries.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def _ensure_journal_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS journal_entries (
            user_id TEXT NOT NULL,
            entry_date TEXT NOT NULL,
            journal_entry TEXT NOT NULL DEFAULT '',
            accomplishments TEXT NOT NULL DEFAULT '',
            gratitude_entry TEXT NOT NULL DEFAULT '',
            photo_data_url TEXT,
            calendar_items_json TEXT NOT NULL DEFAULT '[]',
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, entry_date)
        )
        """
    )


def _ensure_journal_columns(connection: sqlite3.Connection) -> None:
    columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(journal_entries)").fetchall()
    }
    if "gratitude_entry" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN gratitude_entry TEXT NOT NULL DEFAULT ''"
        )
    if "photo_data_url" not in columns:
        connection.execute("ALTER TABLE journal_entries ADD COLUMN photo_data_url TEXT")


def _needs_legacy_migration(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'journal_entries'
        """
    ).fetchone()
    if row is None:
        return False

    columns = connection.execute("PRAGMA table_info(journal_entries)").fetchall()
    column_names = {column["name"] for column in columns}
    primary_keys = {column["name"] for column in columns if column["pk"]}
    return "user_id" not in column_names or primary_keys != {"user_id", "entry_date"}


def _migrate_legacy_journal_table(connection: sqlite3.Connection) -> None:
    connection.execute("ALTER TABLE journal_entries RENAME TO journal_entries_legacy")
    _ensure_journal_schema(connection)

    legacy_columns = {
        row["name"]
        for row in connection.execute("PRAGMA table_info(journal_entries_legacy)").fetchall()
    }
    has_calendar_items = "calendar_items_json" in legacy_columns
    has_gratitude_entry = "gratitude_entry" in legacy_columns
    has_photo_data_url = "photo_data_url" in legacy_columns

    select_sql = (
        """
        SELECT entry_date, journal_entry, accomplishments,
               {gratitude_entry} AS gratitude_entry,
               {photo_data_url} AS photo_data_url,
               {calendar_items_json} AS calendar_items_json,
               updated_at
        FROM journal_entries_legacy
        """
    ).format(
        gratitude_entry="gratitude_entry" if has_gratitude_entry else "''",
        photo_data_url="photo_data_url" if has_photo_data_url else "NULL",
        calendar_items_json="calendar_items_json" if has_calendar_items else "'[]'",
    )

    rows = connection.execute(select_sql).fetchall()
    for row in rows:
        connection.execute(
            """
            INSERT OR REPLACE INTO journal_entries (
                user_id, entry_date, journal_entry, accomplishments, gratitude_entry,
                photo_data_url, calendar_items_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                APP_DEFAULT_USER_ID,
                row["entry_date"],
                row["journal_entry"],
                row["accomplishments"],
                row["gratitude_entry"] or "",
                row["photo_data_url"],
                row["calendar_items_json"] or "[]",
                row["updated_at"],
            ),
        )

    connection.execute("DROP TABLE journal_entries_legacy")


def init_journal_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        if _needs_legacy_migration(connection):
            _migrate_legacy_journal_table(connection)
        else:
            _ensure_journal_schema(connection)
            _ensure_journal_columns(connection)
        connection.commit()


def list_journal_entries(user_id: str = APP_DEFAULT_USER_ID) -> dict[str, dict[str, str | None]]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT entry_date, journal_entry, accomplishments, gratitude_entry,
                   photo_data_url, calendar_items_json, updated_at
            FROM journal_entries
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchall()

    return {
        row["entry_date"]: {
            "journal_entry": row["journal_entry"],
            "accomplishments": row["accomplishments"],
            "gratitude_entry": row["gratitude_entry"],
            "photo_data_url": row["photo_data_url"],
            "calendar_items_json": row["calendar_items_json"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    }


def upsert_journal_entry(
    entry_date: str,
    journal_entry: str,
    accomplishments: str,
    gratitude_entry: str,
    photo_data_url: str | None,
    calendar_items_json: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict[str, str]:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO journal_entries (
                user_id, entry_date, journal_entry, accomplishments, gratitude_entry,
                photo_data_url, calendar_items_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                journal_entry = excluded.journal_entry,
                accomplishments = excluded.accomplishments,
                gratitude_entry = excluded.gratitude_entry,
                photo_data_url = excluded.photo_data_url,
                calendar_items_json = excluded.calendar_items_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                entry_date,
                journal_entry,
                accomplishments,
                gratitude_entry,
                photo_data_url,
                calendar_items_json,
            ),
        )
        row = connection.execute(
            """
            SELECT entry_date, journal_entry, accomplishments, gratitude_entry,
                   photo_data_url, calendar_items_json, updated_at
            FROM journal_entries
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry_date),
        ).fetchone()
        connection.commit()

    return {
        "entry_date": row["entry_date"],
        "journal_entry": row["journal_entry"],
        "accomplishments": row["accomplishments"],
        "gratitude_entry": row["gratitude_entry"],
        "photo_data_url": row["photo_data_url"],
        "calendar_items_json": row["calendar_items_json"],
        "updated_at": row["updated_at"],
    }

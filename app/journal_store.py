import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime
from threading import Lock

from app.config import APP_DEFAULT_USER_ID
from app.journal_api_client import (
    ENTRY_TYPE_FOR_COLUMN,
    list_prose_by_date,
    put_entry_content,
)

_db_lock = Lock()


class _Unset:
    """Sentinel: this field was absent from the request, so leave it as stored.

    Distinct from ``None``/``[]``, which mean "the caller explicitly cleared
    this". Clients that don't own a field (the iOS app has no calendar data,
    for instance) omit it and keep whatever is already there.
    """

    def __repr__(self) -> str:  # pragma: no cover - debug aid only
        return "UNSET"


UNSET = _Unset()

# Shape of a journal_entries row as returned by list_journal_entries, used to
# give journal-api-only dates (no local row yet) the same keys as a SQL row.
_EMPTY_ROW: dict[str, str | None] = {
    "calendar_summary": "",
    "journal_entry": "",
    "accomplishments": "",
    "gratitude_entry": "",
    "scripture_study": "",
    "spiritual_notes": "",
    "study_links_json": "[]",
    "photo_data_url": None,
    "source_photos_json": "[]",
    "world_event_title": None,
    "world_event_summary": "",
    "world_event_source": None,
    "news_articles_json": "[]",
    "news_updated_at": None,
    "calendar_items_json": "[]",
    "updated_at": None,
}


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
            calendar_summary TEXT NOT NULL DEFAULT '',
            journal_entry TEXT NOT NULL DEFAULT '',
            accomplishments TEXT NOT NULL DEFAULT '',
            gratitude_entry TEXT NOT NULL DEFAULT '',
            scripture_study TEXT NOT NULL DEFAULT '',
            spiritual_notes TEXT NOT NULL DEFAULT '',
            study_links_json TEXT NOT NULL DEFAULT '[]',
            photo_data_url TEXT,
            source_photos_json TEXT NOT NULL DEFAULT '[]',
            world_event_title TEXT,
            world_event_summary TEXT NOT NULL DEFAULT '',
            world_event_source TEXT,
            news_articles_json TEXT NOT NULL DEFAULT '[]',
            news_updated_at TEXT,
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
    if "calendar_summary" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN calendar_summary TEXT NOT NULL DEFAULT ''"
        )
    if "scripture_study" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN scripture_study TEXT NOT NULL DEFAULT ''"
        )
    if "spiritual_notes" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN spiritual_notes TEXT NOT NULL DEFAULT ''"
        )
    if "study_links_json" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN study_links_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "photo_data_url" not in columns:
        connection.execute("ALTER TABLE journal_entries ADD COLUMN photo_data_url TEXT")
    if "source_photos_json" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN source_photos_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "world_event_title" not in columns:
        connection.execute("ALTER TABLE journal_entries ADD COLUMN world_event_title TEXT")
    if "world_event_summary" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN world_event_summary TEXT NOT NULL DEFAULT ''"
        )
    if "world_event_source" not in columns:
        connection.execute("ALTER TABLE journal_entries ADD COLUMN world_event_source TEXT")
    if "news_articles_json" not in columns:
        connection.execute(
            "ALTER TABLE journal_entries ADD COLUMN news_articles_json TEXT NOT NULL DEFAULT '[]'"
        )
    if "news_updated_at" not in columns:
        connection.execute("ALTER TABLE journal_entries ADD COLUMN news_updated_at TEXT")


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
    has_scripture_study = "scripture_study" in legacy_columns
    has_spiritual_notes = "spiritual_notes" in legacy_columns
    has_study_links_json = "study_links_json" in legacy_columns
    has_photo_data_url = "photo_data_url" in legacy_columns
    has_world_event_title = "world_event_title" in legacy_columns
    has_world_event_summary = "world_event_summary" in legacy_columns
    has_world_event_source = "world_event_source" in legacy_columns
    has_news_articles_json = "news_articles_json" in legacy_columns
    has_news_updated_at = "news_updated_at" in legacy_columns

    select_sql = (
        """
        SELECT entry_date, journal_entry, accomplishments,
               {calendar_summary} AS calendar_summary,
               {gratitude_entry} AS gratitude_entry,
               {scripture_study} AS scripture_study,
               {spiritual_notes} AS spiritual_notes,
               {study_links_json} AS study_links_json,
               {photo_data_url} AS photo_data_url,
               {world_event_title} AS world_event_title,
               {world_event_summary} AS world_event_summary,
               {world_event_source} AS world_event_source,
               {news_articles_json} AS news_articles_json,
               {news_updated_at} AS news_updated_at,
               {calendar_items_json} AS calendar_items_json,
               updated_at
        FROM journal_entries_legacy
        """
    ).format(
        calendar_summary="calendar_summary" if "calendar_summary" in legacy_columns else "''",
        gratitude_entry="gratitude_entry" if has_gratitude_entry else "''",
        scripture_study="scripture_study" if has_scripture_study else "''",
        spiritual_notes="spiritual_notes" if has_spiritual_notes else "''",
        study_links_json="study_links_json" if has_study_links_json else "'[]'",
        photo_data_url="photo_data_url" if has_photo_data_url else "NULL",
        world_event_title="world_event_title" if has_world_event_title else "NULL",
        world_event_summary="world_event_summary" if has_world_event_summary else "''",
        world_event_source="world_event_source" if has_world_event_source else "NULL",
        news_articles_json="news_articles_json" if has_news_articles_json else "'[]'",
        news_updated_at="news_updated_at" if has_news_updated_at else "NULL",
        calendar_items_json="calendar_items_json" if has_calendar_items else "'[]'",
    )

    rows = connection.execute(select_sql).fetchall()
    for row in rows:
        connection.execute(
            """
            INSERT OR REPLACE INTO journal_entries (
                user_id, entry_date, calendar_summary, journal_entry, accomplishments, gratitude_entry,
                scripture_study, spiritual_notes, study_links_json, photo_data_url, world_event_title, world_event_summary, world_event_source,
                news_articles_json, news_updated_at, calendar_items_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                APP_DEFAULT_USER_ID,
                row["entry_date"],
                row["calendar_summary"] or "",
                row["journal_entry"],
                row["accomplishments"],
                row["gratitude_entry"] or "",
                row["scripture_study"] or "",
                row["spiritual_notes"] or "",
                row["study_links_json"] or "[]",
                row["photo_data_url"],
                row["world_event_title"],
                row["world_event_summary"] or "",
                row["world_event_source"],
                row["news_articles_json"] or "[]",
                row["news_updated_at"],
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


def list_journal_entries(
    user_id: str = APP_DEFAULT_USER_ID,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, dict[str, str | None]]:
    """Full journal rows keyed by entry_date, prose overlaid from journal-api.

    ``start``/``end`` are inclusive ISO dates bounding both the local query and
    the journal-api fetch. Callers that need only a known span should pass them
    so a single-day read doesn't pull the whole archive over HTTP. Omitting both
    returns every entry, as before.
    """
    where_clauses = ["user_id = ?"]
    params: list[str] = [user_id]
    if start:
        where_clauses.append("entry_date >= ?")
        params.append(start)
    if end:
        where_clauses.append("entry_date <= ?")
        params.append(end)

    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        rows = connection.execute(
            f"""
            SELECT entry_date, calendar_summary, journal_entry, accomplishments, gratitude_entry,
                   scripture_study, spiritual_notes, study_links_json,
                   photo_data_url, source_photos_json, world_event_title, world_event_summary, world_event_source,
                   news_articles_json, news_updated_at, calendar_items_json, updated_at
            FROM journal_entries
            WHERE {' AND '.join(where_clauses)}
            """,
            params,
        ).fetchall()

    entries: dict[str, dict[str, str | None]] = {
        row["entry_date"]: {
            "calendar_summary": row["calendar_summary"],
            "journal_entry": row["journal_entry"],
            "accomplishments": row["accomplishments"],
            "gratitude_entry": row["gratitude_entry"],
            "scripture_study": row["scripture_study"],
            "spiritual_notes": row["spiritual_notes"],
            "study_links_json": row["study_links_json"],
            "photo_data_url": row["photo_data_url"],
            "source_photos_json": row["source_photos_json"],
            "world_event_title": row["world_event_title"],
            "world_event_summary": row["world_event_summary"],
            "world_event_source": row["world_event_source"],
            "news_articles_json": row["news_articles_json"],
            "news_updated_at": row["news_updated_at"],
            "calendar_items_json": row["calendar_items_json"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    }

    # journal-api is the system of record for prose, so its journal_entry /
    # scripture_study values replace whatever the local columns still hold. A
    # date the service knows about but SQLite doesn't gets a default row, so a
    # prose-only day is still visible to callers.
    for entry_date, prose in list_prose_by_date(user_id, start=start, end=end).items():
        entries.setdefault(entry_date, dict(_EMPTY_ROW)).update(prose)

    return entries


def _content_clause() -> str:
    """SQL predicate matching days with user-authored journal content.

    Excludes auto-populated calendar/news fields, which get persisted for days
    the user never journaled on (see journal._build_journal_entries).
    """
    return (
        "("
        "TRIM(journal_entry) <> ''"
        " OR TRIM(accomplishments) <> ''"
        " OR TRIM(gratitude_entry) <> ''"
        " OR TRIM(scripture_study) <> ''"
        " OR TRIM(spiritual_notes) <> ''"
        " OR COALESCE(photo_data_url, '') <> ''"
        ")"
    )


def _journal_search_clause(query: str) -> tuple[str, list[str]]:
    trimmed_query = query.strip()

    # A bare 4-digit year is a year filter, not a free-text search: match it
    # precisely against the date prefix so "2019" returns that year's entries
    # rather than every entry whose prose happens to contain "2019".
    if re.fullmatch(r"\d{4}", trimmed_query):
        return "entry_date LIKE ?", [f"{trimmed_query}-%"]

    like_value = f"%{trimmed_query}%"
    clause_parts = [
        "entry_date LIKE ?",
        "journal_entry LIKE ?",
        "calendar_summary LIKE ?",
        "accomplishments LIKE ?",
        "gratitude_entry LIKE ?",
        "scripture_study LIKE ?",
        "spiritual_notes LIKE ?",
        "world_event_title LIKE ?",
        "world_event_summary LIKE ?",
        """
        EXISTS (
            SELECT 1
            FROM json_each(journal_entries.calendar_items_json)
            WHERE LOWER(COALESCE(json_extract(json_each.value, '$.title'), '')) LIKE LOWER(?)
        )
        """.strip(),
    ]
    params = [like_value] * len(clause_parts)

    date_patterns: list[str] = []
    normalized = " ".join(trimmed_query.replace(",", " ").split())
    current_year = datetime.now().year
    candidate_formats = [
        ("%Y-%m-%d", True),
        ("%B %d %Y", True),
        ("%b %d %Y", True),
        ("%B %d", False),
        ("%b %d", False),
        ("%m/%d/%Y", True),
        ("%m/%d", False),
        ("%m-%d-%Y", True),
        ("%m-%d", False),
    ]

    for date_format, has_year in candidate_formats:
        try:
            parsed = datetime.strptime(normalized, date_format)
        except ValueError:
            continue

        if has_year:
            date_patterns.append(parsed.date().isoformat())
        else:
            date_patterns.append(f"%-{parsed.strftime('%m-%d')}")

    exact_iso_dates: set[str] = set()
    for date_pattern in dict.fromkeys(date_patterns):
        clause_parts.append("entry_date LIKE ?")
        params.append(date_pattern)
        if not date_pattern.startswith("%-"):
            exact_iso_dates.add(date_pattern)

    if normalized:
        for with_year in (
            f"{normalized} {current_year}",
            f"{normalized}, {current_year}",
        ):
            for date_format in ("%B %d %Y", "%b %d %Y"):
                try:
                    parsed = datetime.strptime(with_year, date_format)
                except ValueError:
                    continue
                iso_date = parsed.date().isoformat()
                if iso_date not in exact_iso_dates:
                    clause_parts.append("entry_date = ?")
                    params.append(iso_date)
                    exact_iso_dates.add(iso_date)

    return f"({' OR '.join(clause_parts)})", params


def list_journal_entry_dates(
    limit: int,
    before_date: str | None = None,
    query: str = "",
    content_only: bool = False,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[str]:
    trimmed_query = query.strip()
    where_clauses = ["user_id = ?"]
    params: list[str | int] = [user_id]

    if content_only:
        where_clauses.append(_content_clause())

    if before_date:
        where_clauses.append("entry_date < ?")
        params.append(before_date)

    if trimmed_query:
        search_clause, search_params = _journal_search_clause(trimmed_query)
        where_clauses.append(search_clause)
        params.extend(search_params)

    params.append(limit)

    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        rows = connection.execute(
            f"""
            SELECT entry_date
            FROM journal_entries
            WHERE {' AND '.join(where_clauses)}
            ORDER BY entry_date DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

    return [str(row["entry_date"]) for row in rows]


def count_journal_entries(
    query: str = "",
    content_only: bool = False,
    user_id: str = APP_DEFAULT_USER_ID,
) -> int:
    trimmed_query = query.strip()
    where_clauses = ["user_id = ?"]
    params: list[str] = [user_id]

    if content_only:
        where_clauses.append(_content_clause())

    if trimmed_query:
        search_clause, search_params = _journal_search_clause(trimmed_query)
        where_clauses.append(search_clause)
        params.extend(search_params)

    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        row = connection.execute(
            f"""
            SELECT COUNT(*) AS total
            FROM journal_entries
            WHERE {' AND '.join(where_clauses)}
            """,
            params,
        ).fetchone()

    return int(row["total"]) if row else 0


# Body columns holding user-authored prose that a person may be mentioned in.
# Auto-populated fields (calendar/news) are intentionally excluded.
_PERSON_SEARCH_COLUMNS = (
    "journal_entry",
    "accomplishments",
    "gratitude_entry",
    "scripture_study",
    "spiritual_notes",
)


def find_entries_matching_terms(
    terms: list[str],
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[dict[str, str]]:
    """Coarse LIKE prefilter for journal entries mentioning any term.

    Returns candidate rows (entry_date + the searchable body columns) for any
    entry whose prose contains any term as a substring. Callers apply exact
    word-boundary matching in Python (see ``app/people.py``) to reject
    false positives like "Sam" inside "Samantha". Pushing the substring filter
    into SQL keeps the Python-side scan small.
    """
    clean_terms = [t.strip() for t in terms if t and t.strip()]
    if not clean_terms:
        return []

    like_clauses: list[str] = []
    params: list[str] = [user_id]
    for term in clean_terms:
        like_value = f"%{_escape_like(term)}%"
        for column in _PERSON_SEARCH_COLUMNS:
            like_clauses.append(f"{column} LIKE ? ESCAPE '\\'")
            params.append(like_value)

    columns_sql = ", ".join(_PERSON_SEARCH_COLUMNS)
    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        rows = connection.execute(
            f"""
            SELECT entry_date, {columns_sql}
            FROM journal_entries
            WHERE user_id = ? AND ({' OR '.join(like_clauses)})
            ORDER BY entry_date DESC
            """,
            params,
        ).fetchall()

    return [
        {"entry_date": row["entry_date"], **{col: row[col] for col in _PERSON_SEARCH_COLUMNS}}
        for row in rows
    ]


def _escape_like(term: str) -> str:
    # Escape LIKE wildcards in a search term so a name containing % or _ matches
    # literally (paired with ESCAPE '\\' in the query).
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def get_oldest_journal_entry_date(user_id: str = APP_DEFAULT_USER_ID) -> str | None:
    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        row = connection.execute(
            """
            SELECT entry_date
            FROM journal_entries
            WHERE user_id = ?
            ORDER BY entry_date ASC
            LIMIT 1
            """,
            (user_id,),
        ).fetchone()

    return str(row["entry_date"]) if row and row["entry_date"] else None


def upsert_journal_entry(
    entry_date: str,
    journal_entry: str,
    scripture_study: str,
    study_links_json: str,
    photo_data_url: str | None | _Unset = UNSET,
    calendar_items_json: str | _Unset = UNSET,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict[str, str]:
    """Write the two author-filled sections for a day: journal entry + study.

    Split write. The prose (``journal_entry`` / ``scripture_study``) goes to
    journal-api, which is its system of record; the remaining columns
    (``study_links_json``, ``photo_data_url``, ``calendar_items_json``) keep
    writing to local SQLite exactly as before.

    The retired columns ``accomplishments``, ``gratitude_entry`` and
    ``spiritual_notes`` are intentionally NOT written here: on INSERT they fall
    back to their ``''`` schema defaults, and on UPDATE they are omitted from
    the SET clause so any historical values authored before the redesign are
    preserved untouched. The local ``journal_entry`` / ``scripture_study``
    columns are now omitted for the same reason — prose lives in journal-api,
    and the pre-migration local values are left in place rather than cleared.

    ``photo_data_url`` and ``calendar_items_json`` default to ``UNSET``, meaning
    "leave whatever is stored". Passing ``None`` / ``"[]"`` explicitly still
    clears them. This lets a client that doesn't own those fields (the iOS app
    holds no calendar data) save prose without erasing the day's photo and agenda.
    """
    # Replace-only: each PUT carries that section's complete body.
    stored_prose = {
        column: put_entry_content(user_id, entry_date, entry_type, content)
        for column, entry_type, content in (
            ("journal_entry", ENTRY_TYPE_FOR_COLUMN["journal_entry"], journal_entry),
            ("scripture_study", ENTRY_TYPE_FOR_COLUMN["scripture_study"], scripture_study),
        )
    }

    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        # Only the columns the caller actually supplied take part in the write;
        # an UNSET column is left out of both the INSERT and the SET clause so
        # its stored value survives.
        columns = ["user_id", "entry_date", "calendar_summary", "study_links_json"]
        placeholders = ["?", "?", "''", "?"]
        params: list[str | None] = [user_id, entry_date, study_links_json]
        assignments = ["study_links_json = excluded.study_links_json"]

        for column, value in (
            ("photo_data_url", photo_data_url),
            ("calendar_items_json", calendar_items_json),
        ):
            if isinstance(value, _Unset):
                continue
            columns.append(column)
            placeholders.append("?")
            params.append(value)
            assignments.append(f"{column} = excluded.{column}")

        columns.append("updated_at")
        placeholders.append("CURRENT_TIMESTAMP")
        assignments.append("updated_at = CURRENT_TIMESTAMP")

        connection.execute(
            f"""
            INSERT INTO journal_entries ({', '.join(columns)})
            VALUES ({', '.join(placeholders)})
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                {', '.join(assignments)}
            """,
            params,
        )
        row = connection.execute(
            """
            SELECT entry_date, calendar_summary, journal_entry, accomplishments, gratitude_entry,
                   scripture_study, spiritual_notes, study_links_json,
                   photo_data_url, source_photos_json, world_event_title, world_event_summary, world_event_source,
                   news_articles_json, news_updated_at, calendar_items_json, updated_at
            FROM journal_entries
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry_date),
        ).fetchone()
        connection.commit()

    # Prose comes from what journal-api just stored, not the local columns
    # (which still hold pre-migration values and are no longer written).
    return {
        "entry_date": row["entry_date"],
        "calendar_summary": row["calendar_summary"],
        "journal_entry": stored_prose["journal_entry"],
        "accomplishments": row["accomplishments"],
        "gratitude_entry": row["gratitude_entry"],
        "scripture_study": stored_prose["scripture_study"],
        "spiritual_notes": row["spiritual_notes"],
        "study_links_json": row["study_links_json"],
        "photo_data_url": row["photo_data_url"],
        "source_photos_json": row["source_photos_json"],
        "world_event_title": row["world_event_title"],
        "world_event_summary": row["world_event_summary"],
        "world_event_source": row["world_event_source"],
        "news_articles_json": row["news_articles_json"],
        "news_updated_at": row["news_updated_at"],
        "calendar_items_json": row["calendar_items_json"],
        "updated_at": row["updated_at"],
    }


def set_journal_source_photos(
    entry_date: str,
    source_photos_json: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> None:
    """Record the source page images a committed entry was transcribed from.

    Assumes the entry row already exists (commit upserts the body first). Only
    touches source_photos_json so it never disturbs prose/calendar/news columns.
    """
    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        connection.execute(
            """
            UPDATE journal_entries
            SET source_photos_json = ?
            WHERE user_id = ? AND entry_date = ?
            """,
            (source_photos_json, user_id, entry_date),
        )
        connection.commit()


def upsert_journal_news(
    entry_date: str,
    world_event_title: str | None,
    world_event_summary: str,
    world_event_source: str | None,
    news_articles_json: str = "[]",
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict[str, str | None]:
    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        connection.execute(
            """
            INSERT INTO journal_entries (
                user_id, entry_date, world_event_title, world_event_summary, world_event_source,
                news_articles_json, news_updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                world_event_title = excluded.world_event_title,
                world_event_summary = excluded.world_event_summary,
                world_event_source = excluded.world_event_source,
                news_articles_json = excluded.news_articles_json,
                news_updated_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                entry_date,
                world_event_title,
                world_event_summary,
                world_event_source,
                news_articles_json,
            ),
        )
        row = connection.execute(
            """
            SELECT entry_date, world_event_title, world_event_summary, world_event_source,
                   news_articles_json, news_updated_at
            FROM journal_entries
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry_date),
        ).fetchone()
        connection.commit()

    return {
        "entry_date": row["entry_date"],
        "world_event_title": row["world_event_title"],
        "world_event_summary": row["world_event_summary"],
        "world_event_source": row["world_event_source"],
        "news_articles_json": row["news_articles_json"],
        "news_updated_at": row["news_updated_at"],
    }


def upsert_journal_calendar(
    entry_date: str,
    calendar_summary: str,
    calendar_items_json: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict[str, str | None]:
    with _db_lock, closing(_connect()) as connection:
        _ensure_journal_schema(connection)
        _ensure_journal_columns(connection)
        connection.execute(
            """
            INSERT INTO journal_entries (
                user_id, entry_date, calendar_summary, calendar_items_json
            )
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id, entry_date) DO UPDATE SET
                calendar_summary = excluded.calendar_summary,
                calendar_items_json = excluded.calendar_items_json
            """,
            (
                user_id,
                entry_date,
                calendar_summary,
                calendar_items_json,
            ),
        )
        row = connection.execute(
            """
            SELECT entry_date, calendar_summary, calendar_items_json
            FROM journal_entries
            WHERE user_id = ? AND entry_date = ?
            """,
            (user_id, entry_date),
        ).fetchone()
        connection.commit()

    return {
        "entry_date": row["entry_date"],
        "calendar_summary": row["calendar_summary"],
        "calendar_items_json": row["calendar_items_json"],
    }

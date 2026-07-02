"""People registry: canonical names, aliases, and per-instance PhotoPrism refs.

Follows the same idempotent-schema convention as the other stores: schema is
created/upgraded inside ``init_people_store()`` via ``CREATE TABLE IF NOT
EXISTS`` and is wired into the FastAPI startup hook in ``app/main.py``. SQLite
has no native array type, so aliases live in a ``people_aliases`` child table.
"""

import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from threading import Lock
from uuid import uuid4

from app.config import APP_DEFAULT_USER_ID, PEOPLE_DB

_db_lock = Lock()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _connect() -> sqlite3.Connection:
    directory = os.path.dirname(PEOPLE_DB)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(PEOPLE_DB)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_people_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                canonical_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS people_aliases (
                person_id TEXT NOT NULL,
                alias TEXT NOT NULL,
                PRIMARY KEY (person_id, alias),
                FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS people_photoprism (
                person_id TEXT NOT NULL,
                instance_key TEXT NOT NULL,
                subject_uid TEXT NOT NULL,
                subject_name TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (person_id, instance_key, subject_uid),
                FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
            )
            """
        )
        connection.commit()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def _aliases_for(connection: sqlite3.Connection, person_id: str) -> list[str]:
    rows = connection.execute(
        "SELECT alias FROM people_aliases WHERE person_id = ? ORDER BY alias",
        (person_id,),
    ).fetchall()
    return [row["alias"] for row in rows]


def _photoprism_for(connection: sqlite3.Connection, person_id: str) -> list[dict[str, str]]:
    rows = connection.execute(
        """
        SELECT instance_key, subject_uid, subject_name
        FROM people_photoprism
        WHERE person_id = ?
        ORDER BY instance_key, subject_name
        """,
        (person_id,),
    ).fetchall()
    return [
        {
            "instance_key": row["instance_key"],
            "subject_uid": row["subject_uid"],
            "subject_name": row["subject_name"],
        }
        for row in rows
    ]


def _person_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "canonical_name": row["canonical_name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "aliases": _aliases_for(connection, row["id"]),
        "photoprism": _photoprism_for(connection, row["id"]),
    }


def list_people(user_id: str = APP_DEFAULT_USER_ID) -> list[dict]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            "SELECT * FROM people WHERE user_id = ? ORDER BY canonical_name",
            (user_id,),
        ).fetchall()
        return [_person_dict(connection, row) for row in rows]


def get_person(person_id: str, user_id: str = APP_DEFAULT_USER_ID) -> dict | None:
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            "SELECT * FROM people WHERE id = ? AND user_id = ?",
            (person_id, user_id),
        ).fetchone()
        return _person_dict(connection, row) if row else None


# ---------------------------------------------------------------------------
# Writes (used by the admin API and seeding helpers)
# ---------------------------------------------------------------------------

def create_person(
    canonical_name: str,
    aliases: list[str] | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    canonical_name = canonical_name.strip()
    if not canonical_name:
        raise ValueError("canonical_name is required.")
    person_id = uuid4().hex
    now = _utc_now()
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO people (id, user_id, canonical_name, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (person_id, user_id, canonical_name, now, now),
        )
        _replace_aliases(connection, person_id, aliases or [])
        connection.commit()
        row = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        return _person_dict(connection, row)


def update_person(
    person_id: str,
    canonical_name: str | None = None,
    aliases: list[str] | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            "SELECT * FROM people WHERE id = ? AND user_id = ?",
            (person_id, user_id),
        ).fetchone()
        if row is None:
            raise ValueError("Person not found.")
        if canonical_name is not None:
            trimmed = canonical_name.strip()
            if not trimmed:
                raise ValueError("canonical_name cannot be empty.")
            connection.execute(
                "UPDATE people SET canonical_name = ?, updated_at = ? WHERE id = ?",
                (trimmed, _utc_now(), person_id),
            )
        if aliases is not None:
            _replace_aliases(connection, person_id, aliases)
            connection.execute(
                "UPDATE people SET updated_at = ? WHERE id = ?",
                (_utc_now(), person_id),
            )
        connection.commit()
        row = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        return _person_dict(connection, row)


def delete_person(person_id: str, user_id: str = APP_DEFAULT_USER_ID) -> bool:
    with _db_lock, closing(_connect()) as connection:
        cursor = connection.execute(
            "DELETE FROM people WHERE id = ? AND user_id = ?",
            (person_id, user_id),
        )
        connection.commit()
        return cursor.rowcount > 0


def _replace_aliases(connection: sqlite3.Connection, person_id: str, aliases: list[str]) -> None:
    connection.execute("DELETE FROM people_aliases WHERE person_id = ?", (person_id,))
    seen: set[str] = set()
    for alias in aliases:
        trimmed = alias.strip()
        key = trimmed.lower()
        if not trimmed or key in seen:
            continue
        seen.add(key)
        connection.execute(
            "INSERT INTO people_aliases (person_id, alias) VALUES (?, ?)",
            (person_id, trimmed),
        )


def set_photoprism_ref(
    person_id: str,
    instance_key: str,
    subject_uid: str,
    subject_name: str = "",
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    instance_key = instance_key.strip().lower()
    subject_uid = subject_uid.strip()
    if not instance_key or not subject_uid:
        raise ValueError("instance_key and subject_uid are required.")
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            "SELECT id FROM people WHERE id = ? AND user_id = ?",
            (person_id, user_id),
        ).fetchone()
        if row is None:
            raise ValueError("Person not found.")
        connection.execute(
            """
            INSERT INTO people_photoprism (person_id, instance_key, subject_uid, subject_name)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(person_id, instance_key, subject_uid) DO UPDATE SET
                subject_name = excluded.subject_name
            """,
            (person_id, instance_key, subject_uid, subject_name.strip()),
        )
        connection.execute(
            "UPDATE people SET updated_at = ? WHERE id = ?",
            (_utc_now(), person_id),
        )
        connection.commit()
        row = connection.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
        return _person_dict(connection, row)


def delete_photoprism_ref(
    person_id: str,
    instance_key: str,
    subject_uid: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> bool:
    with _db_lock, closing(_connect()) as connection:
        owns = connection.execute(
            "SELECT id FROM people WHERE id = ? AND user_id = ?",
            (person_id, user_id),
        ).fetchone()
        if owns is None:
            return False
        cursor = connection.execute(
            """
            DELETE FROM people_photoprism
            WHERE person_id = ? AND instance_key = ? AND subject_uid = ?
            """,
            (person_id, instance_key.strip().lower(), subject_uid.strip()),
        )
        connection.commit()
        return cursor.rowcount > 0

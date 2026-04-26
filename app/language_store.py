import json
import os
import re
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from threading import Lock
from uuid import uuid4

from app.config import APP_DEFAULT_USER_ID, LANGUAGE_DB

_db_lock = Lock()


def _utc_now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _connect() -> sqlite3.Connection:
    directory = os.path.dirname(LANGUAGE_DB)
    if directory:
        os.makedirs(directory, exist_ok=True)
    connection = sqlite3.connect(LANGUAGE_DB)
    connection.row_factory = sqlite3.Row
    return connection


def _normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def init_language_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS language_profiles (
                user_id TEXT PRIMARY KEY,
                target_languages TEXT NOT NULL,
                active_language TEXT NOT NULL,
                level TEXT NOT NULL,
                daily_goal_minutes INTEGER NOT NULL,
                correction_style TEXT NOT NULL,
                romanization INTEGER NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS language_vocab (
                user_id TEXT NOT NULL,
                vocab_id TEXT NOT NULL,
                language TEXT NOT NULL,
                phrase TEXT NOT NULL,
                translation TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                tags TEXT NOT NULL DEFAULT '[]',
                review_count INTEGER NOT NULL DEFAULT 0,
                last_reviewed_at TEXT,
                next_review_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, vocab_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS language_sessions (
                user_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                language TEXT NOT NULL,
                mode TEXT NOT NULL,
                minutes INTEGER NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (user_id, session_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS language_word_explanations (
                user_id TEXT NOT NULL,
                language TEXT NOT NULL,
                level TEXT NOT NULL,
                word_key TEXT NOT NULL,
                word TEXT NOT NULL,
                translation TEXT NOT NULL DEFAULT '',
                payload TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, language, level, word_key)
            )
            """
        )
        connection.commit()


def get_profile_record(user_id: str = APP_DEFAULT_USER_ID) -> sqlite3.Row | None:
    with _db_lock, closing(_connect()) as connection:
        return connection.execute(
            """
            SELECT target_languages, active_language, level, daily_goal_minutes,
                   correction_style, romanization, updated_at
            FROM language_profiles
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()


def save_profile_record(
    target_languages: list[str],
    active_language: str,
    level: str,
    daily_goal_minutes: int,
    correction_style: str,
    romanization: bool,
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row:
    now = _utc_now()
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO language_profiles (
                user_id, target_languages, active_language, level, daily_goal_minutes,
                correction_style, romanization, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                target_languages = excluded.target_languages,
                active_language = excluded.active_language,
                level = excluded.level,
                daily_goal_minutes = excluded.daily_goal_minutes,
                correction_style = excluded.correction_style,
                romanization = excluded.romanization,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                json.dumps(target_languages),
                active_language,
                level,
                daily_goal_minutes,
                correction_style,
                1 if romanization else 0,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT target_languages, active_language, level, daily_goal_minutes,
                   correction_style, romanization, updated_at
            FROM language_profiles
            WHERE user_id = ?
            """,
            (user_id,),
        ).fetchone()
        connection.commit()
    return row


def list_vocab_records(user_id: str = APP_DEFAULT_USER_ID, limit: int = 3000) -> list[sqlite3.Row]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT vocab_id, language, phrase, translation, notes, tags, review_count,
                   last_reviewed_at, next_review_at, created_at, updated_at
            FROM language_vocab
            WHERE user_id = ? AND deleted = 0
            ORDER BY COALESCE(next_review_at, created_at) ASC, updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
    return list(rows)


def seed_common_word_records(
    common_words: dict[str, list[dict]],
    user_id: str = APP_DEFAULT_USER_ID,
) -> int:
    now = _utc_now()
    inserted = 0
    with _db_lock, closing(_connect()) as connection:
        for language in common_words:
            connection.execute(
                """
                UPDATE language_vocab
                SET deleted = 1, updated_at = ?
                WHERE user_id = ?
                  AND language = ?
                  AND deleted = 0
                  AND tags LIKE '%common-600%'
                  AND tags NOT LIKE '%common-v2%'
                """,
                (now, user_id, language),
            )

        existing_rows = connection.execute(
            """
            SELECT language, phrase
            FROM language_vocab
            WHERE user_id = ? AND deleted = 0
            """,
            (user_id,),
        ).fetchall()
        existing = {
            (row["language"], _normalize_text(row["phrase"]))
            for row in existing_rows
        }

        for language, items in common_words.items():
            for item in items:
                word = str(item.get("word") or "").strip()
                translation = str(item.get("translation") or "").strip()
                if not word or not translation:
                    continue
                key = (language, _normalize_text(word))
                if key in existing:
                    continue

                rank = int(item.get("rank") or 0)
                part_of_speech = str(item.get("part_of_speech") or "other").strip() or "other"
                notes = str(item.get("notes") or "").strip()
                tags = [
                    "word",
                    "common-600",
                    "common-v2",
                    f"rank-{rank}",
                    part_of_speech,
                ]
                connection.execute(
                    """
                    INSERT INTO language_vocab (
                        user_id, vocab_id, language, phrase, translation, notes, tags,
                        created_at, updated_at, next_review_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        f"common:{language}:{rank}:{uuid4().hex[:8]}",
                        language,
                        word,
                        translation,
                        notes,
                        json.dumps(tags),
                        now,
                        now,
                        now,
                    ),
                )
                existing.add(key)
                inserted += 1

        connection.commit()
    return inserted


def save_vocab_record(
    language: str,
    phrase: str,
    translation: str,
    notes: str,
    tags: list[str],
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row:
    now = _utc_now()
    vocab_id = uuid4().hex
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO language_vocab (
                user_id, vocab_id, language, phrase, translation, notes, tags,
                created_at, updated_at, next_review_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id,
                vocab_id,
                language,
                phrase,
                translation,
                notes,
                json.dumps(tags),
                now,
                now,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT vocab_id, language, phrase, translation, notes, tags, review_count,
                   last_reviewed_at, next_review_at, created_at, updated_at
            FROM language_vocab
            WHERE user_id = ? AND vocab_id = ?
            """,
            (user_id, vocab_id),
        ).fetchone()
        connection.commit()
    return row


def review_vocab_record(vocab_id: str, remembered: bool, user_id: str = APP_DEFAULT_USER_ID) -> sqlite3.Row:
    now_dt = datetime.utcnow().replace(microsecond=0)
    now = now_dt.isoformat() + "Z"
    with _db_lock, closing(_connect()) as connection:
        current = connection.execute(
            """
            SELECT review_count
            FROM language_vocab
            WHERE user_id = ? AND vocab_id = ? AND deleted = 0
            """,
            (user_id, vocab_id),
        ).fetchone()
        if current is None:
            raise RuntimeError("Vocabulary item not found.")

        next_count = int(current["review_count"]) + 1
        days_until_next = min(30, 2 ** min(next_count, 5)) if remembered else 1
        next_review_at = (now_dt + timedelta(days=days_until_next)).isoformat() + "Z"
        connection.execute(
            """
            UPDATE language_vocab
            SET review_count = ?, last_reviewed_at = ?, next_review_at = ?, updated_at = ?
            WHERE user_id = ? AND vocab_id = ?
            """,
            (next_count, now, next_review_at, now, user_id, vocab_id),
        )
        row = connection.execute(
            """
            SELECT vocab_id, language, phrase, translation, notes, tags, review_count,
                   last_reviewed_at, next_review_at, created_at, updated_at
            FROM language_vocab
            WHERE user_id = ? AND vocab_id = ?
            """,
            (user_id, vocab_id),
        ).fetchone()
        connection.commit()
    return row


def list_session_records(user_id: str = APP_DEFAULT_USER_ID, limit: int = 20) -> list[sqlite3.Row]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT session_id, language, mode, minutes, notes, created_at
            FROM language_sessions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()
    return list(rows)


def save_session_record(
    language: str,
    mode: str,
    minutes: int,
    notes: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row:
    now = _utc_now()
    session_id = uuid4().hex
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO language_sessions (
                user_id, session_id, language, mode, minutes, notes, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (user_id, session_id, language, mode, minutes, notes, now),
        )
        row = connection.execute(
            """
            SELECT session_id, language, mode, minutes, notes, created_at
            FROM language_sessions
            WHERE user_id = ? AND session_id = ?
            """,
            (user_id, session_id),
        ).fetchone()
        connection.commit()
    return row


def get_word_explanation_record(
    language: str,
    level: str,
    word: str,
    translation: str,
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row | None:
    word_key = _normalize_text(f"{word}:{translation}")
    with _db_lock, closing(_connect()) as connection:
        return connection.execute(
            """
            SELECT payload, updated_at
            FROM language_word_explanations
            WHERE user_id = ? AND language = ? AND level = ? AND word_key = ?
            """,
            (user_id, language, level, word_key),
        ).fetchone()


def save_word_explanation_record(
    language: str,
    level: str,
    word: str,
    translation: str,
    payload: dict,
    user_id: str = APP_DEFAULT_USER_ID,
) -> sqlite3.Row:
    now = _utc_now()
    word_key = _normalize_text(f"{word}:{translation}")
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO language_word_explanations (
                user_id, language, level, word_key, word, translation, payload, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, language, level, word_key) DO UPDATE SET
                word = excluded.word,
                translation = excluded.translation,
                payload = excluded.payload,
                updated_at = excluded.updated_at
            """,
            (
                user_id,
                language,
                level,
                word_key,
                word,
                translation,
                json.dumps(payload, ensure_ascii=False),
                now,
                now,
            ),
        )
        row = connection.execute(
            """
            SELECT payload, updated_at
            FROM language_word_explanations
            WHERE user_id = ? AND language = ? AND level = ? AND word_key = ?
            """,
            (user_id, language, level, word_key),
        ).fetchone()
        connection.commit()
    return row

import json
import os
import sqlite3
from contextlib import closing
from threading import Lock
from uuid import uuid4

from app.config import APP_DEFAULT_USER_ID, ASSISTANT_CHAT_DB
from app.schemas import AssistantChatListResponse, AssistantChatSummary, AssistantChatThread, AssistantSource, AssistantStoredMessage

_db_lock = Lock()


def _db_path() -> str:
    path = ASSISTANT_CHAT_DB
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_assistant_chat_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assistant_chats (
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, chat_id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS assistant_messages (
                user_id TEXT NOT NULL,
                message_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                bullets_json TEXT NOT NULL DEFAULT '[]',
                follow_ups_json TEXT NOT NULL DEFAULT '[]',
                sources_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, message_id)
            )
            """
        )
        connection.commit()


def create_chat(*, title: str, user_id: str = APP_DEFAULT_USER_ID) -> str:
    chat_id = uuid4().hex
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO assistant_chats (user_id, chat_id, title, created_at, updated_at)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (user_id, chat_id, title.strip() or "New chat"),
        )
        connection.commit()
    return chat_id


def ensure_chat(chat_id: str, *, title: str | None = None, user_id: str = APP_DEFAULT_USER_ID) -> str:
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            """
            SELECT chat_id
            FROM assistant_chats
            WHERE user_id = ? AND chat_id = ?
            """,
            (user_id, chat_id),
        ).fetchone()
        if row is None:
            connection.execute(
                """
                INSERT INTO assistant_chats (user_id, chat_id, title, created_at, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """,
                (user_id, chat_id, (title or "").strip() or "New chat"),
            )
        elif title and title.strip():
            connection.execute(
                """
                UPDATE assistant_chats
                SET title = CASE WHEN title = '' OR title = 'New chat' THEN ? ELSE title END
                WHERE user_id = ? AND chat_id = ?
                """,
                (title.strip(), user_id, chat_id),
            )
        connection.commit()
    return chat_id


def save_message(
    *,
    chat_id: str,
    role: str,
    content: str,
    bullets: list[str] | None = None,
    follow_ups: list[str] | None = None,
    sources: list[AssistantSource] | None = None,
    user_id: str = APP_DEFAULT_USER_ID,
) -> AssistantStoredMessage:
    message_id = uuid4().hex
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO assistant_messages (
                user_id, message_id, chat_id, role, content, bullets_json,
                follow_ups_json, sources_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                user_id,
                message_id,
                chat_id,
                role,
                content,
                json.dumps(bullets or [], ensure_ascii=True),
                json.dumps(follow_ups or [], ensure_ascii=True),
                json.dumps([source.model_dump() for source in (sources or [])], ensure_ascii=True),
            ),
        )
        connection.execute(
            """
            UPDATE assistant_chats
            SET updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND chat_id = ?
            """,
            (user_id, chat_id),
        )
        row = connection.execute(
            """
            SELECT message_id, role, content, bullets_json, follow_ups_json, sources_json, created_at
            FROM assistant_messages
            WHERE user_id = ? AND message_id = ?
            """,
            (user_id, message_id),
        ).fetchone()
        connection.commit()
    return _row_to_message(row)


def _row_to_message(row: sqlite3.Row) -> AssistantStoredMessage:
    try:
        bullets = json.loads(row["bullets_json"] or "[]")
    except Exception:
        bullets = []
    try:
        follow_ups = json.loads(row["follow_ups_json"] or "[]")
    except Exception:
        follow_ups = []
    try:
        raw_sources = json.loads(row["sources_json"] or "[]")
    except Exception:
        raw_sources = []

    sources = []
    for item in raw_sources:
        try:
            sources.append(AssistantSource.model_validate(item))
        except Exception:
            continue

    return AssistantStoredMessage(
        id=row["message_id"],
        role=row["role"],
        content=row["content"] or "",
        bullets=bullets if isinstance(bullets, list) else [],
        follow_ups=follow_ups if isinstance(follow_ups, list) else [],
        sources=sources,
        created_at=row["created_at"],
    )


def list_chats(*, limit: int = 40, user_id: str = APP_DEFAULT_USER_ID) -> AssistantChatListResponse:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT c.chat_id, c.title, c.updated_at,
                   COUNT(m.message_id) AS message_count,
                   COALESCE(
                     (
                       SELECT content
                       FROM assistant_messages m2
                       WHERE m2.user_id = c.user_id AND m2.chat_id = c.chat_id
                       ORDER BY m2.rowid DESC
                       LIMIT 1
                     ),
                     ''
                   ) AS preview
            FROM assistant_chats c
            LEFT JOIN assistant_messages m
              ON m.user_id = c.user_id AND m.chat_id = c.chat_id
            WHERE c.user_id = ?
            GROUP BY c.chat_id, c.title, c.updated_at
            ORDER BY c.updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

    return AssistantChatListResponse(
        chats=[
            AssistantChatSummary(
                id=row["chat_id"],
                title=row["title"] or "New chat",
                preview=(row["preview"] or "").strip(),
                message_count=int(row["message_count"] or 0),
                updated_at=row["updated_at"],
            )
            for row in rows
        ]
    )


def get_chat_thread(chat_id: str, *, user_id: str = APP_DEFAULT_USER_ID) -> AssistantChatThread:
    with _db_lock, closing(_connect()) as connection:
        chat_row = connection.execute(
            """
            SELECT chat_id, title, updated_at
            FROM assistant_chats
            WHERE user_id = ? AND chat_id = ?
            """,
            (user_id, chat_id),
        ).fetchone()
        if chat_row is None:
            raise RuntimeError("Assistant chat not found.")

        message_rows = connection.execute(
            """
            SELECT message_id, role, content, bullets_json, follow_ups_json, sources_json, created_at
            FROM assistant_messages
            WHERE user_id = ? AND chat_id = ?
            ORDER BY rowid ASC
            """,
            (user_id, chat_id),
        ).fetchall()

    return AssistantChatThread(
        id=chat_row["chat_id"],
        title=chat_row["title"] or "New chat",
        updated_at=chat_row["updated_at"],
        messages=[_row_to_message(row) for row in message_rows],
    )

import json
import os
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
from threading import Lock
from typing import Optional

from app.classification_guidance import get_classification_guidance_version
from app.config import APP_DEFAULT_USER_ID
from app.schemas import EmailClassification, EmailSummary

_db_lock = Lock()
REVIEWED_LABEL = "Reviewed"
_REQUIRED_CLASSIFICATION_FIELDS = {
    "short_summary",
    "why_it_matters",
    "action_items",
    "deadline_hint",
    "suggested_reply",
    "calendar_relevant",
    "calendar_title",
    "calendar_start",
    "calendar_end",
    "calendar_is_all_day",
    "calendar_location",
    "calendar_notes",
}


@dataclass
class CachedClassification:
    classification: EmailClassification
    fingerprint: str


def _db_path() -> str:
    path = os.getenv("CLASSIFICATION_CACHE_DB", "data/classification_cache.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_classification_cache() -> None:
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'classification_cache'
            """
        ).fetchone()
        if row is not None:
            columns = connection.execute("PRAGMA table_info(classification_cache)").fetchall()
            column_names = {column["name"] for column in columns}
            primary_keys = {column["name"] for column in columns if column["pk"]}
            if "user_id" not in column_names or primary_keys != {"user_id", "message_id"}:
                connection.execute("ALTER TABLE classification_cache RENAME TO classification_cache_legacy")
                row = None

        if row is None:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS classification_cache (
                    user_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    thread_id TEXT NOT NULL,
                    subject TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    snippet TEXT NOT NULL,
                    date TEXT,
                    labels_json TEXT NOT NULL,
                    body TEXT,
                    fingerprint TEXT NOT NULL,
                    classification_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (user_id, message_id)
                )
                """
            )
            legacy_exists = connection.execute(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'classification_cache_legacy'
                """
            ).fetchone()
            if legacy_exists is not None:
                rows = connection.execute(
                    """
                    SELECT message_id, thread_id, subject, sender, snippet, date, labels_json, body,
                           fingerprint, classification_json, updated_at
                    FROM classification_cache_legacy
                    """
                ).fetchall()
                for row in rows:
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO classification_cache (
                            user_id, message_id, thread_id, subject, sender, snippet, date,
                            labels_json, body, fingerprint, classification_json, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            APP_DEFAULT_USER_ID,
                            row["message_id"],
                            row["thread_id"],
                            row["subject"],
                            row["sender"],
                            row["snippet"],
                            row["date"],
                            row["labels_json"],
                            row["body"],
                            row["fingerprint"],
                            row["classification_json"],
                            row["updated_at"],
                        ),
                    )
                connection.execute("DROP TABLE classification_cache_legacy")
        connection.commit()


def email_fingerprint(email: EmailSummary) -> str:
    payload = json.dumps(
        {
            "subject": email.subject,
            "sender": email.sender,
            "snippet": email.snippet,
            "date": email.date,
            "labels": sorted(email.labels),
            "body": email.body,
            "guidance_version": get_classification_guidance_version(),
        },
        sort_keys=True,
    )
    return sha256(payload.encode("utf-8")).hexdigest()


def get_cached_classification(
    email: EmailSummary,
    user_id: str = APP_DEFAULT_USER_ID,
) -> Optional[CachedClassification]:
    fingerprint = email_fingerprint(email)
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            """
            SELECT classification_json, fingerprint
            FROM classification_cache
            WHERE user_id = ? AND message_id = ?
            """,
            (user_id, email.id),
        ).fetchone()

    if row is None:
        return None

    is_reviewed_email = REVIEWED_LABEL in (email.labels or [])
    if row["fingerprint"] != fingerprint and not is_reviewed_email:
        return None

    payload = json.loads(row["classification_json"])
    if not _REQUIRED_CLASSIFICATION_FIELDS.issubset(payload.keys()):
        return None

    return CachedClassification(
        classification=EmailClassification.model_validate(payload),
        fingerprint=row["fingerprint"],
    )


def save_classification(
    email: EmailSummary,
    classification: EmailClassification,
    user_id: str = APP_DEFAULT_USER_ID,
) -> None:
    fingerprint = email_fingerprint(email)
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO classification_cache (
                user_id, message_id, thread_id, subject, sender, snippet, date, labels_json, body,
                fingerprint, classification_json, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, message_id) DO UPDATE SET
                thread_id = excluded.thread_id,
                subject = excluded.subject,
                sender = excluded.sender,
                snippet = excluded.snippet,
                date = excluded.date,
                labels_json = excluded.labels_json,
                body = excluded.body,
                fingerprint = excluded.fingerprint,
                classification_json = excluded.classification_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                email.id,
                email.thread_id,
                email.subject,
                email.sender,
                email.snippet,
                email.date,
                json.dumps(email.labels),
                email.body,
                fingerprint,
                classification.model_dump_json(),
            ),
        )
        connection.commit()


def update_cached_email(email: EmailSummary, user_id: str = APP_DEFAULT_USER_ID) -> None:
    with _db_lock, closing(_connect()) as connection:
        row = connection.execute(
            "SELECT classification_json FROM classification_cache WHERE user_id = ? AND message_id = ?",
            (user_id, email.id),
        ).fetchone()
        if row is None:
            return

        connection.execute(
            """
            UPDATE classification_cache
            SET thread_id = ?, subject = ?, sender = ?, snippet = ?, date = ?, labels_json = ?,
                body = ?, fingerprint = ?, updated_at = CURRENT_TIMESTAMP
            WHERE user_id = ? AND message_id = ?
            """,
            (
                email.thread_id,
                email.subject,
                email.sender,
                email.snippet,
                email.date,
                json.dumps(email.labels),
                email.body,
                email_fingerprint(email),
                user_id,
                email.id,
            ),
        )
        connection.commit()


def summarize_cached_classifications(
    mailbox: str,
    limit: int = 200,
    user_id: str = APP_DEFAULT_USER_ID,
) -> dict:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT message_id, thread_id, subject, sender, snippet, date, labels_json, body, classification_json
            FROM classification_cache
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

    normalized_mailbox = (mailbox or "INBOX").strip()
    matched_rows = []
    for row in rows:
        labels = json.loads(row["labels_json"])
        if normalized_mailbox != "ALL" and normalized_mailbox not in labels:
            continue
        matched_rows.append((row, labels, EmailClassification.model_validate(json.loads(row["classification_json"]))))

    categories: dict[str, int] = {}
    urgency: dict[str, int] = {}
    needs_reply = 0
    action_item_count = 0
    deadlines_found = 0
    top_senders: dict[str, int] = {}
    top_action_items: dict[str, dict] = {}
    deadline_highlights: dict[str, dict] = {}

    for row, _, classification in matched_rows:
        categories[classification.category] = categories.get(classification.category, 0) + 1
        urgency[classification.urgency] = urgency.get(classification.urgency, 0) + 1
        if classification.needs_reply:
            needs_reply += 1
        action_item_count += len(classification.action_items)
        for item in classification.action_items:
            cleaned = " ".join(item.split()).strip()
            if cleaned:
                existing = top_action_items.get(cleaned)
                if existing:
                    existing["count"] += 1
                else:
                    top_action_items[cleaned] = {
                        "message_id": row["message_id"],
                        "subject": row["subject"],
                        "sender": row["sender"],
                        "text": cleaned,
                        "count": 1,
                    }
        if classification.deadline_hint:
            deadlines_found += 1
            cleaned_deadline = " ".join(classification.deadline_hint.split()).strip()
            if cleaned_deadline and cleaned_deadline not in deadline_highlights:
                deadline_highlights[cleaned_deadline] = {
                    "message_id": row["message_id"],
                    "subject": row["subject"],
                    "sender": row["sender"],
                    "text": cleaned_deadline,
                    "count": 1,
                }
        top_senders[row["sender"]] = top_senders.get(row["sender"], 0) + 1

    return {
        "mailbox": normalized_mailbox,
        "total_cached": len(matched_rows),
        "needs_reply": needs_reply,
        "action_item_count": action_item_count,
        "deadlines_found": deadlines_found,
        "categories": categories,
        "urgency": urgency,
        "top_senders": [
            {"sender": sender, "count": count}
            for sender, count in sorted(top_senders.items(), key=lambda item: (-item[1], item[0]))[:5]
        ],
        "top_action_items": [
            item
            for _, item in sorted(
                top_action_items.items(),
                key=lambda pair: (-pair[1]["count"], pair[0]),
            )[:5]
        ],
        "deadline_highlights": list(deadline_highlights.values())[:5],
    }


def list_cached_classifications(
    mailbox: str,
    limit: int = 20,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[tuple[EmailSummary, EmailClassification]]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT message_id, thread_id, subject, sender, snippet, date, labels_json, body, classification_json
            FROM classification_cache
            WHERE user_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (user_id, limit),
        ).fetchall()

    normalized_mailbox = (mailbox or "INBOX").strip()
    matched: list[tuple[EmailSummary, EmailClassification]] = []

    for row in rows:
        labels = json.loads(row["labels_json"])
        if normalized_mailbox != "ALL" and normalized_mailbox not in labels:
            continue

        email = EmailSummary(
            id=row["message_id"],
            thread_id=row["thread_id"],
            subject=row["subject"],
            sender=row["sender"],
            snippet=row["snippet"],
            date=row["date"],
            labels=labels,
            body=row["body"],
        )
        classification = EmailClassification.model_validate(json.loads(row["classification_json"]))
        matched.append((email, classification))

    return matched

import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from threading import Lock
from typing import List, Optional
from uuid import uuid4

from app.user_rules import RuleCondition, UserRule

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("USER_RULES_DB", "data/user_rules.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_user_rules_store() -> None:
    with _db_lock, closing(_connect()) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS user_rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                natural_language TEXT NOT NULL,
                conditions_json TEXT NOT NULL,
                target_label TEXT NOT NULL,
                archive INTEGER NOT NULL DEFAULT 1,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )
        """)
        conn.commit()


def _row_to_rule(row: sqlite3.Row) -> UserRule:
    conditions = [RuleCondition(**c) for c in json.loads(row["conditions_json"])]
    return UserRule(
        id=row["id"],
        name=row["name"],
        natural_language=row["natural_language"],
        conditions=conditions,
        target_label=row["target_label"],
        archive=bool(row["archive"]),
        enabled=bool(row["enabled"]),
        created_at=row["created_at"],
    )


def list_user_rules() -> List[UserRule]:
    with _db_lock, closing(_connect()) as conn:
        rows = conn.execute("SELECT * FROM user_rules ORDER BY created_at DESC").fetchall()
    return [_row_to_rule(row) for row in rows]


def create_user_rule(
    name: str,
    natural_language: str,
    conditions: List[RuleCondition],
    target_label: str,
    archive: bool = True,
) -> UserRule:
    rule_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    conditions_json = json.dumps(
        [{"field": c.field, "operator": c.operator, "value": c.value} for c in conditions]
    )
    with _db_lock, closing(_connect()) as conn:
        conn.execute(
            """INSERT INTO user_rules
               (id, name, natural_language, conditions_json, target_label, archive, enabled, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (rule_id, name, natural_language, conditions_json, target_label, int(archive), 1, created_at),
        )
        conn.commit()
    return UserRule(
        id=rule_id,
        name=name,
        natural_language=natural_language,
        conditions=conditions,
        target_label=target_label,
        archive=archive,
        enabled=True,
        created_at=created_at,
    )


def delete_user_rule(rule_id: str) -> None:
    with _db_lock, closing(_connect()) as conn:
        conn.execute("DELETE FROM user_rules WHERE id = ?", (rule_id,))
        conn.commit()


def set_user_rule_enabled(rule_id: str, enabled: bool) -> Optional[UserRule]:
    with _db_lock, closing(_connect()) as conn:
        conn.execute("UPDATE user_rules SET enabled = ? WHERE id = ?", (int(enabled), rule_id))
        conn.commit()
        row = conn.execute("SELECT * FROM user_rules WHERE id = ?", (rule_id,)).fetchone()
    return _row_to_rule(row) if row else None

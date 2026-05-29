import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from app.config import FOOD_LOG_DB

_DB_PATH = FOOD_LOG_DB


def _conn():
    return sqlite3.connect(_DB_PATH, check_same_thread=False)


@contextmanager
def _cursor():
    conn = _conn()
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    finally:
        conn.close()


def init_food_log_store() -> None:
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    with _cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS food_log_entries (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                calories REAL DEFAULT 0,
                protein_g REAL DEFAULT 0,
                carbs_g REAL DEFAULT 0,
                fat_g REAL DEFAULT 0,
                meal TEXT DEFAULT 'Other',
                logged_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS manual_workout_logs (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                user_id TEXT NOT NULL,
                type TEXT NOT NULL,
                duration_minutes INTEGER DEFAULT 0,
                notes TEXT DEFAULT '',
                logged_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS meal_prep_items (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                calories REAL DEFAULT 0,
                protein_g REAL DEFAULT 0,
                carbs_g REAL DEFAULT 0,
                fat_g REAL DEFAULT 0,
                notes TEXT DEFAULT '',
                created_at TEXT NOT NULL
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS macro_targets (
                user_id TEXT PRIMARY KEY,
                calories REAL DEFAULT 2600,
                protein_g REAL DEFAULT 155,
                carbs_g REAL DEFAULT 320,
                fat_g REAL DEFAULT 75
            )
        """)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Food entries ───────────────────────────────────────────────────────────────

def add_food_entry(date: str, user_id: str, name: str, calories: float, protein_g: float, carbs_g: float, fat_g: float, meal: str) -> dict:
    entry_id = uuid4().hex
    logged_at = _now()
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO food_log_entries VALUES (?,?,?,?,?,?,?,?,?,?)",
            (entry_id, date, user_id, name, calories, protein_g, carbs_g, fat_g, meal, logged_at),
        )
    return {"id": entry_id, "date": date, "name": name, "calories": calories, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g, "meal": meal, "logged_at": logged_at}


def update_food_entry(entry_id: str, user_id: str, name: str, calories: float, protein_g: float, carbs_g: float, fat_g: float, meal: str) -> dict | None:
    with _cursor() as cur:
        cur.execute(
            "UPDATE food_log_entries SET name=?,calories=?,protein_g=?,carbs_g=?,fat_g=?,meal=? WHERE id=? AND user_id=?",
            (name, calories, protein_g, carbs_g, fat_g, meal, entry_id, user_id),
        )
        if cur.rowcount == 0:
            return None
        cur.execute("SELECT id,date,name,calories,protein_g,carbs_g,fat_g,meal,logged_at FROM food_log_entries WHERE id=?", (entry_id,))
        r = cur.fetchone()
        return {"id": r[0], "date": r[1], "name": r[2], "calories": r[3], "protein_g": r[4], "carbs_g": r[5], "fat_g": r[6], "meal": r[7], "logged_at": r[8]} if r else None


def delete_food_entry(entry_id: str, user_id: str) -> bool:
    with _cursor() as cur:
        cur.execute("DELETE FROM food_log_entries WHERE id=? AND user_id=?", (entry_id, user_id))
        return cur.rowcount > 0


def get_food_entries(date: str, user_id: str) -> list[dict]:
    with _cursor() as cur:
        cur.execute(
            "SELECT id,date,name,calories,protein_g,carbs_g,fat_g,meal,logged_at FROM food_log_entries WHERE date=? AND user_id=? ORDER BY logged_at",
            (date, user_id),
        )
        return [{"id": r[0], "date": r[1], "name": r[2], "calories": r[3], "protein_g": r[4], "carbs_g": r[5], "fat_g": r[6], "meal": r[7], "logged_at": r[8]} for r in cur.fetchall()]


def get_food_entries_range(user_id: str, days: int) -> dict[str, list[dict]]:
    from datetime import date as _date
    dates = [(_date.today() - timedelta(days=i)).isoformat() for i in range(days)]
    with _cursor() as cur:
        placeholders = ",".join("?" * len(dates))
        cur.execute(
            f"SELECT id,date,name,calories,protein_g,carbs_g,fat_g,meal,logged_at FROM food_log_entries WHERE user_id=? AND date IN ({placeholders}) ORDER BY date DESC,logged_at",
            [user_id] + dates,
        )
        result: dict[str, list] = {d: [] for d in dates}
        for r in cur.fetchall():
            result[r[1]].append({"id": r[0], "date": r[1], "name": r[2], "calories": r[3], "protein_g": r[4], "carbs_g": r[5], "fat_g": r[6], "meal": r[7], "logged_at": r[8]})
    return result


# ── Manual workouts ────────────────────────────────────────────────────────────

def upsert_manual_workout(date: str, user_id: str, type_: str, duration_minutes: int, notes: str) -> dict:
    logged_at = _now()
    with _cursor() as cur:
        cur.execute("SELECT id FROM manual_workout_logs WHERE date=? AND user_id=?", (date, user_id))
        row = cur.fetchone()
        if row:
            workout_id = row[0]
            cur.execute(
                "UPDATE manual_workout_logs SET type=?,duration_minutes=?,notes=?,logged_at=? WHERE id=?",
                (type_, duration_minutes, notes, logged_at, workout_id),
            )
        else:
            workout_id = uuid4().hex
            cur.execute(
                "INSERT INTO manual_workout_logs VALUES (?,?,?,?,?,?,?)",
                (workout_id, date, user_id, type_, duration_minutes, notes, logged_at),
            )
    return {"id": workout_id, "date": date, "type": type_, "duration_minutes": duration_minutes, "notes": notes, "logged_at": logged_at}


def get_manual_workout(date: str, user_id: str) -> dict | None:
    with _cursor() as cur:
        cur.execute(
            "SELECT id,date,type,duration_minutes,notes,logged_at FROM manual_workout_logs WHERE date=? AND user_id=?",
            (date, user_id),
        )
        row = cur.fetchone()
        if not row:
            return None
        return {"id": row[0], "date": row[1], "type": row[2], "duration_minutes": row[3], "notes": row[4], "logged_at": row[5]}


def get_manual_workouts_range(user_id: str, days: int) -> dict[str, dict | None]:
    from datetime import date as _date
    dates = [(_date.today() - timedelta(days=i)).isoformat() for i in range(days)]
    with _cursor() as cur:
        placeholders = ",".join("?" * len(dates))
        cur.execute(
            f"SELECT id,date,type,duration_minutes,notes,logged_at FROM manual_workout_logs WHERE user_id=? AND date IN ({placeholders})",
            [user_id] + dates,
        )
        result: dict[str, dict | None] = {d: None for d in dates}
        for r in cur.fetchall():
            result[r[1]] = {"id": r[0], "date": r[1], "type": r[2], "duration_minutes": r[3], "notes": r[4], "logged_at": r[5]}
    return result


# ── Meal prep library ──────────────────────────────────────────────────────────

def list_meal_prep_items(user_id: str) -> list[dict]:
    with _cursor() as cur:
        cur.execute(
            "SELECT id,name,calories,protein_g,carbs_g,fat_g,notes,created_at FROM meal_prep_items WHERE user_id=? ORDER BY created_at DESC",
            (user_id,),
        )
        return [{"id": r[0], "name": r[1], "calories": r[2], "protein_g": r[3], "carbs_g": r[4], "fat_g": r[5], "notes": r[6], "created_at": r[7]} for r in cur.fetchall()]


def create_meal_prep_item(user_id: str, name: str, calories: float, protein_g: float, carbs_g: float, fat_g: float, notes: str) -> dict:
    item_id = uuid4().hex
    created_at = _now()
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO meal_prep_items VALUES (?,?,?,?,?,?,?,?,?)",
            (item_id, user_id, name, calories, protein_g, carbs_g, fat_g, notes, created_at),
        )
    return {"id": item_id, "name": name, "calories": calories, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g, "notes": notes, "created_at": created_at}


def delete_meal_prep_item(item_id: str, user_id: str) -> bool:
    with _cursor() as cur:
        cur.execute("DELETE FROM meal_prep_items WHERE id=? AND user_id=?", (item_id, user_id))
        return cur.rowcount > 0


# ── Macro targets ──────────────────────────────────────────────────────────────

def get_macro_targets(user_id: str) -> dict:
    with _cursor() as cur:
        cur.execute("SELECT calories,protein_g,carbs_g,fat_g FROM macro_targets WHERE user_id=?", (user_id,))
        row = cur.fetchone()
        if not row:
            return {"calories": 2600, "protein_g": 155, "carbs_g": 320, "fat_g": 75}
        return {"calories": row[0], "protein_g": row[1], "carbs_g": row[2], "fat_g": row[3]}


def upsert_macro_targets(user_id: str, calories: float, protein_g: float, carbs_g: float, fat_g: float) -> dict:
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO macro_targets VALUES (?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET calories=excluded.calories,protein_g=excluded.protein_g,carbs_g=excluded.carbs_g,fat_g=excluded.fat_g",
            (user_id, calories, protein_g, carbs_g, fat_g),
        )
    return {"calories": calories, "protein_g": protein_g, "carbs_g": carbs_g, "fat_g": fat_g}

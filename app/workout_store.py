import json
import os
import sqlite3
from contextlib import closing
from threading import Lock

from app.config import APP_DEFAULT_USER_ID
from app.schemas import WorkoutEntry, WorkoutRoutePoint

_db_lock = Lock()


def _db_path() -> str:
    path = os.getenv("WORKOUT_DB", "data/workouts.db")
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    return path


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(_db_path())
    connection.row_factory = sqlite3.Row
    return connection


def init_workout_store() -> None:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS workouts (
                user_id TEXT NOT NULL,
                workout_id TEXT NOT NULL,
                entry_date TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'ios_healthkit_workout',
                activity_type TEXT NOT NULL DEFAULT 'other',
                activity_label TEXT NOT NULL DEFAULT 'Other',
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                duration_minutes REAL NOT NULL DEFAULT 0,
                total_distance_km REAL,
                active_energy_kcal REAL,
                avg_heart_rate_bpm REAL,
                max_heart_rate_bpm REAL,
                source_name TEXT,
                route_points_json TEXT NOT NULL DEFAULT '[]',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, workout_id)
            )
            """
        )
        connection.commit()


def _decode_route_points(value: str) -> list[WorkoutRoutePoint]:
    try:
        payload = json.loads(value or "[]")
    except json.JSONDecodeError:
        payload = []
    return [WorkoutRoutePoint.model_validate(item) for item in payload]


def _row_to_entry(row: sqlite3.Row) -> WorkoutEntry:
    return WorkoutEntry(
        workout_id=row["workout_id"],
        date=row["entry_date"],
        source=row["source"],
        activity_type=row["activity_type"],
        activity_label=row["activity_label"],
        start_date=row["start_date"],
        end_date=row["end_date"],
        duration_minutes=float(row["duration_minutes"] or 0),
        total_distance_km=row["total_distance_km"],
        active_energy_kcal=row["active_energy_kcal"],
        avg_heart_rate_bpm=row["avg_heart_rate_bpm"],
        max_heart_rate_bpm=row["max_heart_rate_bpm"],
        source_name=row["source_name"],
        route_points=_decode_route_points(row["route_points_json"]),
        synced_at=row["synced_at"],
    )


def upsert_workout(
    workout: WorkoutEntry,
    *,
    user_id: str = APP_DEFAULT_USER_ID,
) -> WorkoutEntry:
    with _db_lock, closing(_connect()) as connection:
        connection.execute(
            """
            INSERT INTO workouts (
                user_id, workout_id, entry_date, source, activity_type, activity_label,
                start_date, end_date, duration_minutes, total_distance_km,
                active_energy_kcal, avg_heart_rate_bpm, max_heart_rate_bpm,
                source_name, route_points_json, synced_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, workout_id) DO UPDATE SET
                entry_date = excluded.entry_date,
                source = excluded.source,
                activity_type = excluded.activity_type,
                activity_label = excluded.activity_label,
                start_date = excluded.start_date,
                end_date = excluded.end_date,
                duration_minutes = excluded.duration_minutes,
                total_distance_km = excluded.total_distance_km,
                active_energy_kcal = excluded.active_energy_kcal,
                avg_heart_rate_bpm = excluded.avg_heart_rate_bpm,
                max_heart_rate_bpm = excluded.max_heart_rate_bpm,
                source_name = excluded.source_name,
                route_points_json = excluded.route_points_json,
                synced_at = CURRENT_TIMESTAMP
            """,
            (
                user_id,
                workout.workout_id,
                workout.date,
                workout.source,
                workout.activity_type,
                workout.activity_label,
                workout.start_date,
                workout.end_date,
                workout.duration_minutes,
                workout.total_distance_km,
                workout.active_energy_kcal,
                workout.avg_heart_rate_bpm,
                workout.max_heart_rate_bpm,
                workout.source_name,
                json.dumps([point.model_dump() for point in workout.route_points], ensure_ascii=True),
            ),
        )
        row = connection.execute(
            """
            SELECT workout_id, entry_date, source, activity_type, activity_label,
                   start_date, end_date, duration_minutes, total_distance_km,
                   active_energy_kcal, avg_heart_rate_bpm, max_heart_rate_bpm,
                   source_name, route_points_json, synced_at
            FROM workouts
            WHERE user_id = ? AND workout_id = ?
            """,
            (user_id, workout.workout_id),
        ).fetchone()
        connection.commit()
    return _row_to_entry(row)


def list_workouts(
    *,
    days: int = 30,
    limit: int = 100,
    user_id: str = APP_DEFAULT_USER_ID,
) -> list[WorkoutEntry]:
    with _db_lock, closing(_connect()) as connection:
        rows = connection.execute(
            """
            SELECT workout_id, entry_date, source, activity_type, activity_label,
                   start_date, end_date, duration_minutes, total_distance_km,
                   active_energy_kcal, avg_heart_rate_bpm, max_heart_rate_bpm,
                   source_name, route_points_json, synced_at
            FROM workouts
            WHERE user_id = ? AND entry_date >= date('now', ?)
            ORDER BY start_date DESC
            LIMIT ?
            """,
            (user_id, f"-{max(days - 1, 0)} day", limit),
        ).fetchall()
    return [_row_to_entry(row) for row in rows]

from app.schemas import (
    WorkoutBatchSyncRequest,
    WorkoutBatchSyncResponse,
    WorkoutEntry,
    WorkoutListResponse,
)
from app.user_context import get_default_user_context
from app.workout_store import init_workout_store, list_workouts, upsert_workout


def sync_workout_batch(payload: WorkoutBatchSyncRequest) -> WorkoutBatchSyncResponse:
    init_workout_store()
    user_id = get_default_user_context().user_id
    saved: list[WorkoutEntry] = []

    for item in payload.workouts:
        saved.append(
            upsert_workout(
                WorkoutEntry(
                    workout_id=item.workout_id,
                    date=item.date,
                    source=item.source,
                    activity_type=item.activity_type,
                    activity_label=item.activity_label,
                    start_date=item.start_date,
                    end_date=item.end_date,
                    duration_minutes=item.duration_minutes,
                    total_distance_km=item.total_distance_km,
                    active_energy_kcal=item.active_energy_kcal,
                    avg_heart_rate_bpm=item.avg_heart_rate_bpm,
                    max_heart_rate_bpm=item.max_heart_rate_bpm,
                    source_name=item.source_name,
                    route_points=item.route_points,
                ),
                user_id=user_id,
            )
        )

    return WorkoutBatchSyncResponse(saved=len(saved), workouts=saved)


def list_workout_entries(days: int = 30, limit: int = 100) -> WorkoutListResponse:
    init_workout_store()
    user_id = get_default_user_context().user_id
    return WorkoutListResponse(workouts=list_workouts(days=days, limit=limit, user_id=user_id))

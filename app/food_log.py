import json
from datetime import date

from openai import OpenAI

from app.config import OPENAI_API_KEY, OPENAI_PLANNING_MODEL, today_local
from app.food_log_store import (
    add_food_entry,
    create_meal_prep_item,
    delete_food_entry,
    delete_meal_prep_item,
    get_food_entries,
    get_food_entries_range,
    get_macro_targets,
    get_manual_workout,
    get_manual_workouts_range,
    list_meal_prep_items,
    update_food_entry,
    upsert_macro_targets,
    upsert_manual_workout,
)
from app.schemas import (
    DailyFoodLog,
    FoodLogAddRequest,
    FoodLogEntry,
    FoodLogHistoryResponse,
    FoodLogUpdateRequest,
    FoodParseRequest,
    FoodParseResponse,
    MacroTargets,
    MacroTargetsUpdateRequest,
    ManualWorkoutLog,
    ManualWorkoutLogRequest,
    MealPrepCreateRequest,
    MealPrepItem,
)
from app.user_context import get_default_user_context


def _user_id() -> str:
    return get_default_user_context().user_id


def get_daily_food_log(entry_date: str | None = None) -> DailyFoodLog:
    user_id = _user_id()
    d = entry_date or today_local().isoformat()
    entries = [FoodLogEntry(**e) for e in get_food_entries(d, user_id)]
    workout_raw = get_manual_workout(d, user_id)
    workout = ManualWorkoutLog(**workout_raw) if workout_raw else None
    targets = MacroTargets(**get_macro_targets(user_id))
    return DailyFoodLog(date=d, entries=entries, manual_workout=workout, targets=targets)


def add_food_log_entry(entry_date: str, payload: FoodLogAddRequest) -> FoodLogEntry:
    user_id = _user_id()
    raw = add_food_entry(
        date=entry_date,
        user_id=user_id,
        name=payload.name,
        calories=payload.calories,
        protein_g=payload.protein_g,
        carbs_g=payload.carbs_g,
        fat_g=payload.fat_g,
        meal=payload.meal,
    )
    return FoodLogEntry(**raw)


def remove_food_log_entry(entry_date: str, entry_id: str) -> bool:
    return delete_food_entry(entry_id, _user_id())


def update_food_log_entry(entry_date: str, entry_id: str, payload: FoodLogUpdateRequest) -> FoodLogEntry | None:
    raw = update_food_entry(entry_id, _user_id(), payload.name, payload.calories, payload.protein_g, payload.carbs_g, payload.fat_g, payload.meal)
    return FoodLogEntry(**raw) if raw else None


def parse_food_description(payload: FoodParseRequest) -> FoodParseResponse:
    client = OpenAI(api_key=OPENAI_API_KEY)
    resp = client.chat.completions.create(
        model=OPENAI_PLANNING_MODEL,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a nutrition assistant. Parse the food description and return JSON with keys: "
                    "name (string, concise food name), calories (number), protein_g (number), carbs_g (number), "
                    "fat_g (number), meal (one of: Breakfast, Lunch, Pre-workout, Dinner, Snack, Other). "
                    "Estimate macros from typical serving sizes when not specified. Return only the JSON object."
                ),
            },
            {"role": "user", "content": payload.text},
        ],
        max_tokens=300,
    )
    data = json.loads(resp.choices[0].message.content or "{}")
    return FoodParseResponse(
        name=str(data.get("name", payload.text[:60])),
        calories=float(data.get("calories", 0)),
        protein_g=float(data.get("protein_g", 0)),
        carbs_g=float(data.get("carbs_g", 0)),
        fat_g=float(data.get("fat_g", 0)),
        meal=str(data.get("meal", "Other")),
    )


def log_manual_workout(entry_date: str, payload: ManualWorkoutLogRequest) -> ManualWorkoutLog:
    raw = upsert_manual_workout(
        date=entry_date,
        user_id=_user_id(),
        type_=payload.type,
        duration_minutes=payload.duration_minutes,
        notes=payload.notes,
    )
    return ManualWorkoutLog(**raw)


def get_meal_prep_library() -> list[MealPrepItem]:
    return [MealPrepItem(**item) for item in list_meal_prep_items(_user_id())]


def add_meal_prep_item(payload: MealPrepCreateRequest) -> MealPrepItem:
    raw = create_meal_prep_item(
        user_id=_user_id(),
        name=payload.name,
        calories=payload.calories,
        protein_g=payload.protein_g,
        carbs_g=payload.carbs_g,
        fat_g=payload.fat_g,
        notes=payload.notes,
    )
    return MealPrepItem(**raw)


def remove_meal_prep_item(item_id: str) -> bool:
    return delete_meal_prep_item(item_id, _user_id())


def get_user_macro_targets() -> MacroTargets:
    return MacroTargets(**get_macro_targets(_user_id()))


def update_user_macro_targets(payload: MacroTargetsUpdateRequest) -> MacroTargets:
    raw = upsert_macro_targets(
        user_id=_user_id(),
        calories=payload.calories,
        protein_g=payload.protein_g,
        carbs_g=payload.carbs_g,
        fat_g=payload.fat_g,
    )
    return MacroTargets(**raw)


def get_food_log_history(days: int = 14) -> FoodLogHistoryResponse:
    user_id = _user_id()
    entries_by_date = get_food_entries_range(user_id, days)
    workouts_by_date = get_manual_workouts_range(user_id, days)
    targets = MacroTargets(**get_macro_targets(user_id))

    daily_logs = []
    for d in sorted(entries_by_date.keys(), reverse=True):
        entries = [FoodLogEntry(**e) for e in entries_by_date[d]]
        workout_raw = workouts_by_date.get(d)
        workout = ManualWorkoutLog(**workout_raw) if workout_raw else None
        daily_logs.append(DailyFoodLog(date=d, entries=entries, manual_workout=workout, targets=targets))

    return FoodLogHistoryResponse(days=daily_logs)

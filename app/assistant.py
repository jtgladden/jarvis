import json
import logging
import re
from datetime import datetime
from statistics import mean
from typing import Any, Callable
from urllib.parse import urlparse
from uuid import uuid4
from zoneinfo import ZoneInfo

from openai import OpenAI

from app.assistant_chat_store import ensure_chat, save_message
from app.calendar_client import list_upcoming_events
from app.classification_cache import get_cached_classification, save_classification
from app.classifier import IMPORTANT_LABEL, classify_emails_batch
from app.config import (
    DEFAULT_TIMEZONE,
    OPENAI_API_KEY,
    OPENAI_ASSISTANT_MAX_TOKENS,
    OPENAI_ASSISTANT_MODEL,
    OPENAI_ASSISTANT_ROUTER_MODEL,
    OPENAI_ASSISTANT_SYNTHESIS_MODEL,
    OPENAI_ASSISTANT_TIMEOUT_SECONDS,
    OPENAI_ASSISTANT_WEB_MODEL,
)
from app.dashboard import generate_dashboard
from app.gmail_client import get_mailbox_emails
from app.health import list_health_entries
from app.journal import get_journal
from app.movement import list_movement_entries
from app.workout import list_workout_entries
from app.schemas import (
    AssistantAskRequest,
    AssistantAskResponse,
    AssistantChatMessage,
    AssistantSource,
)
from app.task_service import list_tasks
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)

ToolFn = Callable[[dict[str, Any]], dict[str, Any]]

MAX_TOOL_STEPS = 6
WEB_RESEARCH_SOURCE_ID = "web_research"

INTENT_BUNDLES: dict[str, list[tuple[str, dict[str, Any]]]] = {
    "daily_priorities": [
        ("get_dashboard_overview", {}),
        ("get_tasks_detailed", {"include_completed": False}),
        ("get_calendar", {"days": 3, "max_results": 12}),
        ("get_important_mail_summary", {"limit": 8}),
    ],
    "mail_digest": [
        ("get_important_mail_summary", {"limit": 10}),
        ("get_important_mail_detail", {"limit": 6}),
    ],
    "health_trends": [
        ("get_health_summary", {"days": 30}),
        ("get_health_detail", {"days": 14}),
    ],
    "movement_trends": [
        ("get_movement_summary", {"days": 30}),
        ("get_movement_detail", {"days": 14}),
    ],
    "workout_trends": [
        ("get_workout_summary", {"days": 90, "limit": 20}),
        ("get_workout_detail", {"days": 90, "limit": 12}),
    ],
    "journal_reflection": [
        ("get_recent_journal", {"days": 14, "saved_only": True}),
    ],
    "cross_domain_summary": [
        ("get_dashboard_detail", {}),
        ("get_tasks_detailed", {"include_completed": True}),
        ("get_recent_journal", {"days": 14, "saved_only": True}),
        ("get_health_summary", {"days": 30}),
        ("get_movement_summary", {"days": 30}),
        ("get_workout_summary", {"days": 90, "limit": 12}),
        ("get_important_mail_summary", {"limit": 8}),
    ],
    "specific_fact_lookup": [
        ("get_dashboard_overview", {}),
    ],
}

BROAD_QUESTION_BONUS_BUNDLE: list[tuple[str, dict[str, Any]]] = [
    ("get_dashboard_detail", {}),
    ("get_tasks_detailed", {"include_completed": False}),
    ("get_calendar", {"days": 7, "max_results": 14}),
]


def _trim_text(value: str | None, limit: int) -> str:
    text = (value or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def _slugify_label(value: str | None, fallback: str = "source") -> str:
    text = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return text or fallback


def _extract_text_content(payload: Any) -> str:
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, list):
        return "\n".join(part for part in (_extract_text_content(item) for item in payload) if part)
    if isinstance(payload, dict):
        if payload.get("type") in {"output_text", "input_text", "text"} and isinstance(payload.get("text"), str):
            return payload["text"]
        if isinstance(payload.get("content"), str):
            return payload["content"]
        if isinstance(payload.get("content"), list):
            return _extract_text_content(payload["content"])
    return ""


def _extract_web_sources(payload: Any) -> list[dict[str, str]]:
    found: dict[str, dict[str, str]] = {}

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            candidate_url = None
            candidate_title = None

            if isinstance(node.get("url"), str) and node["url"].startswith(("http://", "https://")):
                candidate_url = node["url"].strip()
                candidate_title = str(node.get("title") or "").strip() or candidate_url
            elif (
                node.get("type") == "url_citation"
                and isinstance(node.get("url_citation"), dict)
                and isinstance(node["url_citation"].get("url"), str)
            ):
                candidate_url = node["url_citation"]["url"].strip()
                candidate_title = str(node["url_citation"].get("title") or "").strip() or candidate_url

            if candidate_url:
                found[candidate_url] = {
                    "url": candidate_url,
                    "title": candidate_title or candidate_url,
                }

            for value in node.values():
                visit(value)
            return

        if isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    return list(found.values())


def _domain_label(url: str) -> str:
    hostname = (urlparse(url).hostname or "").strip().lower()
    if hostname.startswith("www."):
        hostname = hostname[4:]
    return hostname or "web"


def _history_payload(history: list[AssistantChatMessage]) -> list[dict[str, str]]:
    trimmed: list[dict[str, str]] = []
    for message in history[-8:]:
        content = _trim_text(message.content, 700)
        if not content:
            continue
        trimmed.append({"role": message.role, "content": content})
    return trimmed


def _json_completion(
    system_prompt: str,
    user_payload: dict[str, Any],
    *,
    max_tokens: int | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    selected_model = model or OPENAI_ASSISTANT_MODEL
    request_kwargs: dict[str, Any] = {
        "model": selected_model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=True)},
        ],
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
    }
    token_limit = max_tokens or OPENAI_ASSISTANT_MAX_TOKENS
    if selected_model.startswith(("gpt-5", "o1", "o3", "o4")):
        request_kwargs["max_completion_tokens"] = token_limit
    else:
        request_kwargs["max_tokens"] = token_limit

    response = client.with_options(timeout=OPENAI_ASSISTANT_TIMEOUT_SECONDS).chat.completions.create(
        **request_kwargs,
    )
    return json.loads(response.choices[0].message.content or "{}")


def _important_emails(limit: int = 8):
    user_id = get_default_user_context().user_id
    emails = get_mailbox_emails(mailbox=IMPORTANT_LABEL, limit=limit)
    cached_by_id: dict[str, Any] = {}
    uncached = []

    for email in emails:
        cached = get_cached_classification(email, user_id=user_id)
        if cached is None:
            uncached.append(email)
            continue
        cached_by_id[email.id] = cached.classification

    if uncached:
        for email, classification in zip(uncached, classify_emails_batch(uncached)):
            save_classification(email, classification, user_id=user_id)
            cached_by_id[email.id] = classification

    return emails, cached_by_id


def _recent_mail_summary_context(limit: int = 8) -> list[dict[str, Any]]:
    emails, cached_by_id = _important_emails(limit)
    items: list[dict[str, Any]] = []
    for email in emails:
        classification = cached_by_id.get(email.id)
        items.append(
            {
                "id": email.id,
                "subject": email.subject,
                "sender": email.sender,
                "snippet": _trim_text(email.snippet, 180),
                "summary": _trim_text((classification.short_summary if classification else "") or email.snippet, 180),
                "why_it_matters": _trim_text(classification.why_it_matters if classification else "", 180),
                "needs_reply": bool(classification.needs_reply) if classification else False,
                "deadline_hint": classification.deadline_hint if classification else None,
                "action_items": classification.action_items[:3] if classification else [],
                "urgency": classification.urgency if classification else "low",
            }
        )
    return items


def _recent_mail_detailed_context(limit: int = 6) -> list[dict[str, Any]]:
    emails, cached_by_id = _important_emails(limit)
    items: list[dict[str, Any]] = []
    for email in emails:
        classification = cached_by_id.get(email.id)
        items.append(
            {
                "id": email.id,
                "thread_id": email.thread_id,
                "subject": email.subject,
                "sender": email.sender,
                "date": email.date,
                "labels": email.labels,
                "snippet": _trim_text(email.snippet, 220),
                "body": _trim_text(email.body, 1400),
                "links": [link.model_dump() for link in email.links[:8]],
                "classification": {
                    "summary": _trim_text(classification.short_summary if classification else "", 220),
                    "why_it_matters": _trim_text(classification.why_it_matters if classification else "", 220),
                    "needs_reply": bool(classification.needs_reply) if classification else False,
                    "deadline_hint": classification.deadline_hint if classification else None,
                    "action_items": classification.action_items[:5] if classification else [],
                    "urgency": classification.urgency if classification else "low",
                    "suggested_reply": _trim_text(classification.suggested_reply if classification else "", 200),
                },
            }
        )
    return items


def _tool_get_dashboard_overview(_: dict[str, Any]) -> dict[str, Any]:
    dashboard = generate_dashboard()
    return {
        "date_label": dashboard.date_label,
        "overview": dashboard.overview,
        "mail_summary": dashboard.mail_summary,
        "news_summary": dashboard.news_summary,
        "tasks_summary": dashboard.tasks_summary,
    }


def _tool_get_dashboard_detail(_: dict[str, Any]) -> dict[str, Any]:
    dashboard = generate_dashboard()
    return {
        "date_label": dashboard.date_label,
        "overview": dashboard.overview,
        "mail_summary": dashboard.mail_summary,
        "news_summary": dashboard.news_summary,
        "tasks_summary": dashboard.tasks_summary,
        "important_emails": [item.model_dump() for item in dashboard.important_emails[:8]],
        "calendar_items": [item.model_dump() for item in dashboard.calendar_items[:10]],
        "news_items": [item.model_dump() for item in dashboard.news_items[:8]],
        "tasks": [item.model_dump() for item in dashboard.tasks[:10]],
        "health_summary": dashboard.health_summary.model_dump() if dashboard.health_summary else None,
    }


def _tool_get_tasks_light(arguments: dict[str, Any]) -> dict[str, Any]:
    include_completed = bool(arguments.get("include_completed", False))
    tasks = list_tasks(include_completed=include_completed).tasks
    return {
        "count": len(tasks),
        "tasks": [task.model_dump() for task in tasks[:10]],
    }


def _tool_get_tasks_detailed(arguments: dict[str, Any]) -> dict[str, Any]:
    include_completed = bool(arguments.get("include_completed", True))
    tasks = list_tasks(include_completed=include_completed).tasks
    open_tasks = [task.model_dump() for task in tasks if not task.completed][:20]
    completed_tasks = [task.model_dump() for task in tasks if task.completed][:12]
    return {
        "include_completed": include_completed,
        "open_count": len([task for task in tasks if not task.completed]),
        "completed_count": len([task for task in tasks if task.completed]),
        "open_tasks": open_tasks,
        "completed_tasks": completed_tasks if include_completed else [],
    }


def _tool_get_calendar(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 7) or 7), 30))
    max_results = max(1, min(int(arguments.get("max_results", 12) or 12), 25))
    agenda = list_upcoming_events(days=days, max_results=max_results)
    return {
        "days": days,
        "time_min": agenda.time_min,
        "time_max": agenda.time_max,
        "items": [item.model_dump() for item in agenda.items],
    }


def _tool_get_health_summary(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 30) or 30), 30))
    entries = list_health_entries(days=days).entries
    if not entries:
        return {"days": days, "entry_count": 0, "summary": None}

    steps = [entry.steps for entry in entries]
    sleep_values = [entry.sleep_hours for entry in entries if entry.sleep_hours is not None]
    heart_rates = [entry.resting_heart_rate for entry in entries if entry.resting_heart_rate is not None]
    active_energy = [entry.active_energy_kcal for entry in entries if entry.active_energy_kcal is not None]

    return {
        "days": days,
        "entry_count": len(entries),
        "latest_date": entries[0].date,
        "summary": {
            "avg_steps": round(mean(steps)) if steps else None,
            "max_steps": max(steps) if steps else None,
            "min_steps": min(steps) if steps else None,
            "avg_sleep_hours": round(mean(sleep_values), 1) if sleep_values else None,
            "avg_resting_heart_rate": round(mean(heart_rates), 1) if heart_rates else None,
            "avg_active_energy_kcal": round(mean(active_energy), 1) if active_energy else None,
            "workout_days": sum(1 for entry in entries if entry.workouts > 0),
        },
    }


def _tool_get_health_detail(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 14) or 14), 30))
    response = list_health_entries(days=days)
    return {
        "days": days,
        "entries": [entry.model_dump() for entry in response.entries],
    }


def _tool_get_movement_summary(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 30) or 30), 60))
    entries = list_movement_entries(days=days).entries
    if not entries:
        return {"days": days, "entry_count": 0, "summary": None}

    distances = [entry.total_distance_km for entry in entries]
    away = [entry.time_away_minutes for entry in entries if entry.time_away_minutes is not None]
    visits = [entry.visited_places_count for entry in entries]
    return {
        "days": days,
        "entry_count": len(entries),
        "latest_date": entries[0].date,
        "summary": {
            "avg_distance_km": round(mean(distances), 2) if distances else None,
            "max_distance_km": max(distances) if distances else None,
            "avg_time_away_minutes": round(mean(away)) if away else None,
            "avg_visited_places": round(mean(visits), 1) if visits else None,
            "days_with_routes": sum(1 for entry in entries if entry.route_points),
        },
    }


def _tool_get_movement_detail(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 14) or 14), 60))
    response = list_movement_entries(days=days)
    return {
        "days": days,
        "entries": [entry.model_dump() for entry in response.entries[: min(days, 20)]],
    }


def _compact_route_points(route_points: list[Any], *, limit: int = 24) -> list[dict[str, Any]]:
    if len(route_points) <= limit:
        return [
            {
                "timestamp": point.timestamp,
                "latitude": round(point.latitude, 5),
                "longitude": round(point.longitude, 5),
            }
            for point in route_points
        ]

    last_index = len(route_points) - 1
    keep_indexes = {0, last_index}
    step = max(1, len(route_points) // max(1, limit - 2))
    keep_indexes.update(range(0, len(route_points), step))
    ordered = sorted(index for index in keep_indexes if 0 <= index <= last_index)[:limit]
    return [
        {
            "timestamp": route_points[index].timestamp,
            "latitude": round(route_points[index].latitude, 5),
            "longitude": round(route_points[index].longitude, 5),
        }
        for index in ordered
    ]


def _serialize_workout(workout: Any, *, include_route_points: bool = False) -> dict[str, Any]:
    payload = {
        "workout_id": workout.workout_id,
        "date": workout.date,
        "activity_type": workout.activity_type,
        "activity_label": workout.activity_label,
        "start_date": workout.start_date,
        "end_date": workout.end_date,
        "duration_minutes": workout.duration_minutes,
        "total_distance_km": workout.total_distance_km,
        "active_energy_kcal": workout.active_energy_kcal,
        "avg_heart_rate_bpm": workout.avg_heart_rate_bpm,
        "max_heart_rate_bpm": workout.max_heart_rate_bpm,
        "source_name": workout.source_name,
        "route_point_count": len(workout.route_points),
        "has_route": bool(workout.route_points),
    }
    if include_route_points:
        payload["route_points"] = _compact_route_points(workout.route_points)
    return payload


def _tool_get_workout_summary(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 90) or 90), 365))
    limit = max(1, min(int(arguments.get("limit", 20) or 20), 100))
    activity_query = str(arguments.get("activity_query") or "").strip().lower()
    workouts = list_workout_entries(days=days, limit=limit).workouts
    if activity_query:
        workouts = [
            workout
            for workout in workouts
            if activity_query in (workout.activity_label or "").lower()
            or activity_query in (workout.activity_type or "").lower()
        ]

    if not workouts:
        return {
            "days": days,
            "limit": limit,
            "activity_query": activity_query or None,
            "workout_count": 0,
            "summary": None,
        }

    distances = [workout.total_distance_km for workout in workouts if workout.total_distance_km is not None]
    durations = [workout.duration_minutes for workout in workouts if workout.duration_minutes is not None]
    energies = [workout.active_energy_kcal for workout in workouts if workout.active_energy_kcal is not None]
    avg_heart_rates = [workout.avg_heart_rate_bpm for workout in workouts if workout.avg_heart_rate_bpm is not None]

    return {
        "days": days,
        "limit": limit,
        "activity_query": activity_query or None,
        "workout_count": len(workouts),
        "latest_workout": _serialize_workout(workouts[0], include_route_points=False),
        "summary": {
            "avg_distance_km": round(mean(distances), 2) if distances else None,
            "max_distance_km": max(distances) if distances else None,
            "avg_duration_minutes": round(mean(durations), 1) if durations else None,
            "avg_active_energy_kcal": round(mean(energies), 1) if energies else None,
            "avg_heart_rate_bpm": round(mean(avg_heart_rates), 1) if avg_heart_rates else None,
            "mapped_workouts": sum(1 for workout in workouts if workout.route_points),
            "activity_labels": sorted({workout.activity_label for workout in workouts if workout.activity_label})[:10],
        },
    }


def _tool_get_workout_detail(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 90) or 90), 365))
    limit = max(1, min(int(arguments.get("limit", 6) or 6), 20))
    activity_query = str(arguments.get("activity_query") or "").strip().lower()
    workouts = list_workout_entries(days=days, limit=limit).workouts
    if activity_query:
        workouts = [
            workout
            for workout in workouts
            if activity_query in (workout.activity_label or "").lower()
            or activity_query in (workout.activity_type or "").lower()
        ]

    return {
        "days": days,
        "limit": limit,
        "activity_query": activity_query or None,
        "workouts": [
            _serialize_workout(workout, include_route_points=index == 0)
            for index, workout in enumerate(workouts[:limit])
        ],
    }


def _tool_get_recent_journal(arguments: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(int(arguments.get("days", 14) or 14), 30))
    saved_only = bool(arguments.get("saved_only", True))
    result = get_journal(days=days, saved_only=saved_only, query="")
    return {
        "days": days,
        "saved_only": saved_only,
        "entries": [
            {
                "date": entry.date,
                "date_label": entry.date_label,
                "calendar_summary": entry.calendar_summary,
                "journal_entry": _trim_text(entry.journal_entry, 320),
                "accomplishments": _trim_text(entry.accomplishments, 240),
                "gratitude_entry": _trim_text(entry.gratitude_entry, 220),
                "world_event_title": entry.world_event_title,
                "world_event_summary": _trim_text(entry.world_event_summary, 220),
                "updated_at": entry.updated_at,
            }
            for entry in result.entries[:12]
        ],
    }


def _tool_search_journal(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    days = max(1, min(int(arguments.get("days", 14) or 14), 30))
    saved_only = bool(arguments.get("saved_only", True))
    result = get_journal(days=days, saved_only=saved_only, query=query)
    return {
        "query": query,
        "days": days,
        "saved_only": saved_only,
        "entries": [
            {
                "date": entry.date,
                "date_label": entry.date_label,
                "calendar_summary": entry.calendar_summary,
                "journal_entry": _trim_text(entry.journal_entry, 320),
                "accomplishments": _trim_text(entry.accomplishments, 240),
                "gratitude_entry": _trim_text(entry.gratitude_entry, 220),
                "scripture_study": _trim_text(entry.scripture_study, 220),
                "spiritual_notes": _trim_text(entry.spiritual_notes, 220),
                "world_event_title": entry.world_event_title,
                "world_event_summary": _trim_text(entry.world_event_summary, 220),
                "updated_at": entry.updated_at,
            }
            for entry in result.entries[:10]
        ],
    }


def _tool_get_important_mail_summary(arguments: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(arguments.get("limit", 8) or 8), 20))
    return {"limit": limit, "important_mail": _recent_mail_summary_context(limit=limit)}


def _tool_get_important_mail_detail(arguments: dict[str, Any]) -> dict[str, Any]:
    limit = max(1, min(int(arguments.get("limit", 6) or 6), 12))
    return {"limit": limit, "important_mail": _recent_mail_detailed_context(limit=limit)}


def _tool_get_web_research(arguments: dict[str, Any]) -> dict[str, Any]:
    query = str(arguments.get("query") or "").strip()
    if not query:
        raise RuntimeError("Web research requires a query.")

    allowed_domains = [
        str(domain).strip()
        for domain in (arguments.get("allowed_domains") or [])
        if str(domain).strip()
    ][:20]
    location_hint = str(arguments.get("location_hint") or "").strip().lower()
    include_location = location_hint in {"auto", "near_me", "local", "location"}

    tool_payload: dict[str, Any] = {"type": "web_search"}
    if allowed_domains:
        tool_payload["filters"] = {"allowed_domains": allowed_domains}
    if include_location:
        tool_payload["user_location"] = {
            "type": "approximate",
            "country": "US",
            "timezone": DEFAULT_TIMEZONE,
        }

    response = client.with_options(timeout=OPENAI_ASSISTANT_TIMEOUT_SECONDS).responses.create(
        model=OPENAI_ASSISTANT_WEB_MODEL,
        reasoning={"effort": "low"},
        tools=[tool_payload],
        tool_choice="auto",
        include=["web_search_call.action.sources"],
        input=query,
    )
    raw_response = response.model_dump() if hasattr(response, "model_dump") else response
    output_text = _trim_text(getattr(response, "output_text", "") or _extract_text_content(raw_response), 2400)
    web_sources = _extract_web_sources(raw_response)[:8]

    return {
        "query": query,
        "summary": output_text,
        "source_count": len(web_sources),
        "sources": web_sources,
    }


TOOLS: dict[str, dict[str, Any]] = {
    "get_dashboard_overview": {
        "description": "Fetch the concise dashboard overview and summaries.",
        "source": AssistantSource(id="dashboard", label="Dashboard briefing", kind="dashboard", detail="High-level overview"),
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        "fn": _tool_get_dashboard_overview,
    },
    "get_dashboard_detail": {
        "description": "Fetch the detailed dashboard with spotlighted emails, calendar items, tasks, news, and health summary.",
        "source": AssistantSource(id="dashboard", label="Dashboard briefing", kind="dashboard", detail="Detailed dashboard state"),
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        "fn": _tool_get_dashboard_detail,
    },
    "get_tasks_light": {
        "description": "Fetch a lightweight list of tasks.",
        "source": AssistantSource(id="tasks", label="Task list", kind="tasks", detail="Light task snapshot"),
        "parameters": {"type": "object", "properties": {"include_completed": {"type": "boolean"}}, "additionalProperties": False},
        "fn": _tool_get_tasks_light,
    },
    "get_tasks_detailed": {
        "description": "Fetch open and completed tasks with more detail.",
        "source": AssistantSource(id="tasks", label="Task list", kind="tasks", detail="Detailed task view"),
        "parameters": {"type": "object", "properties": {"include_completed": {"type": "boolean"}}, "additionalProperties": False},
        "fn": _tool_get_tasks_detailed,
    },
    "get_calendar": {
        "description": "Fetch upcoming calendar events for the next N days.",
        "source": AssistantSource(id="calendar", label="Upcoming calendar", kind="calendar", detail="Primary calendar"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}, "max_results": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_calendar,
    },
    "get_health_summary": {
        "description": "Fetch a summarized view of recent health trends.",
        "source": AssistantSource(id="health", label="Health metrics", kind="health", detail="Trend summary"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_health_summary,
    },
    "get_health_detail": {
        "description": "Fetch detailed recent daily health entries.",
        "source": AssistantSource(id="health", label="Health metrics", kind="health", detail="Daily entries"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_health_detail,
    },
    "get_movement_summary": {
        "description": "Fetch a summarized view of recent movement trends.",
        "source": AssistantSource(id="movement", label="Movement journal", kind="movement", detail="Trend summary"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_movement_summary,
    },
    "get_movement_detail": {
        "description": "Fetch detailed movement journal entries including story, visits, and route metadata.",
        "source": AssistantSource(id="movement", label="Movement journal", kind="movement", detail="Detailed entries"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_movement_detail,
    },
    "get_workout_summary": {
        "description": "Fetch a summarized view of recent workouts like hikes, runs, rides, and gym sessions.",
        "source": AssistantSource(id="workout", label="Workout history", kind="workout", detail="Workout trend summary"),
        "parameters": {
            "type": "object",
            "properties": {
                "days": {"type": "integer"},
                "limit": {"type": "integer"},
                "activity_query": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "fn": _tool_get_workout_summary,
    },
    "get_workout_detail": {
        "description": "Fetch detailed workout history including workout type, timing, distance, energy, heart rate, and route points when available.",
        "source": AssistantSource(id="workout", label="Workout history", kind="workout", detail="Detailed workout entries"),
        "parameters": {
            "type": "object",
            "properties": {
                "days": {"type": "integer"},
                "limit": {"type": "integer"},
                "activity_query": {"type": "string"},
            },
            "additionalProperties": False,
        },
        "fn": _tool_get_workout_detail,
    },
    "get_recent_journal": {
        "description": "Fetch recent journal entries without needing a search query.",
        "source": AssistantSource(id="journal", label="Journal history", kind="journal", detail="Recent journal days"),
        "parameters": {"type": "object", "properties": {"days": {"type": "integer"}, "saved_only": {"type": "boolean"}}, "additionalProperties": False},
        "fn": _tool_get_recent_journal,
    },
    "search_journal": {
        "description": "Search journal entries and summaries by text query.",
        "source": AssistantSource(id="journal", label="Journal history", kind="journal", detail="Journal search"),
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}, "days": {"type": "integer"}, "saved_only": {"type": "boolean"}}, "additionalProperties": False},
        "fn": _tool_search_journal,
    },
    "get_important_mail_summary": {
        "description": "Fetch a lightweight summary of recent important emails.",
        "source": AssistantSource(id="mail", label="Important mail", kind="mail", detail="Mail summary"),
        "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_important_mail_summary,
    },
    "get_important_mail_detail": {
        "description": "Fetch detailed recent important emails including body excerpts, links, and richer classification context.",
        "source": AssistantSource(id="mail", label="Important mail", kind="mail", detail="Detailed mail context"),
        "parameters": {"type": "object", "properties": {"limit": {"type": "integer"}}, "additionalProperties": False},
        "fn": _tool_get_important_mail_detail,
    },
    "get_web_research": {
        "description": "Search the web for outside facts Jarvis does not already store, such as trail details, weather, place info, or current public information.",
        "source": AssistantSource(
            id=WEB_RESEARCH_SOURCE_ID,
            label="Web research",
            kind="web",
            detail="Outside sources gathered with OpenAI web search",
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "allowed_domains": {"type": "array", "items": {"type": "string"}},
                "location_hint": {"type": "string"},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "fn": _tool_get_web_research,
    },
}


def _tool_specs() -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "description": tool["description"],
            "parameters": tool["parameters"],
        }
        for name, tool in TOOLS.items()
    ]


def _run_tool(tool_name: str, arguments: dict[str, Any]) -> tuple[dict[str, Any], AssistantSource]:
    tool = TOOLS.get(tool_name)
    if tool is None:
        raise RuntimeError(f"Unknown Jarvis assistant tool: {tool_name}")
    result = tool["fn"](arguments)
    source = tool["source"]
    if tool_name == "get_web_research":
        sources = result.get("sources") or []
        if sources:
            first_source = sources[0]
            source = AssistantSource(
                id=WEB_RESEARCH_SOURCE_ID,
                label=str(first_source.get("title") or _domain_label(str(first_source.get("url") or ""))).strip()
                or "Web research",
                kind="web",
                detail=result.get("query") or source.detail,
                url=str(first_source.get("url") or "").strip() or None,
            )
    return result, source


def _call_signature(tool_name: str, arguments: dict[str, Any]) -> str:
    return f"{tool_name}:{json.dumps(arguments, ensure_ascii=True, sort_keys=True)}"


def _intent_classifier_prompt() -> str:
    intents = list(INTENT_BUNDLES.keys())
    return f"""
You classify assistant questions so retrieval can be depth-aware.
Choose the closest intent from: {", ".join(intents)}.

Return exactly one JSON object with:
{{
  "intent": "one of the allowed intents",
  "broad_question": true or false,
  "needs_deep_answer": true or false,
  "reason": "short explanation"
}}

Guidance:
- Broad self-reflective or planning questions should usually be broad_question=true.
- Questions asking for analysis, trends, depth, synthesis, or comparison should usually be needs_deep_answer=true.
- "How am I doing?", "What should I focus on?", "What have I been neglecting?" should usually not be treated as narrow lookups.
- Questions about hikes, runs, rides, workouts, exercise sessions, or specific named workouts should usually be classified as workout_trends.
- If the question depends on outside facts Jarvis would not normally store, assume web research may be needed.
- Interpret relative dates like today, tomorrow, and this evening using the provided local time and timezone, not UTC.
""".strip()


def _classify_intent(question: str, history_payload: list[dict[str, str]]) -> dict[str, Any]:
    now_local = datetime.now(LOCAL_TIMEZONE)
    parsed = _json_completion(
        _intent_classifier_prompt(),
        {
            "question": question,
            "conversation_history": history_payload,
            "local_timezone": DEFAULT_TIMEZONE,
            "local_datetime": now_local.isoformat(),
        },
        max_tokens=300,
        model=OPENAI_ASSISTANT_ROUTER_MODEL,
    )
    intent = str(parsed.get("intent") or "").strip()
    if intent not in INTENT_BUNDLES:
        intent = "specific_fact_lookup"
    return {
        "intent": intent,
        "broad_question": bool(parsed.get("broad_question", False)),
        "needs_deep_answer": bool(parsed.get("needs_deep_answer", False)),
        "reason": str(parsed.get("reason") or "").strip(),
    }


def _planner_system_prompt() -> str:
    return f"""
You are Jarvis, an intent-aware personal assistant that decides which tool to call next.
You have access to these tools:
{json.dumps(_tool_specs(), ensure_ascii=True)}

Return exactly one JSON object with:
{{
  "action": "tool" or "final",
  "tool_name": "tool name when action=tool",
  "arguments": {{}},
  "reason": "why this is the right next step"
}}

Rules:
- Prefer detailed tool variants when the question asks for depth, synthesis, or explanation.
- Prefer cross-domain retrieval for broad questions about priorities, trends, neglect, or overall performance.
- Use get_web_research when the user asks about public facts outside Jarvis data, such as trail details, place facts, current weather, or external context for a named location.
- Do not repeat tool calls whose exact signature has already been used unless there is a very strong reason.
- Choose "final" when the current evidence is enough.
- Interpret relative dates like today, tomorrow, tonight, and this evening using the provided local time and timezone.
""".strip()


def _sufficiency_prompt() -> str:
    return f"""
You are checking whether Jarvis has enough context to answer well.
Available tools:
{json.dumps(_tool_specs(), ensure_ascii=True)}

Return exactly one JSON object with:
{{
  "enough_context": true or false,
  "reason": "short explanation",
  "recommended_tools": [
    {{
      "tool_name": "tool name",
      "arguments": {{}}
    }}
  ]
}}

Rules:
- If the current answer would likely be shallow, say enough_context=false.
- Broad cross-domain questions usually need multiple source domains.
- "Summarize in depth" questions usually need at least one detailed tool, not just summaries.
- If the answer depends on public facts Jarvis does not store locally, recommend get_web_research.
- Only recommend tools from the available list.
- Recommend at most 3 tools.
- Interpret relative dates like today and tomorrow using the provided local time and timezone.
""".strip()


def _assess_sufficiency(
    *,
    question: str,
    history_payload: list[dict[str, str]],
    intent_info: dict[str, Any],
    tool_trace: list[dict[str, Any]],
) -> dict[str, Any]:
    now_local = datetime.now(LOCAL_TIMEZONE)
    parsed = _json_completion(
        _sufficiency_prompt(),
        {
            "question": question,
            "conversation_history": history_payload,
            "intent": intent_info,
            "tool_results_so_far": tool_trace,
            "local_timezone": DEFAULT_TIMEZONE,
            "local_datetime": now_local.isoformat(),
        },
        max_tokens=350,
        model=OPENAI_ASSISTANT_ROUTER_MODEL,
    )
    recommended_tools = []
    for item in parsed.get("recommended_tools") or []:
        tool_name = str((item or {}).get("tool_name") or "").strip()
        arguments = (item or {}).get("arguments") or {}
        if tool_name in TOOLS and isinstance(arguments, dict):
            recommended_tools.append({"tool_name": tool_name, "arguments": arguments})
    return {
        "enough_context": bool(parsed.get("enough_context", False)),
        "reason": str(parsed.get("reason") or "").strip(),
        "recommended_tools": recommended_tools[:3],
    }


def _final_system_prompt(used_source_ids: list[str], intent_info: dict[str, Any]) -> str:
    allowed = ", ".join(used_source_ids)
    return f"""
You are Jarvis, an on-page personal assistant.
Answer only from the provided evidence. Some evidence may come from Jarvis data and some may come from cited web research.
The question intent is: {intent_info.get("intent")}.
Broad question: {intent_info.get("broad_question")}.
Needs deep answer: {intent_info.get("needs_deep_answer")}.

Return exactly one JSON object with this shape:
{{
  "answer": "direct answer in plain English",
  "bullets": ["supporting facts, dates, counts, caveats, grouped themes, or action items"],
  "follow_ups": ["helpful next questions"],
  "cited_source_ids": ["one or more ids from: {allowed}"]
}}

Rules:
- If multiple related emails/items are involved, synthesize them into one useful narrative first instead of merely listing them.
- If the question is broad or reflective, integrate across multiple domains when the evidence supports it.
- If the question asks for depth, err on the side of a richer answer, not a one-line reply.
- If web evidence was provided, use it clearly and avoid pretending it came from the user's private data.
- Cite only these source ids: {allowed}.
- Interpret relative dates like today, tomorrow, tonight, and this evening using the provided local time and timezone.
""".strip()


def _seed_bundle(intent_info: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    bundle = list(INTENT_BUNDLES.get(intent_info["intent"], INTENT_BUNDLES["specific_fact_lookup"]))
    if intent_info.get("broad_question") and intent_info["intent"] not in {"cross_domain_summary", "daily_priorities"}:
        bundle.extend(BROAD_QUESTION_BONUS_BUNDLE)
    return bundle


def _infer_workout_query(question: str) -> str | None:
    lowered = question.lower()
    for keyword in ["hike", "run", "running", "walk", "walking", "ride", "cycling", "bike", "swim", "yoga", "workout", "exercise"]:
        if keyword in lowered:
            if keyword == "running":
                return "run"
            if keyword == "walking":
                return "walk"
            if keyword == "bike":
                return "ride"
            return keyword
    return None


def _infer_external_research_query(question: str) -> dict[str, Any] | None:
    lowered = question.lower()
    external_markers = [
        "mt.",
        "mount ",
        "mountain",
        "trail",
        "trailhead",
        "elevation",
        "weather",
        "near me",
        "restaurant",
        "route difficulty",
        "how hard",
        "can i do",
        "is it reasonable",
        "what is",
        "tell me about",
    ]
    if not any(marker in lowered for marker in external_markers):
        return None

    location_hint = None
    if any(marker in lowered for marker in ["near me", "nearby", "close to me", "around me", "local"]):
        location_hint = "near_me"

    return {
        "query": question.strip(),
        "location_hint": location_hint,
    }


def _execute_tool_call(
    *,
    tool_name: str,
    arguments: dict[str, Any],
    used_sources: dict[str, AssistantSource],
    tool_trace: list[dict[str, Any]],
    executed_signatures: set[str],
) -> bool:
    signature = _call_signature(tool_name, arguments)
    if signature in executed_signatures:
        return False
    tool_result, source = _run_tool(tool_name, arguments)
    executed_signatures.add(signature)
    if tool_name == "get_web_research":
        web_sources = tool_result.get("sources") or []
        if web_sources:
            for item in web_sources[:6]:
                url = str((item or {}).get("url") or "").strip()
                if not url:
                    continue
                source_id = f"{WEB_RESEARCH_SOURCE_ID}:{_slugify_label(url, fallback='url')}"
                used_sources[source_id] = AssistantSource(
                    id=source_id,
                    label=str((item or {}).get("title") or _domain_label(url)).strip() or _domain_label(url),
                    kind="web",
                    detail=str(arguments.get("query") or "").strip() or "Outside fact lookup",
                    url=url,
                )
        else:
            used_sources[source.id] = source
    else:
        used_sources[source.id] = source
    tool_trace.append(
        {
            "tool_name": tool_name,
            "source_id": source.id,
            "arguments": arguments,
            "result": tool_result,
        }
    )
    return True


def ask_jarvis_assistant(payload: AssistantAskRequest) -> AssistantAskResponse:
    question = payload.question.strip()
    if not question:
        raise RuntimeError("Ask Jarvis needs a question.")
    if not OPENAI_API_KEY:
        raise RuntimeError("Ask Jarvis needs an OpenAI API key configured on the server.")

    history_payload = _history_payload(payload.history)
    now_local = datetime.now(LOCAL_TIMEZONE)
    user_id = get_default_user_context().user_id
    chat_id = ensure_chat(
        payload.chat_id or uuid4().hex,
        title=_trim_text(question, 80),
        user_id=user_id,
    )

    used_sources: dict[str, AssistantSource] = {}
    tool_trace: list[dict[str, Any]] = []
    executed_signatures: set[str] = set()
    warnings: list[str] = []

    try:
        intent_info = _classify_intent(question, history_payload)
    except Exception as exc:
        logger.warning("Assistant intent classification failed: %s", exc)
        intent_info = {
            "intent": "specific_fact_lookup",
            "broad_question": False,
            "needs_deep_answer": False,
            "reason": "Fallback intent classification",
        }
        warnings.append("Intent classification fell back to specific_fact_lookup.")

    try:
        workout_query = _infer_workout_query(question)
        external_query = _infer_external_research_query(question)
        for tool_name, arguments in _seed_bundle(intent_info):
            if len(tool_trace) >= MAX_TOOL_STEPS:
                break
            _execute_tool_call(
                tool_name=tool_name,
                arguments=arguments,
                used_sources=used_sources,
                tool_trace=tool_trace,
                executed_signatures=executed_signatures,
            )

        if workout_query and len(tool_trace) < MAX_TOOL_STEPS:
            for tool_name, arguments in [
                ("get_workout_summary", {"days": 120, "limit": 20, "activity_query": workout_query}),
                ("get_workout_detail", {"days": 120, "limit": 12, "activity_query": workout_query}),
            ]:
                if len(tool_trace) >= MAX_TOOL_STEPS:
                    break
                _execute_tool_call(
                    tool_name=tool_name,
                    arguments=arguments,
                    used_sources=used_sources,
                    tool_trace=tool_trace,
                    executed_signatures=executed_signatures,
                )

        if external_query and len(tool_trace) < MAX_TOOL_STEPS:
            _execute_tool_call(
                tool_name="get_web_research",
                arguments=external_query,
                used_sources=used_sources,
                tool_trace=tool_trace,
                executed_signatures=executed_signatures,
            )

        while len(tool_trace) < MAX_TOOL_STEPS:
            sufficiency = _assess_sufficiency(
                question=question,
                history_payload=history_payload,
                intent_info=intent_info,
                tool_trace=tool_trace,
            )
            if sufficiency["reason"]:
                warnings.append(f"Sufficiency check: {sufficiency['reason']}")
            if sufficiency["enough_context"]:
                break

            executed_any = False
            for recommendation in sufficiency["recommended_tools"]:
                if len(tool_trace) >= MAX_TOOL_STEPS:
                    break
                executed_any = _execute_tool_call(
                    tool_name=recommendation["tool_name"],
                    arguments=recommendation["arguments"],
                    used_sources=used_sources,
                    tool_trace=tool_trace,
                    executed_signatures=executed_signatures,
                ) or executed_any

            if executed_any:
                continue

            plan = _json_completion(
                _planner_system_prompt(),
                {
                    "question": question,
                    "conversation_history": history_payload,
                    "intent": intent_info,
                    "tool_results_so_far": tool_trace,
                    "warnings": warnings,
                    "executed_signatures": sorted(executed_signatures),
                    "local_timezone": DEFAULT_TIMEZONE,
                    "local_datetime": now_local.isoformat(),
                },
                max_tokens=350,
                model=OPENAI_ASSISTANT_ROUTER_MODEL,
            )
            action = str(plan.get("action") or "").strip().lower()
            if action != "tool":
                break

            tool_name = str(plan.get("tool_name") or "").strip()
            raw_arguments = plan.get("arguments") or {}
            arguments = raw_arguments if isinstance(raw_arguments, dict) else {}
            if tool_name not in TOOLS:
                warnings.append(f"Planner requested invalid tool {tool_name!r}.")
                break

            executed = _execute_tool_call(
                tool_name=tool_name,
                arguments=arguments,
                used_sources=used_sources,
                tool_trace=tool_trace,
                executed_signatures=executed_signatures,
            )
            if not executed:
                warnings.append(f"Planner requested already-used tool call {tool_name}.")
                break
    except Exception as exc:
        logger.exception("Jarvis assistant retrieval loop failed")
        raise RuntimeError(f"Ask Jarvis failed while gathering context: {exc}") from exc

    if not tool_trace:
        _execute_tool_call(
            tool_name="get_dashboard_overview",
            arguments={},
            used_sources=used_sources,
            tool_trace=tool_trace,
            executed_signatures=executed_signatures,
        )

    used_source_ids = list(used_sources.keys())

    try:
        parsed = _json_completion(
            _final_system_prompt(used_source_ids, intent_info),
            {
                "question": question,
                "conversation_history": history_payload,
                "intent": intent_info,
                "tool_results": tool_trace,
                "warnings": warnings[:6],
                "local_timezone": DEFAULT_TIMEZONE,
                "local_datetime": now_local.isoformat(),
            },
            model=OPENAI_ASSISTANT_SYNTHESIS_MODEL,
        )
    except Exception as exc:
        logger.exception("Jarvis assistant final synthesis failed")
        raise RuntimeError(f"Ask Jarvis failed: {exc}") from exc

    cited_ids = [
        source_id
        for source_id in parsed.get("cited_source_ids") or []
        if isinstance(source_id, str) and source_id in used_sources
    ]
    if not cited_ids:
        cited_ids = used_source_ids[: min(4, len(used_source_ids))]

    bullets = [
        str(item).strip()
        for item in (parsed.get("bullets") or [])
        if str(item).strip()
    ][:8]
    follow_ups = [
        str(item).strip()
        for item in (parsed.get("follow_ups") or [])
        if str(item).strip()
    ][:4]

    answer = str(parsed.get("answer") or "").strip() or "I couldn't form a grounded answer from the available Jarvis tools."
    context_summary_parts = [
        f"Intent: {intent_info['intent']}",
        *[source.label for source in used_sources.values()],
    ]
    if warnings:
        context_summary_parts.append(f"Notes: {'; '.join(warnings[:3])}")

    save_message(
        chat_id=chat_id,
        role="user",
        content=question,
        user_id=user_id,
    )
    assistant_sources = [used_sources[source_id] for source_id in cited_ids]
    save_message(
        chat_id=chat_id,
        role="assistant",
        content=answer,
        bullets=bullets,
        follow_ups=follow_ups,
        sources=assistant_sources,
        user_id=user_id,
    )

    return AssistantAskResponse(
        chat_id=chat_id,
        answer=answer,
        bullets=bullets,
        follow_ups=follow_ups,
        sources=assistant_sources,
        context_summary=", ".join(context_summary_parts),
        model=OPENAI_ASSISTANT_SYNTHESIS_MODEL,
    )

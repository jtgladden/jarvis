import json
import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from openai import OpenAI

from app.calendar_client import create_calendar_event
from app.config import DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.schemas import CalendarQuickAddResponse

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)


def _coerce_json_object(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    start = content.find("{")
    end = content.rfind("}")
    candidate = content[start : end + 1] if start != -1 and end != -1 and end > start else content
    return json.loads(candidate)


def _normalize_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def create_calendar_event_from_description(description: str) -> CalendarQuickAddResponse:
    cleaned_description = " ".join((description or "").split()).strip()
    if not cleaned_description:
        raise RuntimeError("Please describe the event you want to add.")
    if not OPENAI_API_KEY:
        raise RuntimeError("Quick add needs an OpenAI API key so it can parse your event description.")

    now_local = datetime.now(LOCAL_TIMEZONE).replace(microsecond=0)
    system_prompt = """
You convert a natural-language event request into one calendar event.
Return one valid JSON object with exactly these fields:
- title: short event title
- start: RFC3339 datetime with offset, or YYYY-MM-DD for all-day
- end: RFC3339 datetime with offset, or YYYY-MM-DD for all-day
- is_all_day: boolean
- location: short location or empty string
- notes: short helpful notes or empty string
- should_create: boolean
- reason: empty string when should_create is true, otherwise a short explanation

Rules:
- Infer reasonable start/end values only when the request is specific enough.
- If the request names a date but no time and sounds like an appointment, default to a one-hour event at 9:00 AM local time.
- If the request clearly sounds all-day, use YYYY-MM-DD dates and is_all_day=true.
- If the request is too vague to place on a calendar, set should_create=false.
- Keep notes concise and do not invent unnecessary details.
""".strip()
    user_prompt = json.dumps(
        {
            "timezone": DEFAULT_TIMEZONE,
            "now_local": now_local.isoformat(),
            "request": cleaned_description,
        },
        ensure_ascii=True,
    )

    try:
        response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
            model=OPENAI_PLANNING_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.1,
            max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 700),
            response_format={"type": "json_object"},
        )
        parsed = _coerce_json_object(response.choices[0].message.content or "{}")
    except Exception as exc:
        logger.warning("Quick add parsing failed: %s", exc)
        raise RuntimeError("Jarvis could not parse that event description right now.") from exc

    should_create = bool(parsed.get("should_create"))
    title = _normalize_value(parsed.get("title"))
    start = _normalize_value(parsed.get("start"))
    end = _normalize_value(parsed.get("end"))
    is_all_day = bool(parsed.get("is_all_day"))
    location = _normalize_value(parsed.get("location"))
    notes = _normalize_value(parsed.get("notes"))
    reason = _normalize_value(parsed.get("reason"))

    if not should_create or not title or not start:
        raise RuntimeError(reason or "That event description was too vague to add directly. Try including a day or time.")

    if not end:
        if is_all_day:
            end = start
        else:
            try:
                end = (datetime.fromisoformat(start) + timedelta(hours=1)).isoformat()
            except ValueError:
                raise RuntimeError("Jarvis parsed a start time but not a usable end time. Try being a little more specific.")

    created = create_calendar_event(
        title=title,
        start=start,
        end=end,
        is_all_day=is_all_day,
        location=location,
        notes=notes,
    )
    return CalendarQuickAddResponse(
        created=True,
        event_id=created.get("id"),
        html_link=created.get("htmlLink"),
        title=title,
        start=start,
        end=end,
        is_all_day=is_all_day,
        location=location,
        notes=notes,
        source_text=cleaned_description,
    )

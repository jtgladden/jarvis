import json
import logging
import xml.etree.ElementTree as ET
from datetime import date, datetime, time, timedelta
from email.utils import parsedate_to_datetime
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo
from typing import Any

from openai import OpenAI

from app.calendar_client import list_events_between
from app.config import DEFAULT_TIMEZONE, OPENAI_API_KEY, OPENAI_PLANNING_MAX_TOKENS, OPENAI_PLANNING_MODEL, OPENAI_PLANNING_TIMEOUT_SECONDS
from app.journal_store import list_journal_entries, upsert_journal_entry
from app.schemas import CalendarAgendaItem, JournalDayEntry, JournalResponse
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)
LOCAL_TIMEZONE = ZoneInfo(DEFAULT_TIMEZONE)
NEWS_RSS_URL = "https://feeds.bbci.co.uk/news/world/rss.xml"


def _fetch_recent_news() -> list[dict[str, Any]]:
    request = Request(
        NEWS_RSS_URL,
        headers={
            "User-Agent": "JarvisJournal/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
    )

    with urlopen(request, timeout=8) as response:
        payload = response.read()

    root = ET.fromstring(payload)
    items: list[dict[str, Any]] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue

        published_raw = (item.findtext("pubDate") or "").strip()
        if not published_raw:
            continue

        try:
            published = parsedate_to_datetime(published_raw).astimezone(LOCAL_TIMEZONE)
        except Exception:
            continue

        items.append(
            {
                "title": title,
                "source": "BBC World",
                "published_at": published,
                "day_key": published.date().isoformat(),
            }
        )

    items.sort(key=lambda item: item["published_at"], reverse=True)
    return items


def _news_item_for_day(day_key: str, news_items: list[dict[str, Any]]) -> dict[str, str | None]:
    exact_match = next((item for item in news_items if item["day_key"] == day_key), None)
    if exact_match:
        return {
            "title": exact_match["title"],
            "source": exact_match["source"],
        }
    return {
        "title": None,
        "source": None,
    }


def _format_date_label(day: date) -> str:
    return day.strftime("%A, %B %d")


def _calendar_payload_for_day(item) -> dict[str, str | bool | None]:
    return {
        "event_id": item.event_id,
        "title": item.title,
        "start": item.start,
        "end": item.end,
        "is_all_day": item.is_all_day,
        "location": item.location,
        "description": item.description,
        "html_link": item.html_link,
        "removed": getattr(item, "removed", False),
    }


def _apply_calendar_overrides(
    source_items: list[CalendarAgendaItem],
    saved_payload: str | None,
) -> list[CalendarAgendaItem]:
    if not saved_payload:
        return source_items

    try:
        parsed = json.loads(saved_payload)
    except Exception:
        return source_items

    saved_items: list[CalendarAgendaItem] = []
    for payload in parsed or []:
        try:
            saved_items.append(CalendarAgendaItem.model_validate(payload))
        except Exception:
            continue

    if not saved_items:
        return source_items

    saved_by_event_id = {
        item.event_id: item
        for item in saved_items
        if item.event_id and not item.event_id.startswith("custom-")
    }
    merged: list[CalendarAgendaItem] = []
    seen_event_ids: set[str] = set()

    for item in source_items:
        if item.event_id and item.event_id in saved_by_event_id:
            merged.append(saved_by_event_id[item.event_id])
            seen_event_ids.add(item.event_id)
            continue
        merged.append(item)
        if item.event_id:
            seen_event_ids.add(item.event_id)

    for item in saved_items:
        if item.event_id and item.event_id.startswith("custom-"):
            merged.append(item)
            continue
        if item.event_id and item.event_id not in seen_event_ids:
            merged.append(item)

    return merged


def _ai_day_summaries(entries: list[dict]) -> dict[str, dict[str, str]]:
    if not entries:
        return {}

    if not OPENAI_API_KEY:
        return {
            entry["date"]: {
                "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
                "world_event_summary": _fallback_world_summary(entry["world_event_title"]),
            }
            for entry in entries
        }

    system_prompt = """
You are writing brief journal prep notes.
Return one valid JSON object with this exact shape:
{
  "items": [
    {
      "date": "YYYY-MM-DD",
      "calendar_summary": "1-2 sentence summary of what the person did according to calendar items that day",
      "world_event_summary": "1-2 sentence explanation of the world event headline for that day, or say no headline was captured"
    }
  ]
}
Be concise, specific, and grounded only in the provided titles/headlines.
Do not invent details beyond what can reasonably be inferred from the event names and headline.
""".strip()

    try:
      response = client.with_options(timeout=OPENAI_PLANNING_TIMEOUT_SECONDS).chat.completions.create(
          model=OPENAI_PLANNING_MODEL,
          messages=[
              {"role": "system", "content": system_prompt},
              {"role": "user", "content": json.dumps({"days": entries}, ensure_ascii=True)},
          ],
          temperature=0.2,
          max_tokens=min(OPENAI_PLANNING_MAX_TOKENS, 1200),
          response_format={"type": "json_object"},
      )
      parsed = json.loads(response.choices[0].message.content or "{}")
    except Exception as exc:
      logger.warning("Journal AI summary failed: %s", exc)
      return {
          entry["date"]: {
              "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
              "world_event_summary": _fallback_world_summary(entry["world_event_title"]),
          }
          for entry in entries
      }

    summaries: dict[str, dict[str, str]] = {}
    for item in parsed.get("items") or []:
      day_key = str((item or {}).get("date") or "").strip()
      if not day_key:
        continue
      summaries[day_key] = {
          "calendar_summary": str((item or {}).get("calendar_summary") or "").strip(),
          "world_event_summary": str((item or {}).get("world_event_summary") or "").strip(),
      }

    for entry in entries:
      summaries.setdefault(
          entry["date"],
          {
              "calendar_summary": _fallback_calendar_summary(entry["calendar_items"]),
              "world_event_summary": _fallback_world_summary(entry["world_event_title"]),
          },
      )

    return summaries


def _fallback_calendar_summary(calendar_items: list[dict]) -> str:
    if not calendar_items:
        return "No calendar events were captured for this day."
    if len(calendar_items) == 1:
        return f"You had {calendar_items[0]['title']} on your calendar."
    return (
        f"Your day included {calendar_items[0]['title']} and {len(calendar_items) - 1} "
        f"other scheduled item{'s' if len(calendar_items) - 1 != 1 else ''}."
    )


def _fallback_world_summary(world_event_title: str | None) -> str:
    if not world_event_title:
        return "No world headline was captured for this day."
    return f"One major headline that day was: {world_event_title}"


def get_journal(days: int = 7) -> JournalResponse:
    user_id = get_default_user_context().user_id
    clamped_days = max(1, min(days, 30))
    today_local = datetime.now(LOCAL_TIMEZONE).date()
    start_day = today_local - timedelta(days=clamped_days - 1)

    agenda = list_events_between(
        datetime.combine(start_day, time.min, tzinfo=LOCAL_TIMEZONE),
        datetime.combine(today_local + timedelta(days=1), time.min, tzinfo=LOCAL_TIMEZONE),
        max_results=500,
    )

    events_by_day: dict[str, list] = {}
    for item in agenda.items:
        day_key = (item.start or "")[:10]
        events_by_day.setdefault(day_key, []).append(item)

    try:
        news_items = _fetch_recent_news()
    except Exception as exc:
        logger.warning("Journal news fetch failed: %s", exc)
        news_items = []

    saved_entries = list_journal_entries(user_id=user_id)
    base_entries: list[dict] = []
    day = today_local
    while day >= start_day:
        day_key = day.isoformat()
        news_item = _news_item_for_day(day_key, news_items)
        calendar_items = _apply_calendar_overrides(
            events_by_day.get(day_key, []),
            saved_entries.get(day_key, {}).get("calendar_items_json"),
        )
        base_entries.append(
            {
                "date": day_key,
                "date_label": _format_date_label(day),
                "calendar_items": [_calendar_payload_for_day(item) for item in calendar_items if not item.removed],
                "calendar_items_full": calendar_items,
                "world_event_title": news_item.get("title"),
                "world_event_source": news_item.get("source"),
            }
        )
        day -= timedelta(days=1)

    ai_summaries = _ai_day_summaries(base_entries)
    entries: list[JournalDayEntry] = []
    for entry in base_entries:
        saved = saved_entries.get(entry["date"], {})
        summaries = ai_summaries.get(entry["date"], {})
        entries.append(
            JournalDayEntry(
                date=entry["date"],
                date_label=entry["date_label"],
                calendar_summary=summaries.get("calendar_summary") or _fallback_calendar_summary(entry["calendar_items"]),
                world_event_title=entry["world_event_title"],
                world_event_source=entry["world_event_source"],
                world_event_summary=summaries.get("world_event_summary") or _fallback_world_summary(entry["world_event_title"]),
                journal_entry=str(saved.get("journal_entry") or ""),
                accomplishments=str(saved.get("accomplishments") or ""),
                gratitude_entry=str(saved.get("gratitude_entry") or ""),
                photo_data_url=saved.get("photo_data_url"),
                calendar_items=entry["calendar_items_full"],
                updated_at=saved.get("updated_at"),
            )
        )

    return JournalResponse(
        generated_at=datetime.now(LOCAL_TIMEZONE).isoformat(),
        entries=entries,
    )


def save_journal_day(
    entry_date: str,
    journal_entry: str,
    accomplishments: str,
    gratitude_entry: str,
    photo_data_url: str | None,
    calendar_items: list[CalendarAgendaItem],
) -> JournalDayEntry:
    user_id = get_default_user_context().user_id
    saved = upsert_journal_entry(
        entry_date,
        journal_entry,
        accomplishments,
        gratitude_entry,
        photo_data_url,
        json.dumps([item.model_dump() for item in calendar_items], ensure_ascii=True),
        user_id=user_id,
    )
    day = date.fromisoformat(entry_date)
    return JournalDayEntry(
        date=entry_date,
        date_label=_format_date_label(day),
        journal_entry=saved["journal_entry"],
        accomplishments=saved["accomplishments"],
        gratitude_entry=saved["gratitude_entry"],
        photo_data_url=saved.get("photo_data_url"),
        calendar_items=[CalendarAgendaItem.model_validate(item) for item in json.loads(saved["calendar_items_json"] or "[]")],
        updated_at=saved["updated_at"],
    )

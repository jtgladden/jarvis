"""Layer 1 — per-entry structured signal extraction (LLM).

For each journal entry we ask the model to pull a small structured record:
mood, themes, habits/activities, people, and notable events. The result is
validated against pydantic (``EntrySignalsExtract``) and written to the derived
signals store keyed by ``(user_id, entry_date)``. The source ``journal_entries``
table is never modified.

PRIVACY: this is the ONLY layer that sends raw entry prose to an external API.
It composes the entry's author-written sections and sends them to OpenAI
(``OPENAI_JOURNAL_SIGNALS_MODEL`` via the Responses API — same client path as the
photo pipeline). Layers 2 and 3 never see raw text.

Idempotency: each row is stamped with ``EXTRACTION_VERSION`` and a ``source_hash``
of the exact text sent. The batch driver re-extracts an entry only when it is
unextracted, its version is stale, or its source text changed — so re-running is
cheap and safe.
"""

import hashlib
import json
import logging
import re
import time

from openai import (
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    OpenAI,
    RateLimitError,
)

from app.config import (
    APP_DEFAULT_USER_ID,
    JOURNAL_IMPORT_MAX_RETRIES,
    JOURNAL_IMPORT_RETRY_BASE_SECONDS,
    OPENAI_API_KEY,
    OPENAI_JOURNAL_SIGNALS_MODEL,
    OPENAI_JOURNAL_SIGNALS_TIMEOUT_SECONDS,
)
from app.journal_signals_store import (
    get_extraction_states,
    init_journal_signals_store,
    upsert_entry_signals,
)
from app.journal_store import list_journal_entries
from app.schemas import (
    EntrySignalsExtract,
    EventMention,
    HabitMention,
    PersonMention,
    SignalExtractionResponse,
    ThemeTag,
)
from app.user_context import get_default_user_context

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)

# Bump when the extraction prompt/schema changes in a way that should force a
# re-extraction of every entry on the next run.
EXTRACTION_VERSION = 1

_RETRYABLE_ERRORS = (RateLimitError, APITimeoutError, APIConnectionError, InternalServerError)

# Author-written prose fields, in the order we present them to the model. We
# include the retired columns because historical entries hold real reflective
# content there; for go-forward entries those are empty and contribute nothing.
# (Auto-populated calendar/news fields are intentionally excluded.)
_SOURCE_FIELDS: list[tuple[str, str]] = [
    ("journal_entry", "Journal entry"),
    ("scripture_study", "Study"),
    ("accomplishments", "Accomplishments"),
    ("gratitude_entry", "Gratitude"),
    ("spiritual_notes", "Spiritual notes"),
]

# Seed vocabulary — canonical habit slugs the model should prefer when a mention
# fits one. It may coin a new lowercase_snake slug for anything genuinely new.
_HABIT_SEED_VOCAB: list[str] = [
    "run", "walk", "hike", "climb", "bike", "swim", "workout", "lift", "yoga",
    "stretch", "meditate", "pray", "scripture_study", "church", "read", "write",
    "journal", "cook", "clean", "garden", "study", "practice_language",
    "play_music", "socialize", "call_family", "date_night", "rest", "nap",
    "early_rise", "sleep_well", "limit_screen_time", "budget", "plan",
    "volunteer", "serve",
]

# Common surface variants -> canonical seed slug, applied after slugifying.
_HABIT_SYNONYMS: dict[str, str] = {
    "running": "run", "jog": "run", "jogging": "run", "ran": "run",
    "walking": "walk", "walked": "walk", "hiking": "hike", "hiked": "hike",
    "climbing": "climb", "bouldering": "climb", "biking": "bike",
    "cycling": "bike", "swimming": "swim", "lifting": "lift",
    "weightlifting": "lift", "weights": "lift", "exercise": "workout",
    "exercised": "workout", "working_out": "workout", "gym": "workout",
    "meditation": "meditate", "meditated": "meditate", "prayer": "pray",
    "prayed": "pray", "praying": "pray", "reading": "read", "reads": "read",
    "writing": "write", "wrote": "write", "journaling": "journal",
    "journalling": "journal", "cooking": "cook", "cooked": "cook",
    "cleaning": "clean", "gardening": "garden", "studying": "study",
    "studied": "study", "scripture": "scripture_study",
    "scriptures": "scripture_study", "napped": "nap", "napping": "nap",
    "resting": "rest", "rested": "rest", "served": "serve",
    "serving": "serve", "volunteered": "volunteer", "volunteering": "volunteer",
}


def _create_response_with_retry(**kwargs):
    """Call the Responses API with exponential backoff on transient errors."""
    attempts = max(1, JOURNAL_IMPORT_MAX_RETRIES)
    last_exc: Exception | None = None
    for attempt in range(attempts):
        try:
            return client.with_options(
                timeout=OPENAI_JOURNAL_SIGNALS_TIMEOUT_SECONDS
            ).responses.create(**kwargs)
        except _RETRYABLE_ERRORS as exc:
            last_exc = exc
            if attempt == attempts - 1:
                break
            delay = JOURNAL_IMPORT_RETRY_BASE_SECONDS * (2 ** attempt)
            logger.warning(
                "[signals] transient API error (attempt %d/%d): %s — retrying in %.0fs",
                attempt + 1, attempts, exc, delay,
            )
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc


def build_source_text(entry: dict[str, object]) -> str:
    """Compose an entry's author-written sections into one labeled document.

    Empty sections are skipped, so the hash/text only reflect real content.
    """
    parts: list[str] = []
    for field, label in _SOURCE_FIELDS:
        value = str(entry.get(field) or "").strip()
        if value:
            parts.append(f"## {label}\n{value}")
    return "\n\n".join(parts)


def source_hash(text: str) -> str:
    """Stable hash of the exact text sent to the model (drives staleness)."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")
    return slug


def normalize_habit_slug(raw: str) -> str:
    """Canonicalize a habit slug: slugify, then fold known variants to the seed."""
    slug = _slugify(raw)
    return _HABIT_SYNONYMS.get(slug, slug)


_MOOD_LABELS = ["very_low", "low", "neutral", "high", "very_high"]


def _coerce_mood(score_raw: object, label_raw: object) -> tuple[int, str]:
    try:
        score = int(round(float(score_raw)))
    except (TypeError, ValueError):
        score = 0
    score = max(-2, min(2, score))
    label = str(label_raw or "").strip().lower()
    if label not in _MOOD_LABELS:
        # Derive the label from the clamped score so the two never disagree.
        label = _MOOD_LABELS[score + 2]
    return score, label


_INSTRUCTIONS = (
    "You extract structured life-signal data from ONE personal journal entry.\n"
    "Return ONLY valid JSON with this exact shape:\n"
    "{\n"
    '  "mood_score": <integer -2..2>,\n'
    '  "mood_label": "very_low | low | neutral | high | very_high",\n'
    '  "habits": [{"slug": "run", "label": "went for a run", "evidence": "short quote"}],\n'
    '  "themes": [{"slug": "work_stress", "label": "work stress"}],\n'
    '  "people": [{"name": "Sam"}],\n'
    '  "events": [{"text": "shipped the journal archive changes"}]\n'
    "}\n\n"
    "RULES:\n"
    "- Extract ONLY what is actually present. Do not infer, guess, or invent. If a "
    "category has nothing, return an empty list.\n"
    "- mood_score reflects the overall emotional tone of the entry: -2 very low, "
    "-1 low, 0 neutral/mixed, 1 good, 2 very good. Set mood_label to match.\n"
    "- HABITS are concrete activities/practices the writer did or maintained "
    "(e.g. run, climb, pray, read, cook, meditate). For each, set `slug` to a "
    "normalized lowercase_snake_case base verb. PREFER a slug from this list when "
    "it fits: " + ", ".join(_HABIT_SEED_VOCAB) + ". Coin a new lowercase_snake_case "
    "slug only for something genuinely not covered. `label` is the surface form as "
    "written; `evidence` is a SHORT quote from the entry (a few words).\n"
    "- Do not list a habit that was only wished for or planned but not done.\n"
    "- THEMES are topics/preoccupations of the entry (e.g. work_stress, family, "
    "health, faith, relationships). Use lowercase_snake_case slugs.\n"
    "- PEOPLE are named individuals mentioned. Use the name as written.\n"
    "- EVENTS are notable specific happenings that day.\n"
    "- Keep every list concise; do not pad."
)


def extract_entry_signals(
    text: str, *, model: str | None = None
) -> EntrySignalsExtract:
    """Run the LLM on one entry's composed text and validate the result.

    Raises on a hard API failure (after retries). A malformed/empty JSON body is
    tolerated and yields an empty-but-valid record.
    """
    used_model = model or OPENAI_JOURNAL_SIGNALS_MODEL
    response = _create_response_with_retry(
        model=used_model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _INSTRUCTIONS},
                    {"type": "input_text", "text": f"JOURNAL ENTRY:\n{text}"},
                ],
            }
        ],
        text={"format": {"type": "json_object"}},
        reasoning={"effort": "low"},
    )
    raw = (response.output_text or "{}").strip()
    try:
        data = json.loads(raw)
    except Exception as exc:
        logger.warning("[signals] JSON parse failed: %s", exc)
        data = {}
    if not isinstance(data, dict):
        data = {}
    return _coerce_extract(data)


def _coerce_extract(data: dict) -> EntrySignalsExtract:
    """Turn a raw JSON dict into a validated EntrySignalsExtract, defensively."""
    mood_score, mood_label = _coerce_mood(data.get("mood_score"), data.get("mood_label"))

    habits: list[HabitMention] = []
    seen_habits: set[str] = set()
    for item in data.get("habits") or []:
        if not isinstance(item, dict):
            continue
        slug = normalize_habit_slug(item.get("slug") or item.get("label") or "")
        if not slug or slug in seen_habits:
            continue
        seen_habits.add(slug)
        habits.append(
            HabitMention(
                slug=slug,
                label=str(item.get("label") or "").strip()[:200],
                evidence=str(item.get("evidence") or "").strip()[:200],
            )
        )

    themes: list[ThemeTag] = []
    seen_themes: set[str] = set()
    for item in data.get("themes") or []:
        if not isinstance(item, dict):
            continue
        slug = _slugify(item.get("slug") or item.get("label") or "")
        if not slug or slug in seen_themes:
            continue
        seen_themes.add(slug)
        themes.append(ThemeTag(slug=slug, label=str(item.get("label") or "").strip()[:120]))

    people: list[PersonMention] = []
    seen_people: set[str] = set()
    for item in data.get("people") or []:
        name = ""
        if isinstance(item, dict):
            name = str(item.get("name") or "").strip()
        elif isinstance(item, str):
            name = item.strip()
        key = name.lower()
        if not name or key in seen_people:
            continue
        seen_people.add(key)
        people.append(PersonMention(name=name[:120]))

    events: list[EventMention] = []
    for item in data.get("events") or []:
        text = ""
        if isinstance(item, dict):
            text = str(item.get("text") or "").strip()
        elif isinstance(item, str):
            text = item.strip()
        if text:
            events.append(EventMention(text=text[:300]))

    return EntrySignalsExtract(
        mood_score=mood_score,
        mood_label=mood_label,
        habits=habits,
        themes=themes,
        people=people,
        events=events,
    )


def _has_content(entry: dict[str, object]) -> bool:
    return any(str(entry.get(field) or "").strip() for field, _ in _SOURCE_FIELDS)


def run_extraction(
    *,
    force: bool = False,
    limit: int | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    dry_run: bool = False,
    model: str | None = None,
    user_id: str | None = None,
) -> SignalExtractionResponse:
    """Idempotent batch driver over the journal.

    Processes entries with author-written content in ``[start_date, end_date]``
    that are unextracted or stale (version bump / edited text), unless ``force``.
    ``limit`` caps how many entries are actually (re)extracted this run — the main
    lever for controlling API spend on a first backfill. ``dry_run`` reports what
    would be processed without calling the API or writing anything.
    """
    resolved_user = user_id or get_default_user_context().user_id
    used_model = model or OPENAI_JOURNAL_SIGNALS_MODEL
    init_journal_signals_store()

    all_entries = list_journal_entries(user_id=resolved_user)
    candidate_dates = sorted(
        entry_date
        for entry_date, entry in all_entries.items()
        if _has_content(entry)
        and (start_date is None or entry_date >= start_date)
        and (end_date is None or entry_date <= end_date)
    )

    states = get_extraction_states(user_id=resolved_user)
    processed = skipped = failed = 0

    for entry_date in candidate_dates:
        entry = all_entries[entry_date]
        text = build_source_text(entry)
        digest = source_hash(text)
        state = states.get(entry_date)
        up_to_date = (
            state is not None
            and int(state.get("extraction_version") or 0) >= EXTRACTION_VERSION
            and state.get("source_hash") == digest
        )
        if up_to_date and not force:
            skipped += 1
            continue

        if limit is not None and processed >= limit:
            # Reached the cap for this run; remaining stale entries wait for next.
            break

        if dry_run:
            processed += 1
            continue

        try:
            extract = extract_entry_signals(text, model=used_model)
            upsert_entry_signals(
                entry_date=entry_date,
                extraction_version=EXTRACTION_VERSION,
                model=used_model,
                source_hash=digest,
                mood_score=extract.mood_score,
                mood_label=extract.mood_label,
                signals_json=extract.model_dump_json(),
                habits=[(h.slug, h.label, h.evidence) for h in extract.habits],
                themes=[(t.slug, t.label) for t in extract.themes],
                user_id=resolved_user,
            )
            processed += 1
        except Exception as exc:  # per-entry isolation: one failure doesn't stop the run
            logger.warning("[signals] extraction failed for %s: %s", entry_date, exc)
            failed += 1

    return SignalExtractionResponse(
        total_candidates=len(candidate_dates),
        processed=processed,
        skipped_up_to_date=skipped,
        failed=failed,
        extraction_version=EXTRACTION_VERSION,
        model=used_model,
        dry_run=dry_run,
    )

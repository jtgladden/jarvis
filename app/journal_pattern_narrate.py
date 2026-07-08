"""Layer 3 — narration of Layer 2 findings (LLM, optional, last).

Turns the deterministic findings from ``app/journal_patterns.py`` into a short,
honest natural-language summary plus a few concrete recommendations.

Hard boundary: this layer is fed ONLY the computed statistics (slugs, labels,
directions, rates, sample sizes, strengths). It never receives raw journal
prose. Its job is to phrase what Layer 2 already found — it must not invent
habits, numbers, or causes that are not in the input. If the model is
unavailable it degrades to a deterministic summary rather than failing the
whole patterns request.
"""

import hashlib
import json
import logging

from openai import OpenAI

from app.config import (
    APP_DEFAULT_USER_ID,
    OPENAI_API_KEY,
    OPENAI_JOURNAL_NARRATE_MODEL,
    OPENAI_JOURNAL_NARRATE_TIMEOUT_SECONDS,
)
from app.journal_signals_store import get_cached_narration, set_cached_narration
from app.schemas import (
    JournalPatternNarration,
    JournalPatternRecommendation,
    JournalPatternsResponse,
)

logger = logging.getLogger(__name__)
client = OpenAI(api_key=OPENAI_API_KEY)

_SYSTEM = (
    "You are a careful, warm journaling coach. You are given ONLY pre-computed "
    "statistics about a person's habits and themes, derived from their journal. "
    "You are NEVER given the journal text itself.\n\n"
    "Write a brief summary and a few concrete, kind recommendations.\n\n"
    "Return ONLY valid JSON with this exact shape:\n"
    "{\n"
    '  "summary": "2-4 sentence plain-language overview of the findings",\n'
    '  "recommendations": [{"habit_slug": "run", "text": "one concrete suggestion"}]\n'
    "}\n\n"
    "RULES:\n"
    "- Reference ONLY patterns present in the provided data. Do NOT invent habits, "
    "themes, numbers, dates, or reasons.\n"
    "- Respect each finding's `strength`: hedge 'weak' findings ('a possible dip', "
    "'early sign'); state 'strong' findings plainly.\n"
    "- Do NOT claim one thing caused another. No correlation or causation claims.\n"
    "- Tie every recommendation to a `habit_slug` that appears in the data.\n"
    "- If there is little or nothing to report, say so briefly and return few or no "
    "recommendations. Keep it concise and encouraging."
)


def _humanize(slug: str) -> str:
    """Readable name from a normalized slug (write -> Write, call_family -> Call family).

    We deliberately do NOT use the free-text ``label`` here: it is one occurrence's
    surface phrasing (e.g. "started writing 'Leafs of Faith'") and misrepresents an
    aggregated habit. The slug is the stable identity.
    """
    s = slug.replace("_", " ").strip()
    return (s[:1].upper() + s[1:]) if s else slug


def _trend_payload(trend) -> dict:
    return {
        "slug": trend.slug,
        "name": _humanize(trend.slug),
        "direction": trend.direction,
        "strength": trend.strength,
        "prior_rate": round(trend.prior.rate, 3),
        "recent_rate": round(trend.recent.rate, 3),
        "prior_count": trend.prior.count,
        "recent_count": trend.recent.count,
        "sample_size": trend.sample_size,
    }


def _findings_payload(report: JournalPatternsResponse) -> dict:
    """Compact, text-free view of the findings for the model."""
    return {
        "as_of": report.as_of,
        "window_days": report.window_days,
        "coverage": {
            "recent_journaled_days": report.recent_window.active_days,
            "prior_journaled_days": report.prior_window.active_days,
        },
        "habits_dropping": [_trend_payload(t) for t in report.habits_dropping],
        "habits_emerging": [_trend_payload(t) for t in report.habits_emerging],
        "themes_rising": [_trend_payload(t) for t in report.themes_rising],
        "themes_falling": [_trend_payload(t) for t in report.themes_falling],
        "rhythms": [
            {
                "slug": r.slug,
                "name": _humanize(r.slug),
                "status": r.status,  # active | slowing | lapsed | new
                "typical_gap_days": r.typical_gap_days,
                "days_since_last": r.days_since_last,
                "total_occurrences": r.total_occurrences,
            }
            for r in report.habit_rhythms
        ],
        "caveats": report.caveats,
    }


def _has_findings(report: JournalPatternsResponse) -> bool:
    return bool(
        report.habits_dropping
        or report.habits_emerging
        or report.themes_rising
        or report.themes_falling
        or report.habit_rhythms
    )


def _fallback(report: JournalPatternsResponse, model: str) -> JournalPatternNarration:
    """Deterministic summary used when the LLM is unavailable."""
    bits: list[str] = []
    if report.habits_dropping:
        bits.append(
            "habits easing off: " + ", ".join(_humanize(t.slug) for t in report.habits_dropping[:3])
        )
    if report.habits_emerging:
        bits.append(
            "new habits taking hold: " + ", ".join(_humanize(t.slug) for t in report.habits_emerging[:3])
        )
    if report.themes_rising:
        bits.append("themes on the rise: " + ", ".join(_humanize(t.slug) for t in report.themes_rising[:3]))
    summary = (
        ("Here's what stood out — " + "; ".join(bits) + ". Read these as directional, not definitive.")
        if bits
        else "Not enough signal yet to surface clear patterns. Keep journaling and check back."
    )
    return JournalPatternNarration(summary=summary, recommendations=[], model=f"{model} (fallback)")


def narrate_patterns(
    report: JournalPatternsResponse, *, model: str | None = None
) -> JournalPatternNarration:
    """Phrase the Layer 2 findings. Falls back to a deterministic summary on error."""
    used_model = model or OPENAI_JOURNAL_NARRATE_MODEL
    if not _has_findings(report):
        return _fallback(report, used_model)
    if not OPENAI_API_KEY:
        return _fallback(report, used_model)

    payload = _findings_payload(report)
    try:
        response = client.with_options(
            timeout=OPENAI_JOURNAL_NARRATE_TIMEOUT_SECONDS
        ).responses.create(
            model=used_model,
            input=[
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": _SYSTEM},
                        {"type": "input_text", "text": "FINDINGS:\n" + json.dumps(payload, ensure_ascii=True)},
                    ],
                }
            ],
            text={"format": {"type": "json_object"}},
            reasoning={"effort": "low"},
        )
        data = json.loads((response.output_text or "{}").strip())
    except Exception as exc:
        logger.warning("[patterns] narration failed: %s", exc)
        return _fallback(report, used_model)

    if not isinstance(data, dict):
        return _fallback(report, used_model)

    # Guard against invented habit_slugs: keep only recommendations whose slug is
    # one Layer 2 actually surfaced (or blank, meaning general advice).
    known_slugs = {t.slug for t in report.habits_dropping}
    known_slugs |= {t.slug for t in report.habits_emerging}
    known_slugs |= {r.slug for r in report.habit_rhythms}
    known_slugs |= {t.slug for t in report.themes_rising}
    known_slugs |= {t.slug for t in report.themes_falling}

    recommendations: list[JournalPatternRecommendation] = []
    for item in data.get("recommendations") or []:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        slug = str(item.get("habit_slug") or "").strip()
        if slug and slug not in known_slugs:
            slug = ""  # drop the (hallucinated) attribution but keep the advice
        recommendations.append(JournalPatternRecommendation(habit_slug=slug, text=text))

    return JournalPatternNarration(
        summary=str(data.get("summary") or "").strip(),
        recommendations=recommendations,
        model=used_model,
    )


def findings_fingerprint(report: JournalPatternsResponse) -> str:
    """Stable hash of the deterministic findings that drive narration.

    Excludes the always-changing ``generated_at`` and the ``narration`` itself, so
    two reports with identical findings hash the same and reuse the cached prose.
    """
    data = report.model_dump()
    data.pop("generated_at", None)
    data.pop("narration", None)
    data.pop("narration_cached", None)
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


def narrate_patterns_cached(
    report: JournalPatternsResponse,
    *,
    window_days: int,
    user_id: str = APP_DEFAULT_USER_ID,
    refresh: bool = False,
) -> tuple[JournalPatternNarration, bool]:
    """Narration with caching. Returns ``(narration, was_cached)``.

    Regenerates via the model only when the findings changed since the cached
    prose was produced, or when ``refresh`` forces it — otherwise the same summary
    is reused with no API call.
    """
    fingerprint = findings_fingerprint(report)
    if not refresh:
        cached = get_cached_narration(window_days, user_id=user_id)
        if cached and cached["findings_hash"] == fingerprint:
            try:
                return JournalPatternNarration.model_validate_json(cached["narration_json"]), True
            except Exception as exc:  # corrupt cache row — fall through to regenerate
                logger.warning("[patterns] bad cached narration, regenerating: %s", exc)

    narration = narrate_patterns(report)
    # Don't cache a fallback: a transient model failure shouldn't get pinned as the
    # answer — the next load should retry. (Fallbacks are marked "... (fallback)".)
    if not narration.model.endswith("(fallback)"):
        try:
            set_cached_narration(window_days, fingerprint, narration.model_dump_json(), user_id=user_id)
        except Exception as exc:
            logger.warning("[patterns] failed to cache narration: %s", exc)
    return narration, False

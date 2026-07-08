"""Layer 2 — deterministic pattern analytics (pure Python, NO LLM).

Consumes the flattened signals from Layer 1 (habit/theme mention-days plus the
set of journaled dates) and computes, over rolling windows:

* habits DROPPING OFF (frequent before, declining now) and EMERGING habits,
* theme trends (rising / falling),
* per-habit streaks and gaps.

Design commitments:

* **Pure core.** ``analyze()`` takes plain data and returns a
  ``JournalPatternsResponse``. It touches no database and no network, so the
  drop-off/emerging logic is unit-tested on synthetic fixtures. ``compute_patterns()``
  is the thin wrapper that loads from the signals store and calls ``analyze()``.
* **Provenance.** Every finding lists the exact entry dates it is based on.
* **Statistical honesty.** A habit's absence only counts on days you actually
  journaled (the window denominator is journaled days, not calendar days), and
  every finding carries a ``strength`` that is ``weak`` for small samples or thin
  coverage. Report-level ``caveats`` call out low coverage. No correlation claims.
"""

from datetime import date, datetime, timedelta

from app.config import JOURNAL_PATTERN_WINDOW_DAYS, LOCAL_TIMEZONE
from app.journal_signals_store import (
    list_extracted_dates,
    list_habit_events,
    list_theme_events,
)
from app.schemas import (
    HabitStreak,
    HabitTrend,
    JournalPatternsResponse,
    ThemeTrend,
    WindowStat,
)
from app.user_context import get_default_user_context

# --- Tunable thresholds (defaults; overridable per call for testing) ---------
# A habit must have appeared on at least this many days in a window to be a
# credible base for a "dropping" claim (and to qualify as "emerging" now).
MIN_SUPPORT = 3
# "Dropping" = recent rate fell to <= this fraction of the prior rate.
DROP_RATIO = 0.5
# "Emerging" = the habit appeared on at most this many days in the prior window.
EMERGE_PRIOR_MAX = 1
# Theme trend thresholds.
THEME_MIN_SUPPORT = 3
THEME_RISE_RATIO = 1.5
THEME_FALL_RATIO = 0.5
# A window with fewer journaled days than this is thin coverage -> weak findings.
MIN_ACTIVE_DAYS = 5
# Sample size (mention-days across both windows) banding for strength.
WEAK_SAMPLE_MAX = 4  # sample < this -> weak
STRONG_SAMPLE_MIN = 8  # sample >= this (with adequate coverage) -> strong
# Cap on how many streak rows we surface.
MAX_STREAKS = 12


def _parse_dates(values) -> list[date]:
    out: list[date] = []
    for v in values:
        try:
            out.append(date.fromisoformat(str(v)[:10]))
        except ValueError:
            continue
    return out


def _window_bounds(as_of: date, window_days: int) -> tuple[date, date, date, date]:
    """Two adjacent, non-overlapping windows of ``window_days`` each.

    recent = [as_of - (W-1), as_of]; prior = the W days immediately before it.
    """
    recent_end = as_of
    recent_start = as_of - timedelta(days=window_days - 1)
    prior_end = recent_start - timedelta(days=1)
    prior_start = prior_end - timedelta(days=window_days - 1)
    return prior_start, prior_end, recent_start, recent_end


def _in_window(d: date, start: date, end: date) -> bool:
    return start <= d <= end


def _window_stat(
    mention_dates: set[date],
    active_dates: list[date],
    start: date,
    end: date,
) -> WindowStat:
    active = [d for d in active_dates if _in_window(d, start, end)]
    count = sum(1 for d in mention_dates if _in_window(d, start, end))
    active_n = len(active)
    return WindowStat(
        start=start.isoformat(),
        end=end.isoformat(),
        active_days=active_n,
        count=count,
        rate=(count / active_n) if active_n else 0.0,
    )


def _strength(prior: WindowStat, recent: WindowStat) -> str:
    if prior.active_days < MIN_ACTIVE_DAYS or recent.active_days < MIN_ACTIVE_DAYS:
        return "weak"
    sample = prior.count + recent.count
    if sample < WEAK_SAMPLE_MAX:
        return "weak"
    if sample >= STRONG_SAMPLE_MIN:
        return "strong"
    return "moderate"


def _provenance(mention_dates: set[date], start: date, end: date) -> list[str]:
    return sorted(d.isoformat() for d in mention_dates if _in_window(d, start, end))


def _dedupe_events(events: list[dict], slug_key: str, label_key: str):
    """Return (slug -> set(date), slug -> representative label).

    Collapses a slug to at most one mention per day (a habit named twice in one
    entry still counts once for that day).
    """
    dates_by_slug: dict[str, set[date]] = {}
    label_by_slug: dict[str, str] = {}
    for ev in events:
        slug = str(ev.get(slug_key) or "").strip()
        if not slug:
            continue
        try:
            d = date.fromisoformat(str(ev.get("entry_date"))[:10])
        except ValueError:
            continue
        dates_by_slug.setdefault(slug, set()).add(d)
        label = str(ev.get(label_key) or "").strip()
        if label and not label_by_slug.get(slug):
            label_by_slug[slug] = label
    return dates_by_slug, label_by_slug


def _streak_for(slug_dates: set[date], ordered_active: list[date], as_of: date) -> HabitStreak:
    """Streaks measured over consecutive JOURNALED days (robust to journaling gaps).

    current_streak counts back from the most recent journaled day while it keeps
    mentioning the habit; longest_streak is the longest such run anywhere in the
    ordered journaled history. days_since_last is calendar days to as_of.
    """
    present = [d in slug_dates for d in ordered_active]

    longest = run = 0
    for hit in present:
        run = run + 1 if hit else 0
        longest = max(longest, run)

    current = 0
    streak_dates: list[date] = []
    for d, hit in zip(reversed(ordered_active), reversed(present)):
        if not hit:
            break
        current += 1
        streak_dates.append(d)

    occurrence_dates = sorted(slug_dates)
    last_date = occurrence_dates[-1] if occurrence_dates else None
    days_since = (as_of - last_date).days if last_date else None
    return HabitStreak(
        slug="",  # filled by caller
        current_streak=current,
        longest_streak=longest,
        days_since_last=days_since,
        last_date=last_date.isoformat() if last_date else None,
        total_occurrences=len(slug_dates),
        provenance_dates=sorted(d.isoformat() for d in streak_dates),
    )


def analyze(
    habit_events: list[dict],
    theme_events: list[dict],
    extracted_dates: list[str],
    *,
    as_of: date | None = None,
    window_days: int = JOURNAL_PATTERN_WINDOW_DAYS,
    now_iso: str | None = None,
) -> JournalPatternsResponse:
    """Pure analytics core. Inputs are plain lists; output is fully computed.

    ``habit_events``/``theme_events`` are rows like those from the signals store
    (``{"entry_date","habit_slug","habit_label"}`` etc.). ``extracted_dates`` is
    the list of journaled days (the denominator).
    """
    active_dates = sorted(set(_parse_dates(extracted_dates)))
    if as_of is None:
        as_of = active_dates[-1] if active_dates else datetime.now(LOCAL_TIMEZONE).date()

    prior_start, prior_end, recent_start, recent_end = _window_bounds(as_of, window_days)

    recent_window = _window_stat(set(), active_dates, recent_start, recent_end)
    prior_window = _window_stat(set(), active_dates, prior_start, prior_end)

    habit_dates, habit_labels = _dedupe_events(habit_events, "habit_slug", "habit_label")
    theme_dates, theme_labels = _dedupe_events(theme_events, "theme_slug", "theme_label")

    habits_dropping: list[HabitTrend] = []
    habits_emerging: list[HabitTrend] = []

    for slug, dates in habit_dates.items():
        prior = _window_stat(dates, active_dates, prior_start, prior_end)
        recent = _window_stat(dates, active_dates, recent_start, recent_end)
        provenance = _provenance(dates, prior_start, recent_end)
        sample = prior.count + recent.count

        is_dropping = prior.count >= MIN_SUPPORT and recent.rate < prior.rate * DROP_RATIO
        is_emerging = prior.count <= EMERGE_PRIOR_MAX and recent.count >= MIN_SUPPORT

        if is_dropping:
            habits_dropping.append(
                HabitTrend(
                    slug=slug, label=habit_labels.get(slug, ""), direction="dropping",
                    prior=prior, recent=recent, delta_rate=recent.rate - prior.rate,
                    strength=_strength(prior, recent), sample_size=sample,
                    provenance_dates=provenance,
                )
            )
        elif is_emerging:
            habits_emerging.append(
                HabitTrend(
                    slug=slug, label=habit_labels.get(slug, ""), direction="emerging",
                    prior=prior, recent=recent, delta_rate=recent.rate - prior.rate,
                    strength=_strength(prior, recent), sample_size=sample,
                    provenance_dates=provenance,
                )
            )

    # Order most-actionable first: biggest rate change, then larger sample.
    habits_dropping.sort(key=lambda t: (t.delta_rate, -t.sample_size))
    habits_emerging.sort(key=lambda t: (-t.delta_rate, -t.sample_size))

    themes_rising: list[ThemeTrend] = []
    themes_falling: list[ThemeTrend] = []
    for slug, dates in theme_dates.items():
        prior = _window_stat(dates, active_dates, prior_start, prior_end)
        recent = _window_stat(dates, active_dates, recent_start, recent_end)
        provenance = _provenance(dates, prior_start, recent_end)
        sample = prior.count + recent.count
        rising = (
            recent.count >= THEME_MIN_SUPPORT
            and recent.rate > prior.rate
            and (prior.rate == 0 or recent.rate >= prior.rate * THEME_RISE_RATIO)
        )
        falling = prior.count >= THEME_MIN_SUPPORT and recent.rate <= prior.rate * THEME_FALL_RATIO
        if rising:
            themes_rising.append(
                ThemeTrend(
                    slug=slug, label=theme_labels.get(slug, ""), direction="rising",
                    prior=prior, recent=recent, delta_rate=recent.rate - prior.rate,
                    strength=_strength(prior, recent), sample_size=sample,
                    provenance_dates=provenance,
                )
            )
        elif falling:
            themes_falling.append(
                ThemeTrend(
                    slug=slug, label=theme_labels.get(slug, ""), direction="falling",
                    prior=prior, recent=recent, delta_rate=recent.rate - prior.rate,
                    strength=_strength(prior, recent), sample_size=sample,
                    provenance_dates=provenance,
                )
            )
    themes_rising.sort(key=lambda t: (-t.delta_rate, -t.sample_size))
    themes_falling.sort(key=lambda t: (t.delta_rate, -t.sample_size))

    # Streaks for habits with enough history to be meaningful.
    streaks: list[HabitStreak] = []
    for slug, dates in habit_dates.items():
        if len(dates) < MIN_SUPPORT:
            continue
        streak = _streak_for(dates, active_dates, as_of)
        streak.slug = slug
        streak.label = habit_labels.get(slug, "")
        streaks.append(streak)
    streaks.sort(key=lambda s: (-s.current_streak, -s.total_occurrences))
    streaks = streaks[:MAX_STREAKS]

    caveats = _build_caveats(prior_window, recent_window, len(active_dates), window_days)

    return JournalPatternsResponse(
        generated_at=now_iso or datetime.now(LOCAL_TIMEZONE).isoformat(),
        as_of=as_of.isoformat(),
        window_days=window_days,
        recent_window=recent_window,
        prior_window=prior_window,
        habits_dropping=habits_dropping,
        habits_emerging=habits_emerging,
        habit_streaks=streaks,
        themes_rising=themes_rising,
        themes_falling=themes_falling,
        caveats=caveats,
    )


def _build_caveats(
    prior: WindowStat, recent: WindowStat, total_active: int, window_days: int
) -> list[str]:
    caveats: list[str] = []
    if recent.active_days < MIN_ACTIVE_DAYS:
        caveats.append(
            f"Only {recent.active_days} journaled day(s) in the recent {window_days}-day "
            "window — findings are tentative."
        )
    if prior.active_days == 0:
        caveats.append(
            "No journaling in the prior window, so drop-off and rising/falling "
            "comparisons have no baseline."
        )
    elif prior.active_days < MIN_ACTIVE_DAYS:
        caveats.append(
            f"Only {prior.active_days} journaled day(s) in the prior window — the "
            "baseline for comparison is thin."
        )
    if total_active < 2 * MIN_ACTIVE_DAYS:
        caveats.append(
            f"Only {total_active} journaled day(s) of signal in total; treat all "
            "patterns as directional, not conclusive."
        )
    return caveats


def compute_patterns(
    *,
    window_days: int | None = None,
    as_of: str | None = None,
    user_id: str | None = None,
) -> JournalPatternsResponse:
    """Store-backed entry point: load Layer 1 signals and run ``analyze()``.

    Reads the full history (streaks need it), so no date filter on the store
    reads. ``as_of`` (ISO date) overrides the default anchor (latest journaled day).
    """
    resolved_user = user_id or get_default_user_context().user_id
    win = window_days or JOURNAL_PATTERN_WINDOW_DAYS
    anchor: date | None = None
    if as_of:
        try:
            anchor = date.fromisoformat(as_of)
        except ValueError:
            anchor = None

    habit_events = list_habit_events(user_id=resolved_user)
    theme_events = list_theme_events(user_id=resolved_user)
    extracted_dates = list_extracted_dates(user_id=resolved_user)

    return analyze(
        habit_events,
        theme_events,
        extracted_dates,
        as_of=anchor,
        window_days=win,
    )

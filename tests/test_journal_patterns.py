"""Unit tests for Layer 2 pattern analytics (``app.journal_patterns.analyze``).

The analytics core is pure — it takes plain lists of habit/theme mention-days
plus the set of journaled dates and returns a fully-computed report — so these
tests exercise the drop-off / emerging / rhythm / theme-trend logic on synthetic
fixtures with NO database and NO network.

Runnable with pytest or directly: ``python tests/test_journal_patterns.py``.
"""

import os
import sys
from datetime import date, timedelta

os.environ.setdefault("OPENAI_API_KEY", "test-key")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.journal_patterns import analyze  # noqa: E402

AS_OF = date(2026, 6, 30)
WINDOW = 30
NOW = "2026-06-30T12:00:00"

# For AS_OF/WINDOW=30: recent = 2026-06-01..06-30, prior = 2026-05-02..05-31.
ALL_JUNE = [(date(2026, 6, 1) + timedelta(days=i)).isoformat() for i in range(30)]
ALL_MAY = [(date(2026, 5, 2) + timedelta(days=i)).isoformat() for i in range(30)]
BOTH_WINDOWS = ALL_MAY + ALL_JUNE


def _habits(mapping: dict[str, list[str]]) -> list[dict]:
    return [
        {"entry_date": d, "habit_slug": slug, "habit_label": slug}
        for slug, days in mapping.items()
        for d in days
    ]


def _themes(mapping: dict[str, list[str]]) -> list[dict]:
    return [
        {"entry_date": d, "theme_slug": slug, "theme_label": slug}
        for slug, days in mapping.items()
        for d in days
    ]


def _find(items, slug):
    return next((it for it in items if it.slug == slug), None)


def _run(habit_map=None, theme_map=None, active=None):
    return analyze(
        _habits(habit_map or {}),
        _themes(theme_map or {}),
        active if active is not None else BOTH_WINDOWS,
        as_of=AS_OF,
        window_days=WINDOW,
        now_iso=NOW,
    )


# --- drop-off ---------------------------------------------------------------

def test_dropping_habit_is_flagged():
    may_runs = ["2026-05-02", "2026-05-05", "2026-05-08", "2026-05-11",
                "2026-05-14", "2026-05-17", "2026-05-20", "2026-05-23"]
    report = _run(habit_map={"run": may_runs})  # 8 prior days, 0 recent
    run = _find(report.habits_dropping, "run")
    assert run is not None, "run should be flagged as dropping off"
    assert run.direction == "dropping"
    assert run.prior.count == 8 and run.recent.count == 0
    assert run.delta_rate < 0
    assert run.strength == "strong"  # sample 8, both windows fully covered


def test_dropping_provenance_lists_the_source_dates():
    may_runs = ["2026-05-02", "2026-05-09", "2026-05-16", "2026-05-23", "2026-05-30"]
    report = _run(habit_map={"run": may_runs})
    run = _find(report.habits_dropping, "run")
    assert run is not None
    assert set(run.provenance_dates) == set(may_runs)  # exactly the days it occurred


def test_low_support_habit_is_not_called_dropping():
    # Only 2 prior occurrences: below MIN_SUPPORT, so no credible drop claim.
    report = _run(habit_map={"cook": ["2026-05-03", "2026-05-04"]})
    assert _find(report.habits_dropping, "cook") is None
    assert _find(report.habits_emerging, "cook") is None


# --- emerging ---------------------------------------------------------------

def test_emerging_habit_is_flagged():
    june_climbs = ["2026-06-02", "2026-06-06", "2026-06-10", "2026-06-14", "2026-06-18"]
    report = _run(habit_map={"climb": june_climbs})  # 0 prior, 5 recent
    climb = _find(report.habits_emerging, "climb")
    assert climb is not None, "climb should be flagged as emerging"
    assert climb.direction == "emerging"
    assert climb.prior.count == 0 and climb.recent.count == 5
    assert climb.delta_rate > 0


def test_steady_habit_is_not_flagged():
    steady = ["2026-05-03", "2026-05-08", "2026-05-13", "2026-05-18", "2026-05-23",
              "2026-06-03", "2026-06-08", "2026-06-13", "2026-06-18", "2026-06-23"]
    report = _run(habit_map={"pray": steady})  # ~equal both windows
    assert _find(report.habits_dropping, "pray") is None
    assert _find(report.habits_emerging, "pray") is None


# --- honesty / strength -----------------------------------------------------

def test_thin_coverage_makes_findings_weak_and_adds_caveat():
    active = ["2026-05-29", "2026-05-30", "2026-05-31",  # 3 prior journaled days
              "2026-06-28", "2026-06-29", "2026-06-30"]  # 3 recent journaled days
    report = _run(habit_map={"walk": ["2026-05-29", "2026-05-30", "2026-05-31"]}, active=active)
    walk = _find(report.habits_dropping, "walk")
    assert walk is not None and walk.direction == "dropping"
    assert walk.strength == "weak", "thin coverage must not read as strong"
    assert report.caveats, "thin coverage should surface a caveat"


def test_rate_uses_journaled_days_as_denominator():
    # 6 journaled days in the recent window, habit on all 6 -> rate 1.0, even
    # though the calendar window is 30 days. Absence off-journal doesn't count.
    active = ["2026-06-01", "2026-06-10", "2026-06-20", "2026-06-25", "2026-06-28", "2026-06-30"]
    report = _run(habit_map={"x": list(active)}, active=active)
    # x is emerging (no prior) — grab it from whichever bucket; check its recent rate.
    x = _find(report.habits_emerging, "x") or _find(report.habits_dropping, "x")
    assert x is not None
    assert x.recent.active_days == 6 and x.recent.count == 6
    assert abs(x.recent.rate - 1.0) < 1e-9


# --- rhythm (cadence, not streaks) ------------------------------------------

def test_rhythm_active_when_within_cadence():
    # Mentioned every ~7 days, most recent is as_of -> active, gap-tolerant.
    read_days = ["2026-06-02", "2026-06-09", "2026-06-16", "2026-06-23", "2026-06-30"]
    report = _run(habit_map={"read": read_days}, active=ALL_JUNE)
    r = _find(report.habit_rhythms, "read")
    assert r is not None
    assert r.status == "active"
    assert r.typical_gap_days == 7.0  # median of the 7-day gaps
    assert r.days_since_last == 0
    assert r.total_occurrences == 5


def test_rhythm_lapsed_when_far_past_cadence():
    # ~weekly for a stretch, then silent for 20 days -> well past its rhythm.
    report = _run(habit_map={"garden": ["2026-06-01", "2026-06-05", "2026-06-10"]}, active=ALL_JUNE)
    r = _find(report.habit_rhythms, "garden")
    assert r is not None
    assert r.days_since_last == 20  # 06-10 -> 06-30
    assert r.typical_gap_days == 4.5  # median gap of [4, 5]
    assert r.status == "lapsed"  # 20 / 4.5 ~= 4.4x its usual interval


def test_rhythm_two_mentions_never_called_lapsed():
    # With only two mentions the cadence is too shaky to declare a lapse.
    report = _run(habit_map={"cook": ["2026-06-01", "2026-06-08"]}, active=ALL_JUNE)
    r = _find(report.habit_rhythms, "cook")
    assert r is not None
    assert r.total_occurrences == 2
    assert r.status in ("active", "slowing")
    assert r.status != "lapsed"


# --- theme trends -----------------------------------------------------------

def test_theme_rising_and_falling():
    report = _run(theme_map={
        "work_stress": ["2026-05-02", "2026-05-05",  # 2 prior
                        "2026-06-01", "2026-06-05", "2026-06-10", "2026-06-15", "2026-06-20", "2026-06-25"],  # 6 recent
        "travel": ["2026-05-03", "2026-05-07", "2026-05-11", "2026-05-15", "2026-05-19", "2026-05-23",  # 6 prior
                   "2026-06-02"],  # 1 recent
    })
    assert _find(report.themes_rising, "work_stress") is not None
    assert _find(report.themes_falling, "travel") is not None


# --- empty / boundary -------------------------------------------------------

def test_empty_inputs_do_not_crash():
    report = analyze([], [], [], window_days=WINDOW, now_iso=NOW)
    assert report.habits_dropping == []
    assert report.habits_emerging == []
    assert report.habit_rhythms == []
    assert report.caveats  # should note there is no signal


def _run_all() -> None:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok - {name}")


if __name__ == "__main__":
    _run_all()
    print("All journal-patterns tests passed.")

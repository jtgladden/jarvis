"use client";

import Link from "next/link";
import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  Flame,
  Info,
  Play,
  RefreshCw,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type WindowStat = {
  start: string;
  end: string;
  active_days: number;
  count: number;
  rate: number;
};

type Trend = {
  slug: string;
  label: string;
  direction: string;
  prior: WindowStat;
  recent: WindowStat;
  delta_rate: number;
  strength: "strong" | "moderate" | "weak";
  sample_size: number;
  provenance_dates: string[];
};

type Streak = {
  slug: string;
  label: string;
  current_streak: number;
  longest_streak: number;
  days_since_last: number | null;
  last_date: string | null;
  total_occurrences: number;
  provenance_dates: string[];
};

type Narration = {
  summary: string;
  recommendations: { habit_slug: string; text: string }[];
  model: string;
};

type PatternsResponse = {
  generated_at: string;
  as_of: string;
  window_days: number;
  recent_window: WindowStat;
  prior_window: WindowStat;
  habits_dropping: Trend[];
  habits_emerging: Trend[];
  habit_streaks: Streak[];
  themes_rising: Trend[];
  themes_falling: Trend[];
  caveats: string[];
  narration: Narration | null;
};

type SignalsStatus = {
  extracted_entries: number;
  distinct_habits: number;
  distinct_themes: number;
  extraction_version: number;
  model: string;
};

type ExtractResult = {
  total_candidates: number;
  processed: number;
  skipped_up_to_date: number;
  failed: number;
  extraction_version: number;
  model: string;
  dry_run: boolean;
};

const STRENGTH_STYLES: Record<string, string> = {
  strong: "border-emerald-300/30 bg-emerald-400/15 text-emerald-100",
  moderate: "border-amber-300/30 bg-amber-400/15 text-amber-100",
  weak: "border-slate-300/20 bg-slate-400/10 text-slate-300",
};

function fmtRate(w: WindowStat): string {
  const pct = Math.round(w.rate * 100);
  return `${w.count}/${w.active_days} days (${pct}%)`;
}

// Habits/themes are identified by a normalized slug (e.g. "write", "call_family").
// Display the slug, humanized — NOT the raw surface phrase from one occurrence,
// which is an arbitrary (often event-specific) example and misleads as a title.
function humanizeSlug(slug: string): string {
  const s = slug.replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}

function ProvenanceDates({ dates }: { dates: string[] }) {
  if (!dates.length) return null;
  return (
    <details className="mt-2 text-xs text-slate-400">
      <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-300">
        {dates.length} source day{dates.length === 1 ? "" : "s"}
      </summary>
      <div className="mt-1 flex flex-wrap gap-1">
        {dates.map((d) => (
          <span key={d} className="rounded-md border border-white/8 bg-white/5 px-1.5 py-0.5">
            {d}
          </span>
        ))}
      </div>
    </details>
  );
}

function TrendCard({ trend }: { trend: Trend }) {
  return (
    <div className="rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.55)] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-slate-100">{humanizeSlug(trend.slug)}</div>
        <Badge className={`border ${STRENGTH_STYLES[trend.strength] || STRENGTH_STYLES.weak}`}>
          {trend.strength}
        </Badge>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-400">
        <div>
          <div className="text-slate-500">Prior window</div>
          <div className="text-slate-200">{fmtRate(trend.prior)}</div>
        </div>
        <div>
          <div className="text-slate-500">Recent window</div>
          <div className="text-slate-200">{fmtRate(trend.recent)}</div>
        </div>
      </div>
      <ProvenanceDates dates={trend.provenance_dates} />
    </div>
  );
}

function StreakCard({ streak }: { streak: Streak }) {
  return (
    <div className="rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.55)] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-slate-100">{humanizeSlug(streak.slug)}</div>
        {streak.current_streak > 0 ? (
          <Badge className="border border-orange-300/30 bg-orange-400/15 text-orange-100">
            <Flame className="mr-1 h-3 w-3" />
            {streak.current_streak} in a row
          </Badge>
        ) : streak.days_since_last != null ? (
          <span className="text-xs text-slate-500">{streak.days_since_last}d since last</span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>Longest run: <span className="text-slate-200">{streak.longest_streak}</span></span>
        <span>Total: <span className="text-slate-200">{streak.total_occurrences}</span></span>
        {streak.last_date ? <span>Last: <span className="text-slate-200">{streak.last_date}</span></span> : null}
      </div>
    </div>
  );
}

function Section({
  title,
  icon,
  items,
  empty,
  render,
}: {
  title: string;
  icon: React.ReactNode;
  items: unknown[];
  empty: string;
  render: () => React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-slate-400">
        {icon}
        {title}
        <span className="text-slate-600">({items.length})</span>
      </div>
      {items.length ? (
        <div className="grid gap-3 sm:grid-cols-2">{render()}</div>
      ) : (
        <div className="text-sm text-slate-500">{empty}</div>
      )}
    </div>
  );
}

export default function JournalPatternsPage() {
  const [status, setStatus] = useState<SignalsStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [limit, setLimit] = useState("5");
  const [dryRun, setDryRun] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractResult, setExtractResult] = useState<ExtractResult | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState<string | null>(null);

  const [windowDays, setWindowDays] = useState("30");
  const [narrate, setNarrate] = useState(true);
  const [loadingPatterns, setLoadingPatterns] = useState(false);
  const [patterns, setPatterns] = useState<PatternsResponse | null>(null);
  const [patternsError, setPatternsError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const res = await fetch(`${API_BASE}/journal/signals/status`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus((await res.json()) as SignalsStatus);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Failed to load status");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // Extraction runs in small batches so no single request approaches the
  // gateway timeout (a 297-entry run as one request 524s behind Cloudflare).
  // Each batch commits server-side and is idempotent, so the loop just walks
  // the backlog; an interrupted run resumes cleanly on the next click.
  const BATCH_SIZE = 10;

  const runExtraction = useCallback(async () => {
    setExtracting(true);
    setExtractError(null);
    setExtractResult(null);
    setExtractProgress(null);

    const n = parseInt(limit, 10);
    const target = !Number.isNaN(n) && n > 0 ? n : Infinity;

    try {
      // Dry run: one fast, API-free call that returns the full candidate count.
      if (dryRun) {
        const res = await fetch(`${API_BASE}/journal/signals/extract?dry_run=true`, { method: "POST" });
        if (!res.ok) throw new Error(`preview failed: ${res.status}`);
        setExtractResult((await res.json()) as ExtractResult);
        return;
      }

      let done = 0;
      let failed = 0;
      let candidates = 0;
      let version = 0;
      let model = "";
      while (done < target) {
        const batch = Math.min(BATCH_SIZE, target - done);
        setExtractProgress(`Extracting… ${done}${candidates ? ` of ~${candidates}` : ""} done`);
        const res = await fetch(`${API_BASE}/journal/signals/extract?limit=${batch}`, { method: "POST" });
        if (!res.ok) throw new Error(`extract failed after ${done} processed: ${res.status}`);
        const r = (await res.json()) as ExtractResult;
        done += r.processed;
        failed += r.failed;
        candidates = r.total_candidates;
        version = r.extraction_version;
        model = r.model;
        setExtractResult({
          total_candidates: candidates,
          processed: done,
          skipped_up_to_date: r.skipped_up_to_date,
          failed,
          extraction_version: version,
          model,
          dry_run: false,
        });
        // Fewer processed than the batch cap means the backlog is drained (or
        // only persistently-failing entries remain) — stop.
        if (r.processed < batch) break;
      }
      await loadStatus();
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "Extraction failed");
      await loadStatus(); // reflect whatever committed before the failure
    } finally {
      setExtracting(false);
      setExtractProgress(null);
    }
  }, [limit, dryRun, loadStatus]);

  const loadPatterns = useCallback(async () => {
    setLoadingPatterns(true);
    setPatternsError(null);
    try {
      const params = new URLSearchParams();
      const w = parseInt(windowDays, 10);
      if (!Number.isNaN(w) && w > 0) params.set("window_days", String(w));
      if (narrate) params.set("narrate", "true");
      const res = await fetch(`${API_BASE}/journal/patterns?${params.toString()}`);
      if (!res.ok) throw new Error(`patterns failed: ${res.status}`);
      setPatterns((await res.json()) as PatternsResponse);
    } catch (err) {
      setPatternsError(err instanceof Error ? err.message : "Failed to load patterns");
    } finally {
      setLoadingPatterns(false);
    }
  }, [windowDays, narrate]);

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Jarvis
          </Link>
          <h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold text-slate-100">
            <BarChart3 className="h-6 w-6 text-violet-300" />
            Journal patterns
          </h1>
        </div>
      </div>

      {/* Layer 1 — extraction */}
      <Card className="rounded-[1.6rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-5 w-5 text-violet-300" />
              Signal extraction
            </CardTitle>
            <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void loadStatus()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start gap-2 rounded-[1rem] border border-amber-300/25 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Running extraction sends your journal entry text to OpenAI ({status?.model || "the extraction model"}).
              This is the only step that leaves your machine. It runs in small batches, so a full backfill takes a
              little while but won’t time out — leave this tab open until it finishes. Use “Dry run” to preview counts
              without any API call, a small “limit” for a first taste, or leave the limit blank to process everything.
            </span>
          </div>

          {statusError ? (
            <div className="text-sm text-rose-300">Status error: {statusError}</div>
          ) : status ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-300">
              <span>Extracted entries: <span className="font-medium text-slate-100">{status.extracted_entries}</span></span>
              <span>Distinct habits: <span className="font-medium text-slate-100">{status.distinct_habits}</span></span>
              <span>Distinct themes: <span className="font-medium text-slate-100">{status.distinct_themes}</span></span>
              <span className="text-slate-500">v{status.extraction_version} · {status.model}</span>
            </div>
          ) : (
            <div className="text-sm text-slate-500">Loading status…</div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              Limit (entries this run)
              <Input
                type="number"
                min={1}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                className="h-10 w-40 rounded-xl"
                placeholder="all"
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="h-4 w-4 accent-violet-400"
              />
              Dry run (no API)
            </label>
            <Button className="rounded-xl" disabled={extracting} onClick={() => void runExtraction()}>
              <Play className="mr-1.5 h-4 w-4" />
              {extracting ? "Extracting…" : dryRun ? "Preview" : "Run extraction"}
            </Button>
          </div>

          {extractProgress ? <div className="text-sm text-slate-400">{extractProgress}</div> : null}
          {extractError ? (
            <div className="text-sm text-rose-300">
              {extractError} — anything already processed was saved; click again to resume.
            </div>
          ) : null}
          {extractResult ? (
            <div className="rounded-[1rem] border border-white/8 bg-[rgba(20,22,37,0.55)] p-3 text-sm text-slate-300">
              {extractResult.dry_run ? "Dry run — " : ""}
              candidates: <span className="text-slate-100">{extractResult.total_candidates}</span> ·{" "}
              processed: <span className="text-slate-100">{extractResult.processed}</span> ·{" "}
              already up-to-date: <span className="text-slate-100">{extractResult.skipped_up_to_date}</span>
              {extractResult.failed ? <> · <span className="text-rose-300">failed: {extractResult.failed}</span></> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Layer 2 + 3 — patterns */}
      <Card className="rounded-[1.6rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <BarChart3 className="h-5 w-5 text-violet-300" />
            Patterns &amp; recommendations
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              Window (days)
              <Input
                type="number"
                min={1}
                value={windowDays}
                onChange={(e) => setWindowDays(e.target.value)}
                className="h-10 w-32 rounded-xl"
              />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={narrate}
                onChange={(e) => setNarrate(e.target.checked)}
                className="h-4 w-4 accent-violet-400"
              />
              Narrate (LLM summary)
            </label>
            <Button className="rounded-xl" disabled={loadingPatterns} onClick={() => void loadPatterns()}>
              {loadingPatterns ? "Loading…" : "Load patterns"}
            </Button>
          </div>

          {patternsError ? <div className="text-sm text-rose-300">{patternsError}</div> : null}

          {patterns ? (
            <div className="space-y-6">
              <div className="text-xs text-slate-500">
                As of {patterns.as_of} · {patterns.window_days}-day windows · recent coverage{" "}
                {patterns.recent_window.active_days} journaled day(s), prior {patterns.prior_window.active_days}
              </div>

              {patterns.caveats.length ? (
                <div className="space-y-1 rounded-[1rem] border border-amber-300/25 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
                  {patterns.caveats.map((c, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{c}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {patterns.narration ? (
                <div className="rounded-[1.2rem] border border-violet-300/25 bg-violet-400/10 p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-violet-100">
                    <Sparkles className="h-4 w-4" />
                    Summary
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-100">{patterns.narration.summary}</p>
                  {patterns.narration.recommendations.length ? (
                    <ul className="mt-3 space-y-1.5">
                      {patterns.narration.recommendations.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-slate-200">
                          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-300" />
                          <span>
                            {r.text}
                            {r.habit_slug ? <span className="ml-1 text-xs text-slate-500">({r.habit_slug})</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="mt-2 text-[10px] uppercase tracking-widest text-slate-500">{patterns.narration.model}</div>
                </div>
              ) : null}

              <Section
                title="Dropping off"
                icon={<TrendingDown className="h-4 w-4 text-rose-300" />}
                items={patterns.habits_dropping}
                empty="No habits are clearly declining."
                render={() => patterns.habits_dropping.map((t) => <TrendCard key={t.slug} trend={t} />)}
              />
              <Section
                title="Emerging"
                icon={<TrendingUp className="h-4 w-4 text-emerald-300" />}
                items={patterns.habits_emerging}
                empty="No newly emerging habits."
                render={() => patterns.habits_emerging.map((t) => <TrendCard key={t.slug} trend={t} />)}
              />
              <Section
                title="Streaks"
                icon={<Flame className="h-4 w-4 text-orange-300" />}
                items={patterns.habit_streaks}
                empty="No streaks yet."
                render={() => patterns.habit_streaks.map((s) => <StreakCard key={s.slug} streak={s} />)}
              />
              <Section
                title="Themes rising"
                icon={<TrendingUp className="h-4 w-4 text-sky-300" />}
                items={patterns.themes_rising}
                empty="No rising themes."
                render={() => patterns.themes_rising.map((t) => <TrendCard key={t.slug} trend={t} />)}
              />
              <Section
                title="Themes fading"
                icon={<TrendingDown className="h-4 w-4 text-slate-300" />}
                items={patterns.themes_falling}
                empty="No fading themes."
                render={() => patterns.themes_falling.map((t) => <TrendCard key={t.slug} trend={t} />)}
              />
            </div>
          ) : (
            <div className="text-sm text-slate-500">
              Extract some entries above, then load patterns. If nothing shows, you likely need more journaled days
              in the window.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

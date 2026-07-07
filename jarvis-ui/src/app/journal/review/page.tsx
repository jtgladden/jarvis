"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import React, { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Combine,
  Eye,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Trash2,
  Wand2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MarkdownContent } from "@/components/markdown-content";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type Batch = {
  id: number;
  source_file: string;
  page_count: number;
  scan_target: "journal" | "scripture";
  model: string;
  status: "pending" | "extracted" | "committed" | "error";
  error?: string | null;
  created_at?: string | null;
  fragment_count: number;
  pending_count: number;
  committed_count: number;
  low_confidence_count: number;
  failed_group_count: number;
  default_year: number | null;
};

type Fragment = {
  id: number;
  batch_id: number;
  page_index: number;
  detected_date?: string | null;
  date_text?: string | null;
  date_detected: boolean;
  text_markdown: string;
  confidence: "high" | "medium" | "low";
  status: "pending" | "reviewed" | "committed" | "discarded";
  source_model: string;
  anomalies: string[];
  resolved_date?: string | null;
  year_inferred: boolean;
  year_rollover: boolean;
};

type BatchDetail = {
  batch: Batch;
  fragments: Fragment[];
  existing_dates: string[];
  anomaly_summary: string[];
};

type Spend = {
  total_cost_usd: number;
  total_tokens: number;
  total_calls: number;
  budget_usd: number;
  tokens_today: number;
  daily_token_cap: number;
  by_model: { model: string; tokens: number; cost_usd: number; calls: number }[];
};

const ANOMALY_LABELS: Record<string, string> = {
  low_confidence: "low confidence",
  illegible_heavy: "illegible-heavy",
  undated: "undated",
  date_exists: "date exists",
  date_out_of_order: "date out of order",
  year_unresolved: "year unresolved",
};

type CommitResult = {
  batch_id: number;
  committed_dates: string[];
  committed_fragment_ids: number[];
  conflicts: { entry_date: string; fragment_ids: number[] }[];
  skipped_undated: number[];
  unresolved_years: number[];
};

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const CONFIDENCE_STYLES: Record<Fragment["confidence"], string> = {
  high: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30",
  medium: "bg-amber-500/15 text-amber-300 border-amber-400/30",
  low: "bg-rose-500/15 text-rose-300 border-rose-400/30",
};

// --- Batch list --------------------------------------------------------------

function SpendBar({ spend }: { spend: Spend }) {
  const pct = spend.budget_usd > 0 ? Math.min(100, (spend.total_cost_usd / spend.budget_usd) * 100) : 0;
  const over = spend.budget_usd > 0 && spend.total_cost_usd >= spend.budget_usd;
  return (
    <Card className="mb-4">
      <CardContent className="space-y-2 p-4 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Import spend</span>
          <span className={over ? "text-rose-400" : "text-muted-foreground"}>
            ${spend.total_cost_usd.toFixed(2)}{spend.budget_usd > 0 ? ` / $${spend.budget_usd.toFixed(2)}` : " (no budget cap)"}
          </span>
        </div>
        {spend.budget_usd > 0 && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className={`h-full rounded-full ${over ? "bg-rose-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="text-xs text-muted-foreground">
          {spend.total_tokens.toLocaleString()} tokens · {spend.total_calls} calls
          {spend.daily_token_cap > 0 && <> · today {spend.tokens_today.toLocaleString()} / {spend.daily_token_cap.toLocaleString()}</>}
          {spend.by_model.length > 0 && <> · {spend.by_model.map((m) => `${m.model} $${m.cost_usd.toFixed(2)}`).join(", ")}</>}
        </div>
        <p className="text-[11px] text-muted-foreground/70">Cost is estimated from token usage — verify per-model prices in config.</p>
      </CardContent>
    </Card>
  );
}

function BatchList({ onOpen }: { onOpen: (id: number) => void }) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [batchRes, spendRes] = await Promise.all([
        fetch(`${API_BASE}/journal/import/batches`),
        fetch(`${API_BASE}/journal/import/spend`),
      ]);
      if (!batchRes.ok) throw new Error(`Request failed (${batchRes.status})`);
      const data = await batchRes.json();
      setBatches(data.batches ?? []);
      if (spendRes.ok) setSpend(await spendRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load batches.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteBatch = useCallback(async (batch: Batch) => {
    if (!window.confirm(`Delete batch "${baseName(batch.source_file)}" and its ${batch.fragment_count} staged fragment(s)? Committed journal entries are NOT affected.`)) return;
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batch.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    }
  }, [load]);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-xl">
          <Link href="/">
            <ArrowLeft className="mr-1.5 h-4 w-4" />Home
          </Link>
        </Button>
        <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />Refresh
        </Button>
      </div>

      <h1 className="mb-1 text-xl font-semibold">Journal import review</h1>
      <p className="mb-4 text-sm text-muted-foreground">
        Review scanned batches, fix dates, edit markdown, then commit into your journal.
      </p>

      {spend && <SpendBar spend={spend} />}
      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && batches.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
      {!loading && batches.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No scan batches yet. Run <code>scripts/import_journal_pdfs.py</code> to stage some.
        </p>
      )}

      <div className="space-y-2">
        {batches.map((batch) => (
          <Card key={batch.id} className="cursor-pointer transition hover:border-primary/40" onClick={() => onOpen(batch.id)}>
            <CardContent className="flex items-center justify-between gap-3 p-4 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium">{baseName(batch.source_file)}</div>
                <div className="text-muted-foreground">
                  {batch.page_count} page{batch.page_count === 1 ? "" : "s"} · {batch.fragment_count} fragment
                  {batch.fragment_count === 1 ? "" : "s"} · {batch.pending_count} pending · {batch.committed_count} committed
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {batch.low_confidence_count > 0 && (
                  <Badge variant="outline" className="border-rose-400/30 bg-rose-500/10 text-rose-300">
                    {batch.low_confidence_count} low-conf
                  </Badge>
                )}
                {batch.failed_group_count > 0 && (
                  <Badge variant="outline" className="border-amber-400/30 bg-amber-500/10 text-amber-300">
                    {batch.failed_group_count} failed
                  </Badge>
                )}
                <Badge variant="outline" className="capitalize">{batch.scan_target}</Badge>
                <Badge variant={batch.status === "error" ? "destructive" : "secondary"}>{batch.status}</Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 rounded-lg p-0 text-muted-foreground hover:text-rose-400"
                  title="Delete batch"
                  onClick={(e) => { e.stopPropagation(); void deleteBatch(batch); }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

// --- Single fragment editor --------------------------------------------------

function FragmentCard({
  fragment,
  conflict,
  pageCount,
  onChanged,
}: {
  fragment: Fragment;
  conflict: boolean;
  pageCount: number;
  onChanged: () => void;
}) {
  // The date field needs a full ISO date; a partial (MM-DD) detected_date shows
  // as its resolved full date so the user confirms/edits the resolved value.
  const initialDate = fragment.resolved_date ?? (fragment.detected_date ?? "");
  const [date, setDate] = useState(initialDate);
  const [text, setText] = useState(fragment.text_markdown);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [srcPage, setSrcPage] = useState(fragment.page_index);
  const dirty = date !== initialDate || text !== fragment.text_markdown;

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      try {
        const res = await fetch(`${API_BASE}/journal/import/fragments/${fragment.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        onChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Save failed.");
      } finally {
        setSaving(false);
      }
    },
    [fragment.id, onChanged]
  );

  const [showSource, setShowSource] = useState(false);
  // Anomaly labels other than date_exists (which already has its own badge).
  const otherAnomalies = fragment.anomalies.filter((a) => a !== "date_exists");

  return (
    <Card className="border-white/10">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">page {fragment.page_index}</Badge>
          <Badge variant="outline" className={CONFIDENCE_STYLES[fragment.confidence]}>
            {fragment.confidence}
          </Badge>
          {!fragment.date_detected && !fragment.resolved_date && !fragment.detected_date && (
            <Badge variant="outline" className="border-amber-400/30 bg-amber-500/15 text-amber-300">
              no date detected
            </Badge>
          )}
          {conflict && (
            <Badge variant="outline" className="border-rose-400/40 bg-rose-500/15 text-rose-300">
              <AlertTriangle className="mr-1 h-3 w-3" />date exists
            </Badge>
          )}
          {otherAnomalies.map((a) => (
            <Badge key={a} variant="outline" className="border-orange-400/30 bg-orange-500/10 text-orange-300">
              {ANOMALY_LABELS[a] ?? a}
            </Badge>
          ))}
          {fragment.year_rollover ? (
            <Badge variant="outline" className="border-yellow-400/40 bg-yellow-500/15 text-yellow-200" title="Year bumped at a Dec→Jan rollover — worth confirming">
              year rollover → {fragment.resolved_date?.slice(0, 4)}
            </Badge>
          ) : fragment.year_inferred ? (
            <Badge variant="outline" className="border-sky-400/30 bg-sky-500/10 text-sky-300" title="Year supplied by the resolver (not written on the page)">
              year inferred → {fragment.resolved_date?.slice(0, 4)}
            </Badge>
          ) : null}
          {fragment.source_model && (
            <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">{fragment.source_model}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-white/15 bg-transparent px-2 py-1 text-sm outline-none focus:border-primary/50"
          />
          {fragment.date_text && (!date || !fragment.date_detected) && (
            <span className="text-xs text-amber-300" title="Date heading read from the page — set the ISO date (add the year)">
              read: “{fragment.date_text}”
            </span>
          )}
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-7 rounded-lg px-2 text-xs" onClick={() => setShowSource((s) => !s)}>
              <ImageIcon className="mr-1 h-3 w-3" />{showSource ? "Hide page" : "Source page"}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 rounded-lg px-2 text-xs" onClick={() => setPreview((p) => !p)}>
              {preview ? <><Pencil className="mr-1 h-3 w-3" />Edit</> : <><Eye className="mr-1 h-3 w-3" />Preview</>}
            </Button>
          </div>
        </div>

        {showSource && (
          <div className="space-y-1">
            {/* An entry can continue across pages; page through them to verify. */}
            <div className="flex items-center justify-center gap-3 text-xs text-muted-foreground">
              <Button
                size="sm" variant="ghost" className="h-6 rounded px-2"
                disabled={srcPage <= 0}
                onClick={() => setSrcPage((p) => Math.max(0, p - 1))}
              >
                ‹ Prev
              </Button>
              <span>page {srcPage} of {pageCount}{srcPage === fragment.page_index ? " (entry start)" : ""}</span>
              <Button
                size="sm" variant="ghost" className="h-6 rounded px-2"
                disabled={srcPage >= pageCount - 1}
                onClick={() => setSrcPage((p) => Math.min(pageCount - 1, p + 1))}
              >
                Next ›
              </Button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${API_BASE}/journal/import/batches/${fragment.batch_id}/pages/${srcPage}`}
              alt={`Source page ${srcPage}`}
              className="max-h-[520px] w-full rounded-lg border border-white/10 object-contain"
            />
          </div>
        )}

        {preview ? (
          <div className="min-h-[80px] rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            {text.trim() ? <MarkdownContent>{text}</MarkdownContent> : <span className="text-sm text-muted-foreground">Nothing to preview.</span>}
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="min-h-[140px] w-full rounded-lg border border-white/15 bg-transparent px-3 py-2 font-mono text-sm outline-none focus:border-primary/50"
          />
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-lg text-xs"
            disabled={saving}
            onClick={() => void patch({ status: "discarded" })}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />Discard
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-lg text-xs"
            disabled={saving || !dirty}
            onClick={() => void patch({ detected_date: date || null, text_markdown: text, status: "reviewed" })}
          >
            <Check className="mr-1 h-3.5 w-3.5" />{saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Batch detail ------------------------------------------------------------

function BatchDetailView({ batchId, onBack }: { batchId: number; onBack: () => void }) {
  const [detail, setDetail] = useState<BatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [triaging, setTriaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attentionFirst, setAttentionFirst] = useState(false);
  const [onlyAttention, setOnlyAttention] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batchId}`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setDetail(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load batch.");
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const existingDates = useMemo(() => new Set(detail?.existing_dates ?? []), [detail]);

  // A fragment "needs attention" if it has any anomaly or isn't high-confidence.
  const needsAttention = useCallback(
    (f: Fragment) => f.anomalies.length > 0 || f.confidence !== "high" || f.year_rollover,
    []
  );

  // Group active (pending/reviewed) fragments by resolved date, in page order.
  // Optionally surface attention-needing dates first / only.
  const groups = useMemo(() => {
    const active = (detail?.fragments ?? [])
      .filter((f) => f.status === "pending" || f.status === "reviewed")
      .sort((a, b) => a.page_index - b.page_index || a.id - b.id);
    const map = new Map<string, Fragment[]>();
    for (const fragment of active) {
      const key = (fragment.detected_date ?? "").trim() || "__undated__";
      const list = map.get(key) ?? [];
      list.push(fragment);
      map.set(key, list);
    }
    let entries = Array.from(map.entries());
    if (onlyAttention) {
      entries = entries.filter(([, frags]) => frags.some(needsAttention));
    }
    entries.sort(([a], [b]) => a.localeCompare(b));
    if (attentionFirst) {
      entries.sort(([, fa], [, fb]) => {
        const sa = fa.some(needsAttention) ? 0 : 1;
        const sb = fb.some(needsAttention) ? 0 : 1;
        return sa - sb;
      });
    }
    return entries;
  }, [detail, onlyAttention, attentionFirst, needsAttention]);

  const triage = useCallback(async () => {
    setTriaging(true);
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batchId}/triage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`Triage failed (${res.status})`);
      const data = await res.json() as { upgraded: number; reviewed: number; cost_usd: number };
      await load();
      alert(`Re-ran ${data.reviewed} low-confidence fragment(s), improved ${data.upgraded} (est. $${data.cost_usd.toFixed(3)}).`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Triage failed.");
    } finally {
      setTriaging(false);
    }
  }, [batchId, load]);

  // Bulk-accept: mark every high-confidence, anomaly-free fragment reviewed so you
  // only hand-touch the uncertain minority.
  const acceptConfident = useCallback(async () => {
    const confident = (detail?.fragments ?? []).filter(
      (f) => f.status === "pending" && f.confidence === "high" && f.anomalies.length === 0
    );
    if (confident.length === 0) return;
    setBusy(true);
    try {
      for (const fragment of confident) {
        await fetch(`${API_BASE}/journal/import/fragments/${fragment.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "reviewed" }),
        });
      }
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Bulk accept failed.");
    } finally {
      setBusy(false);
    }
  }, [detail, load]);

  const mergeGroup = useCallback(
    async (fragments: Fragment[]) => {
      if (fragments.length < 2) return;
      const [first, ...rest] = fragments;
      const merged = fragments.map((f) => f.text_markdown.trim()).filter(Boolean).join("\n\n");
      try {
        await fetch(`${API_BASE}/journal/import/fragments/${first.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text_markdown: merged, status: "reviewed" }),
        });
        for (const fragment of rest) {
          await fetch(`${API_BASE}/journal/import/fragments/${fragment.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "discarded" }),
          });
        }
        await load();
      } catch (err) {
        alert(err instanceof Error ? err.message : "Merge failed.");
      }
    },
    [load]
  );

  const setDefaultYear = useCallback(async (year: number | null) => {
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_year: year }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      setDetail(await res.json());
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to set year.");
    }
  }, [batchId]);

  const commit = useCallback(async () => {
    setCommitting(true);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batchId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overwrite_existing: overwrite }),
      });
      if (!res.ok) throw new Error(`Commit failed (${res.status})`);
      setResult(await res.json());
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Commit failed.");
    } finally {
      setCommitting(false);
    }
  }, [batchId, overwrite, load]);

  const hasConflicts = groups.some(([key]) => key !== "__undated__" && existingDates.has(key));

  const deleteThisBatch = useCallback(async () => {
    if (!window.confirm("Delete this batch and its staged fragments? Committed journal entries are NOT affected.")) return;
    try {
      const res = await fetch(`${API_BASE}/journal/import/batches/${batchId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(`Delete failed (${res.status})`);
      onBack();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Delete failed.");
    }
  }, [batchId, onBack]);

  return (
    <>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" className="rounded-xl" onClick={onBack}>
          <ArrowLeft className="mr-1.5 h-4 w-4" />All batches
        </Button>
        <div className="flex gap-1">
          <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => void load()}>
            <RefreshCw className="mr-1.5 h-4 w-4" />Refresh
          </Button>
          <Button variant="ghost" size="sm" className="rounded-xl text-muted-foreground hover:text-rose-400" onClick={() => void deleteThisBatch()}>
            <Trash2 className="mr-1.5 h-4 w-4" />Delete
          </Button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && !detail && <p className="text-sm text-muted-foreground">Loading…</p>}

      {detail && (
        <>
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="truncate text-lg">{baseName(detail.batch.source_file)}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="capitalize">{detail.batch.scan_target}</Badge>
                <Badge variant="secondary">{detail.batch.status}</Badge>
                <span className="text-muted-foreground">
                  {detail.batch.page_count} pages · {detail.batch.pending_count} pending · {detail.batch.committed_count} committed
                </span>
                <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground" title="Seeds year resolution for partial (month/day only) dates">
                  Book year
                  <input
                    type="number"
                    placeholder="—"
                    defaultValue={detail.batch.default_year ?? ""}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      const next = v ? Number(v) : null;
                      if (next !== (detail.batch.default_year ?? null)) void setDefaultYear(next);
                    }}
                    className="w-20 rounded-lg border border-white/15 bg-transparent px-2 py-1 outline-none focus:border-primary/50"
                  />
                </label>
              </div>
              {detail.batch.error && (
                <p className="rounded-lg bg-rose-500/10 p-2 text-rose-300">{detail.batch.error}</p>
              )}
              {hasConflicts && (
                <p className="flex items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-rose-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  Some dates already have a journal entry. Committing skips them unless you allow overwrite.
                </p>
              )}
              {detail.anomaly_summary.length > 0 && (
                <p className="flex items-start gap-2 rounded-lg border border-orange-400/25 bg-orange-500/10 p-2 text-orange-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>Needs a look: {detail.anomaly_summary.join(" · ")}.</span>
                </p>
              )}

              {/* Triage controls: cut the pile down to the uncertain minority. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={triaging} onClick={() => void triage()}
                  title="Re-run low-confidence fragments on the premium model (uses cached pages)">
                  <Wand2 className="mr-1 h-3.5 w-3.5" />{triaging ? "Re-running…" : "Re-run low-confidence"}
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" disabled={busy} onClick={() => void acceptConfident()}
                  title="Mark every high-confidence, flag-free fragment reviewed">
                  <CheckCheck className="mr-1 h-3.5 w-3.5" />Accept confident
                </Button>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={attentionFirst} onChange={(e) => setAttentionFirst(e.target.checked)} />
                  Attention first
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} />
                  Only flagged
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
                  Overwrite existing entries
                </label>
                <Button size="sm" className="ml-auto rounded-lg" disabled={committing || groups.length === 0} onClick={() => void commit()}>
                  {committing ? "Committing…" : "Commit batch"}
                </Button>
              </div>
              {result && (
                <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-muted-foreground">
                  <div>Committed {result.committed_dates.length} date(s): {result.committed_dates.join(", ") || "none"}</div>
                  {result.conflicts.length > 0 && (
                    <div className="text-rose-300">
                      Skipped {result.conflicts.length} conflicting date(s): {result.conflicts.map((c) => c.entry_date).join(", ")}
                    </div>
                  )}
                  {result.skipped_undated.length > 0 && (
                    <div className="text-amber-300">Skipped {result.skipped_undated.length} undated fragment(s) — assign a date first.</div>
                  )}
                  {result.unresolved_years.length > 0 && (
                    <div className="text-amber-300">
                      Left {result.unresolved_years.length} fragment(s) with an unresolvable year — set the batch year or a full date first.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">No fragments left to review in this batch.</p>
          )}

          <div className="space-y-6">
            {groups.map(([key, fragments]) => {
              const undated = key === "__undated__";
              const conflict = !undated && existingDates.has(key);
              const commitPreview = fragments.map((f) => f.text_markdown.trim()).filter(Boolean).join("\n\n");
              return (
                <section key={key}>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-muted-foreground">
                      {undated ? "Undated" : key}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {fragments.length} fragment{fragments.length === 1 ? "" : "s"}
                    </span>
                    {conflict && (
                      <Badge variant="outline" className="border-rose-400/40 bg-rose-500/15 text-rose-300">conflict</Badge>
                    )}
                    {fragments.length > 1 && (
                      <Button size="sm" variant="outline" className="ml-auto h-7 rounded-lg text-xs" onClick={() => void mergeGroup(fragments)}>
                        <Combine className="mr-1 h-3.5 w-3.5" />Merge into one
                      </Button>
                    )}
                  </div>

                  {fragments.length > 1 && commitPreview && (
                    <Card className="mb-2 border-dashed border-white/15">
                      <CardContent className="p-3">
                        <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Commit preview (concatenated)</div>
                        <MarkdownContent>{commitPreview}</MarkdownContent>
                      </CardContent>
                    </Card>
                  )}

                  <div className="space-y-3">
                    {fragments.map((fragment) => (
                      <FragmentCard
                        key={fragment.id}
                        fragment={fragment}
                        conflict={conflict}
                        pageCount={detail.batch.page_count}
                        onChanged={() => void load()}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

// --- Page --------------------------------------------------------------------

function JournalReviewContent() {
  // Deep-link support: /journal/review?batch=<id> (e.g. after a web scan) opens
  // that batch directly. Seed from the URL at first render — no set-state-in-effect.
  const searchParams = useSearchParams();
  const batchParam = searchParams.get("batch");
  const initialBatch = batchParam && /^\d+$/.test(batchParam) ? Number(batchParam) : null;
  const [selectedBatch, setSelectedBatch] = useState<number | null>(initialBatch);

  const backToList = useCallback(() => {
    setSelectedBatch(null);
    window.history.replaceState(null, "", "/journal/review");
  }, []);

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      {selectedBatch === null ? (
        <BatchList onOpen={setSelectedBatch} />
      ) : (
        <BatchDetailView batchId={selectedBatch} onBack={backToList} />
      )}
    </main>
  );
}

export default function JournalReviewPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-6"><p className="text-sm text-muted-foreground">Loading…</p></main>}>
      <JournalReviewContent />
    </Suspense>
  );
}

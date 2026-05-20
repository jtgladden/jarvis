"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type CommandPreview = {
  action: string;
  gmail_query: string;
  description: string;
  target_label: string | null;
  archive: boolean;
  affected_count: number;
  has_more: boolean;
  dry_run: boolean;
};

const ACTION_LABELS: Record<string, string> = {
  trash: "Trash",
  archive: "Archive",
  mark_read: "Mark read",
  label: "Label",
  mark_handled: "Mark handled",
};

export function MailCommandPanel() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [result, setResult] = useState<CommandPreview | null>(null);
  const [error, setError] = useState("");

  const runPreview = async () => {
    const text = input.trim();
    if (!text) return;
    setLoading(true);
    setError("");
    setPreview(null);
    setResult(null);
    try {
      const res = await fetch(`${API_BASE}/email-commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: text, dry_run: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? `Failed to preview command (${res.status})`);
      }
      setPreview((await res.json()) as CommandPreview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview command.");
    } finally {
      setLoading(false);
    }
  };

  const runExecute = async () => {
    if (!preview) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API_BASE}/email-commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: input.trim(),
          dry_run: false,
          gmail_query: preview.gmail_query,
          action: preview.action,
          target_label: preview.target_label,
          archive: preview.archive,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new Error(body.detail ?? `Failed to run command (${res.status})`);
      }
      const data = (await res.json()) as CommandPreview;
      setResult(data);
      setPreview(null);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run command.");
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError("");
  };

  return (
    <div className="space-y-2">
      <button
        onClick={() => { setOpen((v) => !v); reset(); }}
        className="w-full rounded-[1.4rem] border border-white/8 bg-[rgba(17,19,34,0.82)] px-4 py-2.5 text-left text-sm text-slate-300 transition-colors hover:border-white/15 hover:text-slate-100"
      >
        <span className="font-medium">Bulk commands</span>
        <span className="ml-2 text-slate-500">{open ? "▲" : "▼"}</span>
      </button>

      {open ? (
        <Card className="rounded-[1.8rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
          <CardContent className="space-y-4 p-4">
            {error ? (
              <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p>
            ) : null}

            {result ? (
              <div className="space-y-3">
                <div className="rounded-[1.2rem] border border-emerald-400/20 bg-emerald-500/8 px-3 py-3">
                  <p className="text-sm font-medium text-emerald-300">
                    {ACTION_LABELS[result.action] ?? result.action} applied to {result.affected_count} email{result.affected_count !== 1 ? "s" : ""}
                    {result.has_more ? " (limit reached — run again for more)" : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">{result.description}</p>
                </div>
                <Button size="sm" variant="outline" className="rounded-2xl" onClick={reset}>
                  New command
                </Button>
              </div>
            ) : preview ? (
              <div className="space-y-3">
                <div className="rounded-[1.2rem] border border-amber-400/20 bg-amber-500/8 px-3 py-3">
                  <p className="text-sm font-medium text-amber-200">{preview.description}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    Affects <span className="font-medium text-slate-200">{preview.affected_count}</span> email{preview.affected_count !== 1 ? "s" : ""}
                    {preview.has_more ? " (showing first 1000)" : ""}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-slate-500">{preview.gmail_query}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="rounded-2xl"
                    onClick={() => void runExecute()}
                    disabled={loading || preview.affected_count === 0}
                  >
                    {loading ? "Running…" : `Confirm — ${ACTION_LABELS[preview.action] ?? preview.action} ${preview.affected_count}`}
                  </Button>
                  <Button size="sm" variant="outline" className="rounded-2xl" onClick={reset} disabled={loading}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">
                  Give a one-off command. Jarvis will preview what it will do before executing.
                </p>
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void runPreview();
                  }}
                  placeholder='e.g. "delete all emails from noreply@example.com"'
                  rows={2}
                  className="w-full resize-none rounded-[1.1rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                />
                <Button
                  size="sm"
                  className="rounded-2xl"
                  onClick={() => void runPreview()}
                  disabled={loading || !input.trim()}
                >
                  {loading ? "Analyzing…" : "Preview"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

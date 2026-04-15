"use client";

import React, { useEffect, useEffectEvent, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Inbox,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8000";

type Classification = {
  category?: string;
  importance_score?: number;
  needs_reply?: boolean;
  urgency?: string;
  suggested_action?: string;
  reason?: string;
};

type CleanupDecision = {
  action: "keep" | "archive" | "label";
  label_name?: string | null;
  archive: boolean;
  reason: string;
};

type Email = {
  id: string;
  thread_id: string;
  subject: string;
  sender: string;
  snippet: string;
  date?: string;
  labels?: string[];
  body?: string;
  classification?: Classification;
  cleanupDecision?: CleanupDecision;
};

type CleanupSummary = {
  total_processed: number;
  archived: number;
  labeled_only: number;
  kept: number;
};

type CleanupResponse = {
  dry_run: boolean;
  summary: CleanupSummary;
  items: Array<{
    email: Email;
    classification: Classification;
    decision: CleanupDecision;
  }>;
};

type CleanupJobStartResponse = {
  job_id: string;
  status: "queued" | "running";
};

type CleanupJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  dry_run: boolean;
  processed: number;
  total: number;
  current_subject?: string | null;
  result?: CleanupResponse | null;
  error?: string | null;
};

const categoryTone: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  action_required: "destructive",
  meeting: "default",
  reference: "secondary",
  newsletter: "outline",
  promotion: "outline",
  receipt: "secondary",
  spam: "destructive",
};

const decisionTone: Record<CleanupDecision["action"], "default" | "secondary" | "outline"> = {
  keep: "secondary",
  archive: "outline",
  label: "default",
};

function safeLower(value: string | undefined) {
  return (value || "").toLowerCase();
}

function decodeHtmlEntities(value: string | undefined) {
  if (!value) return "";
  if (typeof window === "undefined") return value;

  const textarea = window.document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}

function normalizeCleanupItems(data: CleanupResponse): Email[] {
  return data.items.map((item) => ({
    ...item.email,
    classification: item.classification,
    cleanupDecision: item.decision,
  }));
}

function EmailListItem({
  email,
  selected,
  onClick,
}: {
  email: Email;
  selected: boolean;
  onClick: () => void;
}) {
  const classification = email.classification || {};
  const cleanupDecision = email.cleanupDecision;

  return (
    <button
      onClick={onClick}
      className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
        selected ? "border-black bg-zinc-50" : "border-zinc-200 bg-white"
      }`}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-zinc-900">
            {decodeHtmlEntities(email.subject) || "(No subject)"}
          </div>
          <div className="truncate text-xs text-zinc-500">
            {decodeHtmlEntities(email.sender) || "Unknown sender"}
          </div>
        </div>

        {classification.importance_score ? (
          <Badge variant="secondary" className="shrink-0 rounded-xl">
            {classification.importance_score}/10
          </Badge>
        ) : null}
      </div>

      <p className="mb-3 line-clamp-2 text-sm text-zinc-600">
        {decodeHtmlEntities(email.snippet) || "No preview available."}
      </p>

      <div className="flex flex-wrap gap-2">
        {classification.category ? (
          <Badge
            variant={categoryTone[classification.category] || "secondary"}
            className="rounded-xl"
          >
            {classification.category.replaceAll("_", " ")}
          </Badge>
        ) : null}

        {classification.needs_reply ? (
          <Badge className="rounded-xl">needs reply</Badge>
        ) : null}

        {classification.urgency ? (
          <Badge variant="outline" className="rounded-xl">
            {classification.urgency}
          </Badge>
        ) : null}

        {cleanupDecision ? (
          <Badge variant={decisionTone[cleanupDecision.action]} className="rounded-xl">
            {cleanupDecision.action}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

export default function HomePage() {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [handleLoading, setHandleLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"classified" | "raw">("raw");
  const [inboxLimit, setInboxLimit] = useState("");
  const [cleanupSummary, setCleanupSummary] = useState<CleanupSummary | null>(null);
  const [cleanupLimit, setCleanupLimit] = useState("");
  const [cleanupJob, setCleanupJob] = useState<CleanupJobStatus | null>(null);

  const syncSelectedId = (nextEmails: Email[]) => {
    if (nextEmails.length > 0) {
      setSelectedId((prev) =>
        prev && nextEmails.some((email) => email.id === prev) ? prev : nextEmails[0].id
      );
      return;
    }

    setSelectedId(null);
  };

  const loadEmails = async (currentMode: "classified" | "raw" = mode) => {
    setLoading(true);
    setError("");

    try {
      const trimmed = inboxLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const queryString =
        trimmed && Number.isFinite(limit) && limit > 0 ? `?limit=${Math.floor(limit)}` : "";
      const endpoint = currentMode === "classified" ? "/classify" : "/emails";

      const response = await fetch(`${API_BASE}${endpoint}${queryString}`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();

      const normalized: Email[] =
        currentMode === "classified"
          ? data.map((item: { email: Email; classification: Classification }) => ({
              ...item.email,
              classification: item.classification,
            }))
          : data;

      setEmails(normalized);
      setCleanupSummary(null);
      setCleanupJob(null);
      syncSelectedId(normalized);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load emails.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const fetchEmailsEffect = useEffectEvent((currentMode: "classified" | "raw") => {
    void loadEmails(currentMode);
  });

  const runCleanup = async () => {
    setCleanupLoading(true);
    setError("");
    setCleanupSummary(null);

    try {
      const trimmed = cleanupLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const queryString =
        trimmed && Number.isFinite(limit) && limit > 0 ? `?limit=${Math.floor(limit)}` : "";
      const endpoint = "/cleanup/apply";

      const response = await fetch(`${API_BASE}${endpoint}${queryString}`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Cleanup request failed with status ${response.status}`);
      }

      const data: CleanupJobStartResponse = await response.json();
      setCleanupJob({
        job_id: data.job_id,
        status: data.status,
        dry_run: false,
        processed: 0,
        total: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start inbox cleanup.";
      setError(message);
      setCleanupLoading(false);
    }
  };

  const markHandled = async () => {
    if (!selectedEmail || !canMarkHandled) return;

    setHandleLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${selectedEmail.id}/handle`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Handle request failed with status ${response.status}`);
      }

      setEmails((currentEmails) => {
        const nextEmails = currentEmails.filter((email) => email.id !== selectedEmail.id);
        syncSelectedId(nextEmails);
        return nextEmails;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to mark email handled.";
      setError(message);
    } finally {
      setHandleLoading(false);
    }
  };

  useEffect(() => {
    fetchEmailsEffect(mode);
  }, [mode]);

  useEffect(() => {
    if (!cleanupJob || (cleanupJob.status !== "queued" && cleanupJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/cleanup/jobs/${cleanupJob.job_id}`);
        if (!response.ok) {
          throw new Error(`Cleanup status failed with status ${response.status}`);
        }

        const data: CleanupJobStatus = await response.json();
        setCleanupJob(data);

        if (data.status === "completed" && data.result) {
          const normalized = normalizeCleanupItems(data.result);
          setMode("classified");
          setEmails(normalized);
          setCleanupSummary(data.result.summary);
          syncSelectedId(normalized);
          setCleanupLoading(false);
        }

        if (data.status === "failed") {
          setError(data.error || "Cleanup failed.");
          setCleanupLoading(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch cleanup status.";
        setError(message);
        setCleanupLoading(false);
      }
    }, 1200);

    return () => window.clearInterval(poll);
  }, [cleanupJob]);

  const filteredEmails = useMemo(() => {
    const q = safeLower(query.trim());
    if (!q) return emails;

    return emails.filter((email) => {
      const haystack = [
        email.subject,
        email.sender,
        email.snippet,
        email.body,
        email.classification?.category,
        email.classification?.reason,
        email.cleanupDecision?.action,
        email.cleanupDecision?.label_name,
        email.cleanupDecision?.reason,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(q);
    });
  }, [emails, query]);

  const selectedEmail =
    filteredEmails.find((email) => email.id === selectedId) ||
    filteredEmails[0] ||
    null;
  const canMarkHandled =
    mode === "classified" && selectedEmail?.labels?.includes("AI Important");

  const cleanupProgressPercent =
    cleanupJob && cleanupJob.total > 0
      ? Math.min(100, Math.round((cleanupJob.processed / cleanupJob.total) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-zinc-100 p-6 text-zinc-900">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Jarvis Mail Dashboard</h1>
            <p className="text-sm text-zinc-600">
              Browse all mail locally, review AI Important mail in the AI tab, and use full-inbox
              cleanup when you ask for it.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={mode === "classified" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setMode("classified")}
            >
              <Inbox className="mr-2 h-4 w-4" />
              AI view
            </Button>

            <Button
              variant={mode === "raw" ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => setMode("raw")}
            >
              <Archive className="mr-2 h-4 w-4" />
              Raw inbox
            </Button>

            <Button
              className="rounded-2xl"
              variant="outline"
              onClick={() => void loadEmails(mode)}
              disabled={loading || cleanupLoading}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>

            <Input
              type="number"
              min="1"
              value={inboxLimit}
              onChange={(e) => setInboxLimit(e.target.value)}
              className="w-full rounded-2xl sm:w-36"
              placeholder={mode === "raw" ? "All mail" : "Summary cap"}
            />
          </div>
        </div>

        <Card className="rounded-3xl border-none shadow-sm">
          <CardHeader className="gap-3">
            <CardTitle className="flex items-center gap-2 text-lg">
              <ShieldCheck className="h-5 w-5" />
              Inbox cleanup
            </CardTitle>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <p className="max-w-2xl text-sm text-zinc-600">
                Clean up the whole inbox with one click. Every processed
                message is labeled as AI Important or AI Unimportant and then archived
                so the inbox can reach zero. This version never deletes messages.
              </p>
              <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
                <Input
                  type="number"
                  min="1"
                  value={cleanupLimit}
                  onChange={(e) => setCleanupLimit(e.target.value)}
                  className="w-full rounded-2xl sm:w-32"
                  placeholder="All mail"
                />
                <Button
                  className="rounded-2xl"
                  onClick={() => void runCleanup()}
                  disabled={loading || cleanupLoading}
                >
                  <Archive className="mr-2 h-4 w-4" />
                  {cleanupLoading ? "Working..." : "Clean inbox"}
                </Button>
              </div>
            </div>
          </CardHeader>

          {cleanupJob ? (
            <CardContent className="space-y-4">
              <div className="rounded-2xl bg-zinc-50 p-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge
                    variant={
                      cleanupJob.status === "completed"
                        ? "default"
                        : cleanupJob.status === "failed"
                          ? "destructive"
                          : "secondary"
                    }
                    className="rounded-xl"
                  >
                    {cleanupJob.status}
                  </Badge>
                  <Badge variant="outline" className="rounded-xl">
                    Cleanup job
                  </Badge>
                  <Badge variant="outline" className="rounded-xl">
                    {cleanupJob.processed}/{cleanupJob.total || "?"} processed
                  </Badge>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-zinc-200">
                  <div
                    className="h-full rounded-full bg-zinc-900 transition-all"
                    style={{ width: `${cleanupProgressPercent}%` }}
                  />
                </div>

                <div className="mt-3 flex flex-col gap-1 text-sm text-zinc-600">
                  <div>
                    {cleanupJob.status === "completed"
                      ? "Cleanup finished."
                      : cleanupJob.status === "failed"
                        ? cleanupJob.error || "Cleanup failed."
                        : "Cleanup is running."}
                  </div>
                  {cleanupJob.current_subject ? (
                    <div className="truncate">Current email: {cleanupJob.current_subject}</div>
                  ) : null}
                </div>
              </div>

              {cleanupSummary ? (
                <>
                  <div className="grid gap-3 md:grid-cols-4">
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Processed
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.total_processed}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Archived
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.archived}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">
                          Labeled only
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.labeled_only}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-zinc-500">Kept</div>
                        <div className="mt-1 text-2xl font-semibold">{cleanupSummary.kept}</div>
                      </CardContent>
                    </Card>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="default" className="rounded-xl">
                      Changes applied
                    </Badge>
                    <Badge variant="outline" className="rounded-xl">
                      Safe mode: archive and label only
                    </Badge>
                    <Badge variant="outline" className="rounded-xl">
                      Cleanup uses only Important and Unimportant
                    </Badge>
                  </div>
                </>
              ) : null}
            </CardContent>
          ) : null}
        </Card>

        <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
          <Card className="rounded-3xl border-none shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Mail className="h-5 w-5" />
                Inbox
              </CardTitle>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search subject, sender, category..."
                  className="rounded-2xl pl-9"
                />
              </div>
            </CardHeader>

            <CardContent>
              {error ? (
                <div className="mb-4 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4" />
                  <div>{error}</div>
                </div>
              ) : null}

              <ScrollArea className="h-[65vh] pr-3">
                <div className="space-y-3">
                  {filteredEmails.length === 0 && !loading && !cleanupLoading ? (
                    <div className="rounded-2xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500">
                      No emails found.
                    </div>
                  ) : null}

                  {filteredEmails.map((email) => (
                    <EmailListItem
                      key={email.id}
                      email={email}
                      selected={selectedEmail?.id === email.id}
                      onClick={() => setSelectedId(email.id)}
                    />
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="rounded-3xl border-none shadow-sm">
            <CardHeader>
              <CardTitle className="text-lg">Email detail</CardTitle>
            </CardHeader>

            <CardContent>
              {!selectedEmail ? (
                <div className="rounded-2xl border border-dashed border-zinc-300 p-8 text-sm text-zinc-500">
                  Select an email to view details.
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="space-y-2">
                    <h2 className="text-2xl font-semibold leading-tight">
                      {decodeHtmlEntities(selectedEmail.subject) || "(No subject)"}
                    </h2>
                    <div className="text-sm text-zinc-600">
                      From: {decodeHtmlEntities(selectedEmail.sender) || "Unknown sender"}
                    </div>
                    {selectedEmail.date ? (
                      <div className="text-sm text-zinc-500">{selectedEmail.date}</div>
                    ) : null}
                    {canMarkHandled ? (
                      <div className="pt-2">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            onClick={() => void markHandled()}
                            disabled={handleLoading}
                          >
                            {handleLoading ? "Marking..." : "Mark handled"}
                          </Button>
                          <span className="text-xs text-zinc-500">
                            Removes <span className="font-medium text-zinc-700">AI Important</span>{" "}
                            and adds{" "}
                            <span className="font-medium text-zinc-700">Reviewed</span>.
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {selectedEmail.cleanupDecision ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={decisionTone[selectedEmail.cleanupDecision.action]}
                          className="rounded-xl"
                        >
                          {selectedEmail.cleanupDecision.action}
                        </Badge>
                        {selectedEmail.cleanupDecision.archive ? (
                          <Badge variant="outline" className="rounded-xl">
                            removes inbox label
                          </Badge>
                        ) : null}
                        {selectedEmail.cleanupDecision.label_name ? (
                          <Badge variant="secondary" className="rounded-xl">
                            {selectedEmail.cleanupDecision.label_name}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-zinc-700">
                        {selectedEmail.cleanupDecision.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.classification ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Category
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.category || "Unknown"}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Importance
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.importance_score || "—"}/10
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-zinc-500">
                            Suggested action
                          </div>
                          <div className="mt-1 text-base font-medium">
                            {selectedEmail.classification.suggested_action || "—"}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {selectedEmail.classification?.reason ? (
                    <div className="rounded-2xl bg-zinc-50 p-4">
                      <div className="mb-1 text-xs uppercase tracking-wide text-zinc-500">
                        Why it was classified this way
                      </div>
                      <p className="text-sm text-zinc-700">
                        {selectedEmail.classification.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.labels?.length ? (
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                        Current Gmail labels
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {selectedEmail.labels.map((label) => (
                          <Badge key={label} variant="outline" className="rounded-xl">
                            {label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                      Snippet
                    </div>
                    <p className="rounded-2xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                      {decodeHtmlEntities(selectedEmail.snippet) || "No snippet available."}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                      Body preview
                    </div>
                    <div className="max-h-[40vh] overflow-auto whitespace-pre-wrap rounded-2xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-700">
                      {decodeHtmlEntities(selectedEmail.body) || "No body text extracted."}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
                    <div className="mb-2 flex items-center gap-2 font-medium text-zinc-700">
                      <Trash2 className="h-4 w-4" />
                      Safety boundary
                    </div>
                    Cleanup in the dashboard only archives and labels mail right now. It never
                    deletes or trashes messages.
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

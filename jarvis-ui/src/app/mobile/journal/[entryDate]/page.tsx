"use client";

import Image from "next/image";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, CloudOff, Plus, RefreshCw, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

// localStorage key for a per-date offline draft
function draftKey(date: string) {
  return `jarvis_journal_draft_${date}`;
}

type CalendarAgendaItem = {
  event_id: string;
  title: string;
  start: string;
  end?: string | null;
  is_all_day: boolean;
  removed?: boolean;
};

type LanguagePracticeSession = {
  id: string;
  language: string;
  mode: string;
  minutes: number;
  notes: string;
  created_at?: string | null;
};

type JournalDayEntry = {
  date: string;
  date_label: string;
  calendar_summary: string;
  world_event_title?: string | null;
  world_event_summary: string;
  world_event_source?: string | null;
  world_event_articles: Array<{
    title: string;
    source?: string | null;
    link?: string | null;
  }>;
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  scripture_study: string;
  spiritual_notes: string;
  study_links: Array<{
    label: string;
    url: string;
    confidence: "exact" | "likely";
    matched_text?: string | null;
  }>;
  photo_data_url?: string | null;
  calendar_items: CalendarAgendaItem[];
  language_sessions: LanguagePracticeSession[];
  updated_at?: string | null;
};

// Fields persisted to the offline draft store
type OfflineDraft = {
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  scripture_study: string;
  spiritual_notes: string;
  photo_data_url?: string | null;
  calendar_items: CalendarAgendaItem[];
  savedAt: number; // Date.now()
};

type EditableJournalField =
  | "journal_entry"
  | "accomplishments"
  | "gratitude_entry"
  | "scripture_study"
  | "spiritual_notes";

function blankEntry(date: string): JournalDayEntry {
  return {
    date,
    date_label: date,
    calendar_summary: "",
    world_event_summary: "",
    world_event_articles: [],
    journal_entry: "",
    accomplishments: "",
    gratitude_entry: "",
    scripture_study: "",
    spiritual_notes: "",
    study_links: [],
    calendar_items: [],
    language_sessions: [],
  };
}

function readLocalDraft(date: string): OfflineDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(draftKey(date));
    return raw ? (JSON.parse(raw) as OfflineDraft) : null;
  } catch {
    return null;
  }
}

function writeLocalDraft(date: string, entry: JournalDayEntry) {
  if (typeof window === "undefined") return;
  try {
    const draft: OfflineDraft = {
      journal_entry: entry.journal_entry,
      accomplishments: entry.accomplishments,
      gratitude_entry: entry.gratitude_entry,
      scripture_study: entry.scripture_study,
      spiritual_notes: entry.spiritual_notes,
      photo_data_url: entry.photo_data_url ?? null,
      calendar_items: entry.calendar_items,
      savedAt: Date.now(),
    };
    localStorage.setItem(draftKey(date), JSON.stringify(draft));
  } catch { /* storage quota or private mode */ }
}

function clearLocalDraft(date: string) {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(draftKey(date)); } catch { /* ignore */ }
}

function applyDraftToEntry(base: JournalDayEntry, draft: OfflineDraft): JournalDayEntry {
  return {
    ...base,
    journal_entry: draft.journal_entry,
    accomplishments: draft.accomplishments,
    gratitude_entry: draft.gratitude_entry,
    scripture_study: draft.scripture_study,
    spiritual_notes: draft.spiritual_notes,
    photo_data_url: draft.photo_data_url ?? base.photo_data_url,
    calendar_items: draft.calendar_items,
  };
}

function formatScheduleDateTime(value: string | null | undefined, isAllDay = false) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, isAllDay
    ? { weekday: "short", month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(parsed);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getStudyLinkPatterns(
  links: Array<{ matched_text?: string | null; label?: string | null }> | null | undefined
) {
  if (!links?.length) return [];
  return Array.from(
    new Set(
      links.flatMap((link) =>
        [link.matched_text, link.label]
          .map((value) => (value || "").trim())
          .filter((value) => value.length >= 2)
      )
    )
  ).sort((left, right) => right.length - left.length);
}

function highlightStudyLinkedText(
  text: string | null | undefined,
  links: Array<{ matched_text?: string | null; label?: string | null }> | null | undefined
): React.ReactNode {
  const value = text || "";
  const patterns = getStudyLinkPatterns(links);
  if (!value || !patterns.length) return value;
  const matcher = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi");
  const segments = value.split(matcher);
  return segments.map((segment, index) =>
    patterns.some((pattern) => segment.toLowerCase() === pattern.toLowerCase()) ? (
      <mark
        key={`${segment}-${index}`}
        className="rounded-md bg-cyan-400/18 px-1 py-0.5 text-cyan-50 ring-1 ring-cyan-300/25"
      >
        {segment}
      </mark>
    ) : (
      <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>
    )
  );
}

export default function MobileJournalDetailPage({
  params,
}: {
  params: Promise<{ entryDate: string }>;
}) {
  const [entryDate, setEntryDate] = useState("");
  const [entry, setEntry] = useState<JournalDayEntry | null>(null);
  const [draft, setDraft] = useState<JournalDayEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  // Whether an unsynced offline draft exists that hasn't been pushed to the server
  const [hasUnsyncedDraft, setHasUnsyncedDraft] = useState(false);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const autoSyncAttemptedRef = useRef(false);

  useEffect(() => {
    void params.then((resolved) => setEntryDate(resolved.entryDate));
  }, [params]);

  // Track online/offline transitions
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Load entry — from server/SW cache; fall back to localStorage draft when offline
  useEffect(() => {
    if (!entryDate) return;

    const loadEntry = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API_BASE}/journal/${entryDate}`);
        if (!response.ok) {
          throw new Error(`Journal lookup failed with status ${response.status}`);
        }
        const data = (await response.json()) as JournalDayEntry;

        // If there's a local draft that's newer than the server entry, apply it
        const localDraft = readLocalDraft(entryDate);
        const serverTime = data.updated_at ? new Date(data.updated_at).getTime() : 0;
        if (localDraft && localDraft.savedAt > serverTime) {
          const merged = applyDraftToEntry(data, localDraft);
          setEntry(data);    // keep server version for reset
          setDraft(merged);  // prefill edit form with local changes
          setHasUnsyncedDraft(true);
        } else {
          setEntry(data);
          setDraft(data);
          if (localDraft) {
            // Local draft is older than server — discard stale draft
            clearLocalDraft(entryDate);
          }
        }
      } catch {
        // Network/server failure — try to recover from a local draft or blank form
        const localDraft = readLocalDraft(entryDate);
        const fallback = blankEntry(entryDate);
        if (localDraft) {
          const recovered = applyDraftToEntry(fallback, localDraft);
          setEntry(recovered);
          setDraft(recovered);
          setHasUnsyncedDraft(true);
          setError("");
        } else {
          // Nothing cached: start a blank draft so the user can still write
          setEntry(fallback);
          setDraft(fallback);
          if (!navigator.onLine) {
            setError("You're offline — this entry isn't cached yet. You can still draft it and it will sync when you reconnect.");
          } else {
            setError("Failed to load journal entry. You can still draft below.");
          }
        }
      } finally {
        setLoading(false);
      }
    };

    void loadEntry();
  }, [entryDate]);

  // When coming back online and an unsynced draft exists, auto-sync once
  useEffect(() => {
    if (!isOnline || !hasUnsyncedDraft || !entryDate || !draft || autoSyncAttemptedRef.current) return;
    autoSyncAttemptedRef.current = true;
    void syncDraftToServer();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, hasUnsyncedDraft, entryDate]);

  const syncDraftToServer = async () => {
    if (!entryDate || !draft) return;
    setSyncing(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journal_entry: draft.journal_entry,
          accomplishments: draft.accomplishments,
          gratitude_entry: draft.gratitude_entry,
          scripture_study: draft.scripture_study,
          spiritual_notes: draft.spiritual_notes,
          photo_data_url: draft.photo_data_url || null,
          calendar_items: draft.calendar_items,
        }),
      });
      if (!response.ok) throw new Error(`Sync failed with status ${response.status}`);
      const saved = (await response.json()) as JournalDayEntry;
      setEntry(saved);
      setDraft(saved);
      clearLocalDraft(entryDate);
      setHasUnsyncedDraft(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
      autoSyncAttemptedRef.current = false; // allow retry on next reconnect
    } finally {
      setSyncing(false);
    }
  };

  const saveEntry = async () => {
    if (!entryDate || !draft) return;

    // Offline: persist locally and queue for sync
    if (!navigator.onLine) {
      writeLocalDraft(entryDate, draft);
      setHasUnsyncedDraft(true);
      setEntry(draft); // update view-mode state so the saved text is visible immediately
      setEditing(false);
      setError("");
      autoSyncAttemptedRef.current = false;
      return;
    }

    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journal_entry: draft.journal_entry,
          accomplishments: draft.accomplishments,
          gratitude_entry: draft.gratitude_entry,
          scripture_study: draft.scripture_study,
          spiritual_notes: draft.spiritual_notes,
          photo_data_url: draft.photo_data_url || null,
          calendar_items: draft.calendar_items,
        }),
      });
      if (!response.ok) throw new Error(`Journal save failed with status ${response.status}`);
      const saved = (await response.json()) as JournalDayEntry;
      setEntry(saved);
      setDraft(saved);
      clearLocalDraft(entryDate);
      setHasUnsyncedDraft(false);
      setEditing(false);
    } catch (err) {
      // Save failed even though navigator.onLine — could be server issue.
      // Persist locally so work isn't lost.
      writeLocalDraft(entryDate, draft);
      setHasUnsyncedDraft(true);
      setError(err instanceof Error ? err.message : "Save failed. Draft saved locally.");
    } finally {
      setSaving(false);
    }
  };

  const extractCitations = async () => {
    if (!entryDate || !draft) return;
    setExtracting(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}/extract-citations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journal_entry: draft.journal_entry,
          accomplishments: draft.accomplishments,
          gratitude_entry: draft.gratitude_entry,
          scripture_study: draft.scripture_study,
          spiritual_notes: draft.spiritual_notes,
          photo_data_url: draft.photo_data_url || null,
          calendar_items: draft.calendar_items,
        }),
      });
      if (!response.ok) throw new Error(`Citation extraction failed with status ${response.status}`);
      const saved = (await response.json()) as JournalDayEntry;
      setEntry(saved);
      setDraft(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to extract citations.");
    } finally {
      setExtracting(false);
    }
  };

  const updateDraftField = (field: EditableJournalField, value: string) => {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  };

  const updateCalendarItem = (index: number, updater: (item: CalendarAgendaItem) => CalendarAgendaItem) => {
    setDraft((current) =>
      current
        ? { ...current, calendar_items: current.calendar_items.map((item, i) => i === index ? updater(item) : item) }
        : current
    );
  };

  const addCalendarItem = () => {
    setDraft((current) =>
      current
        ? {
            ...current,
            calendar_items: [
              ...current.calendar_items,
              {
                event_id: `custom-${current.date}-${current.calendar_items.length}`,
                title: "",
                start: current.date,
                end: null,
                is_all_day: true,
                removed: false,
              },
            ],
          }
        : current
    );
  };

  const handlePhotoChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !draft) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) return;
      setDraft((current) => (current ? { ...current, photo_data_url: result } : current));
    };
    reader.readAsDataURL(file);
  };

  const displayedCalendarItems = editing
    ? (draft?.calendar_items ?? [])
    : (entry?.calendar_items ?? []);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#13162c_0%,#0c0e1c_100%)] px-4 pb-10 pt-4 text-slate-100">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Button asChild variant="outline" className="rounded-2xl">
            <Link href="/mobile?tab=journal">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            {editing ? (
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => void extractCitations()}
                disabled={saving || extracting || !draft || !isOnline}
              >
                {extracting ? "Extracting..." : "Extract citations"}
              </Button>
            ) : null}
            <Button
              variant={editing ? "default" : "outline"}
              className="rounded-2xl"
              onClick={() => {
                if (editing) { void saveEntry(); return; }
                setEditing(true);
              }}
              disabled={saving || extracting || !draft}
            >
              {saving ? "Saving..." : editing ? (isOnline ? "Save" : "Save offline") : "Edit"}
            </Button>
            <Button variant="outline" className="rounded-2xl" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Offline indicator */}
        {!isOnline ? (
          <div className="flex items-center gap-2 rounded-[1.4rem] border border-amber-300/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            <CloudOff className="h-4 w-4 shrink-0" />
            Offline — edits will save locally and sync when reconnected.
          </div>
        ) : null}

        {/* Unsynced draft banner */}
        {isOnline && hasUnsyncedDraft ? (
          <div className="flex items-center justify-between gap-3 rounded-[1.4rem] border border-cyan-300/20 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-200">
            <span>Unsynced local draft — ready to push to server.</span>
            <Button
              size="sm"
              variant="outline"
              className="rounded-xl border-cyan-300/30 text-cyan-100"
              onClick={() => void syncDraftToServer()}
              disabled={syncing}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {syncing ? "Syncing..." : "Sync now"}
            </Button>
          </div>
        ) : null}

        {error ? (
          <div className="rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
          <CardHeader className="pb-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100">
              <BookOpen className="h-3.5 w-3.5" />
              Journal day
            </div>
            <CardTitle className="mt-3 text-xl">{entry?.date_label || (loading ? "Loading..." : entryDate)}</CardTitle>
            {entry?.updated_at ? (
              <div className="mt-2 text-sm text-slate-400">
                Saved {new Date(entry.updated_at).toLocaleString()}
              </div>
            ) : null}
            {hasUnsyncedDraft && !isOnline ? (
              <div className="mt-2 text-sm text-amber-300/80">Draft saved locally</div>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Calendar</div>
              <div className="mt-2 text-sm leading-6 text-slate-200">
                {(draft?.calendar_summary || entry?.calendar_summary) || (loading ? "Loading day summary..." : "No calendar summary.")}
              </div>
            </div>

            {displayedCalendarItems.length ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Events</div>
                  {editing ? (
                    <Button size="sm" variant="outline" className="rounded-xl" onClick={addCalendarItem}>
                      <Plus className="mr-2 h-4 w-4" />
                      Add
                    </Button>
                  ) : null}
                </div>
                <div className="mt-2 space-y-2">
                  {displayedCalendarItems
                    .filter((item) => editing || !item.removed)
                    .map((item, index) => (
                      <div key={`${item.event_id}-${index}`} className="rounded-xl border border-white/8 px-3 py-2">
                        {editing ? (
                          <>
                            <input
                              value={item.title}
                              onChange={(e) => updateCalendarItem(index, (i) => ({ ...i, title: e.target.value }))}
                              placeholder="Event title"
                              className="h-10 w-full rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                            />
                            <div className="mt-2 flex items-center justify-between gap-3">
                              <div className="text-xs text-slate-400">{formatScheduleDateTime(item.start, item.is_all_day)}</div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-xl"
                                onClick={() => updateCalendarItem(index, (i) => ({ ...i, removed: !i.removed }))}
                              >
                                {item.removed ? "Restore" : "Remove"}
                              </Button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-sm text-white">{item.title}</div>
                            <div className="mt-1 text-xs text-slate-400">{formatScheduleDateTime(item.start, item.is_all_day)}</div>
                          </>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ) : null}

            {entry?.world_event_title || entry?.world_event_summary ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">World event</div>
                <div className="mt-2 text-sm font-medium text-white">{entry?.world_event_title || "No headline captured"}</div>
                <div className="mt-2 text-sm leading-6 text-slate-300">{entry?.world_event_summary}</div>
              </div>
            ) : null}

            {editing ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Photo memory</div>
                  <label className="cursor-pointer text-xs text-cyan-100 underline decoration-cyan-300/30 underline-offset-4">
                    Add photo
                    <input type="file" accept="image/*" className="hidden" onChange={(e) => void handlePhotoChange(e)} />
                  </label>
                </div>
                {draft?.photo_data_url ? (
                  <div className="mt-3 space-y-3">
                    <div className="relative h-56 overflow-hidden rounded-[1rem]">
                      <Image src={draft.photo_data_url} alt={draft.date_label} fill unoptimized className="object-cover" />
                    </div>
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="rounded-xl"
                        onClick={() => setDraft((current) => (current ? { ...current, photo_data_url: null } : current))}
                      >
                        Remove photo
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 rounded-[1rem] border border-dashed border-white/10 px-4 py-5 text-sm text-slate-400">
                    Add one image to remember the day.
                  </div>
                )}
              </div>
            ) : entry?.photo_data_url ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 p-3">
                <div className="relative h-56 overflow-hidden rounded-[1rem]">
                  <Image src={entry.photo_data_url} alt={entry.date_label} fill unoptimized className="object-cover" />
                </div>
              </div>
            ) : null}

            {editing && draft ? (
              <>
                <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Study</div>
                  <input
                    value={draft.scripture_study}
                    onChange={(e) => updateDraftField("scripture_study", e.target.value)}
                    placeholder="What did you study today?"
                    className="mt-2 h-10 w-full rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500"
                  />
                </div>

                {(
                  [
                    ["Spiritual notes", "spiritual_notes"],
                    ["Journal", "journal_entry"],
                    ["Accomplishments", "accomplishments"],
                    ["Gratitude", "gratitude_entry"],
                  ] as const
                ).map(([label, key]) => (
                  <div key={key} className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{label}</div>
                    <textarea
                      value={draft[key] as string}
                      onChange={(e) => updateDraftField(key, e.target.value)}
                      placeholder={
                        key === "spiritual_notes"
                          ? "Spiritual notes, impressions, questions, or insights."
                          : key === "journal_entry"
                            ? "Write a quick reflection about the day."
                            : key === "accomplishments"
                              ? "List wins, progress, or things you want to remember."
                              : "What felt good, generous, or worth appreciating today?"
                      }
                      className="mt-2 min-h-[120px] w-full rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 py-3 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
                    />
                  </div>
                ))}
              </>
            ) : (
              (
                [
                  ["Journal", entry?.journal_entry],
                  ["Accomplishments", entry?.accomplishments],
                  ["Gratitude", entry?.gratitude_entry],
                  ["Study", entry?.scripture_study],
                  ["Spiritual notes", entry?.spiritual_notes],
                ] as const
              ).map(([label, value]) =>
                value && value.trim() ? (
                  <div key={label} className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">{label}</div>
                    <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">
                      {label === "Study" || label === "Spiritual notes"
                        ? highlightStudyLinkedText(value, entry?.study_links)
                        : value}
                    </div>
                  </div>
                ) : null
              )
            )}

            {entry?.language_sessions?.length ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Language practice</div>
                <div className="mt-2 space-y-2">
                  {Object.entries(
                    entry.language_sessions.reduce<Record<string, { minutes: number; sessions: number }>>((acc, s) => {
                      const key = s.language;
                      if (!acc[key]) acc[key] = { minutes: 0, sessions: 0 };
                      acc[key].minutes += s.minutes;
                      acc[key].sessions += 1;
                      return acc;
                    }, {})
                  ).map(([language, stats]) => (
                    <div key={language} className="flex items-center justify-between text-sm">
                      <span className="capitalize text-slate-200">{language}</span>
                      <span className="text-slate-400">{stats.minutes} min · {stats.sessions} {stats.sessions === 1 ? "session" : "sessions"}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {entry?.study_links?.length ? (
              <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
                <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Study links</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {entry.study_links.map((link) => (
                    <div
                      key={`${link.label}-${link.url}`}
                      className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-100"
                    >
                      <a href={link.url} target="_blank" rel="noreferrer" className="transition hover:text-cyan-50">
                        {link.label}
                      </a>
                      <span className="rounded-full border border-white/10 bg-white/8 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-200">
                        {link.confidence === "exact" ? "Exact match" : "Likely source"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {editing ? (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  className="rounded-2xl"
                  onClick={() => void extractCitations()}
                  disabled={saving || extracting || !draft || !isOnline}
                >
                  {extracting ? "Extracting..." : "Extract citations"}
                </Button>
                <Button
                  className="rounded-2xl"
                  onClick={() => void saveEntry()}
                  disabled={saving || extracting || !draft}
                >
                  {saving ? "Saving..." : isOnline ? "Save and close" : "Save offline"}
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

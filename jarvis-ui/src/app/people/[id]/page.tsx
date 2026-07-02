"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Image as ImageIcon, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type TimelineItem = {
  kind: "journal" | "photo";
  date: string;
  sort_key: string;
  entry_id?: string | null;
  matched_alias?: string | null;
  snippet?: string | null;
  uid?: string | null;
  thumb_url?: string | null;
  instance_key?: string | null;
};

type PhotoprismRef = {
  instance_key: string;
  subject_uid: string;
  subject_name: string;
};

type PersonTimeline = {
  id: string;
  canonical_name: string;
  aliases: string[];
  photoprism: PhotoprismRef[];
  timeline: TimelineItem[];
};

function formatDate(value: string): string {
  const iso = value.length >= 10 ? value.slice(0, 10) : value;
  const parsed = new Date(iso + "T00:00:00");
  if (Number.isNaN(parsed.getTime())) return value || "Unknown date";
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function PersonPage() {
  const params = useParams<{ id: string }>();
  const personId = params?.id;
  const [data, setData] = useState<PersonTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!personId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/people/${personId}`);
      if (res.status === 404) {
        setError("Person not found.");
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load person.");
    } finally {
      setLoading(false);
    }
  }, [personId]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const groups: { date: string; items: TimelineItem[] }[] = [];
    for (const item of data?.timeline ?? []) {
      const day = item.date ? item.date.slice(0, 10) : "";
      const last = groups[groups.length - 1];
      if (last && last.date === day) last.items.push(item);
      else groups.push({ date: day, items: [item] });
    }
    return groups;
  }, [data]);

  const journalCount = data?.timeline.filter((i) => i.kind === "journal").length ?? 0;
  const photoCount = data?.timeline.filter((i) => i.kind === "photo").length ?? 0;

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-xl">
          <Link href="/people">
            <ArrowLeft className="mr-1.5 h-4 w-4" />People
          </Link>
        </Button>
        <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-4 w-4" />Refresh
        </Button>
      </div>

      {error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && (
        <>
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="text-xl">{data.canonical_name}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {data.aliases.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">Also:</span>
                  {data.aliases.map((a) => (
                    <Badge key={a} variant="secondary">{a}</Badge>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {data.photoprism.map((ref) => (
                  <Badge key={`${ref.instance_key}:${ref.subject_uid}`} variant="outline">
                    {ref.instance_key}: {ref.subject_name || ref.subject_uid}
                  </Badge>
                ))}
              </div>
              <p className="text-muted-foreground">
                {journalCount} journal mention{journalCount === 1 ? "" : "s"} · {photoCount} photo
                {photoCount === 1 ? "" : "s"}
              </p>
            </CardContent>
          </Card>

          {grouped.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No journal mentions or photos found for this person yet.
            </p>
          )}

          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.date || Math.random()}>
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
                  {formatDate(group.date)}
                </h2>
                <div className="space-y-2">
                  {group.items.map((item, idx) =>
                    item.kind === "journal" ? (
                      <Card key={`j-${item.entry_id}-${idx}`}>
                        <CardContent className="flex gap-3 p-3 text-sm">
                          <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                          <div>
                            <Link
                              href={`/?journalDate=${item.entry_id}`}
                              className="text-primary hover:underline"
                            >
                              Journal entry
                            </Link>
                            <p className="mt-1 text-muted-foreground">{item.snippet}</p>
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <div
                        key={`p-${item.uid}-${idx}`}
                        className="inline-block align-top"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.thumb_url ?? ""}
                          alt="PhotoPrism photo"
                          loading="lazy"
                          className="h-32 w-32 rounded-xl object-cover"
                        />
                        <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <ImageIcon className="h-3 w-3" />
                          {item.instance_key}
                        </span>
                      </div>
                    ),
                  )}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </main>
  );
}

"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";
import { ArrowLeft, Newspaper, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";

type DashboardResponse = {
  generated_at: string;
  date_label: string;
  news_summary: string;
  news_items: Array<{
    title: string;
    source?: string | null;
    link?: string | null;
    published_at?: string | null;
  }>;
};

function formatNewsDateTime(value: string | null | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export default function MobileNewsPage() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const loadDashboard = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API_BASE}/dashboard`);
        if (!response.ok) {
          throw new Error(`Dashboard request failed with status ${response.status}`);
        }
        const data = (await response.json()) as DashboardResponse;
        setDashboard(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load news.");
      } finally {
        setLoading(false);
      }
    };

    void loadDashboard();
  }, []);

  return (
    <div className="min-h-screen bg-[linear-gradient(180deg,#13162c_0%,#0c0e1c_100%)] px-4 pb-10 pt-4 text-slate-100">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Button asChild variant="outline" className="rounded-2xl">
            <Link href="/mobile?tab=today">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <Button variant="outline" className="rounded-2xl" onClick={() => window.location.reload()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>

        {error ? (
          <div className="rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)]">
          <CardHeader className="pb-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-cyan-100">
              <Newspaper className="h-3.5 w-3.5" />
              News pulse
            </div>
            <CardTitle className="mt-3 text-xl">Articles behind today&apos;s summary</CardTitle>
            <div className="mt-2 text-sm text-slate-400">
              {dashboard?.date_label || (loading ? "Loading..." : "Today")}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3">
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Summary</div>
              <div className="mt-2 text-sm leading-6 text-slate-200">
                {dashboard?.news_summary || (loading ? "Loading news summary..." : "No news summary yet.")}
              </div>
            </div>

            <div className="space-y-3">
              {dashboard?.news_items?.length ? (
                dashboard.news_items.map((item, index) => (
                  <div
                    key={`${item.title}-${index}`}
                    className="rounded-[1.2rem] border border-white/8 bg-white/5 px-4 py-3"
                  >
                    <div className="text-sm font-medium text-white">{item.title}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      {item.source ? <span>{item.source}</span> : null}
                      {item.published_at ? <span>{formatNewsDateTime(item.published_at)}</span> : null}
                    </div>
                    {item.link ? (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-block text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                      >
                        Open article
                      </a>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="rounded-[1.2rem] border border-dashed border-white/10 px-4 py-4 text-sm text-slate-400">
                  {loading ? "Loading articles..." : "No news articles available right now."}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

"use client";

import Link from "next/link";
import { ArrowLeft, BarChart3 } from "lucide-react";
import { JournalPatternsPanel } from "@/components/journal-patterns-panel";

export default function JournalPatternsPage() {
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

      <JournalPatternsPanel />
    </div>
  );
}

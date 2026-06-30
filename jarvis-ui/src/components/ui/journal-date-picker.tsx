"use client";

import * as React from "react";
import { Popover } from "radix-ui";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function toKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function addDays(key: string, amount: number) {
  const date = fromKey(key);
  date.setDate(date.getDate() + amount);
  return toKey(date);
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function longLabel(key: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(fromKey(key));
}

/**
 * Themed replacement for <input type="date"> on the journal archive.
 * Days that already have a journal entry are marked with a dot so jumping is
 * informed. Built on the project's existing Radix Popover (no new dependency).
 */
export function JournalDatePicker({
  value,
  max,
  entryDates,
  onSelect,
}: {
  value: string | null;
  max?: string;
  entryDates: Set<string>;
  onSelect: (date: string) => void;
}) {
  const today = toKey(new Date());
  const maxKey = max ?? today;
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<Date>(() => startOfMonth(fromKey(value || today)));
  const [focused, setFocused] = React.useState<string>(value || today);
  const dayRefs = React.useRef<Map<string, HTMLButtonElement | null>>(new Map());

  // On open, sync the visible month + roving focus to the current selection.
  React.useEffect(() => {
    if (!open) return;
    const base = value || today;
    setView(startOfMonth(fromKey(base)));
    setFocused(base);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the displayed month following keyboard navigation across boundaries.
  React.useEffect(() => {
    const target = fromKey(focused);
    if (target.getFullYear() !== view.getFullYear() || target.getMonth() !== view.getMonth()) {
      setView(startOfMonth(target));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  // Move DOM focus to the roving day while the popover is open.
  React.useEffect(() => {
    if (open) {
      dayRefs.current.get(focused)?.focus();
    }
  }, [focused, open, view]);

  const cells = React.useMemo(() => {
    const first = startOfMonth(view);
    const cursor = new Date(first);
    cursor.setDate(first.getDate() - first.getDay()); // back up to Sunday
    const out: { key: string; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      out.push({ key: toKey(cursor), inMonth: cursor.getMonth() === view.getMonth() });
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }, [view]);

  const commit = (key: string) => {
    if (key > maxKey) return;
    onSelect(key);
    setOpen(false);
  };

  const onGridKeyDown = (event: React.KeyboardEvent) => {
    let next: string | null = null;
    switch (event.key) {
      case "ArrowLeft":
        next = addDays(focused, -1);
        break;
      case "ArrowRight":
        next = addDays(focused, 1);
        break;
      case "ArrowUp":
        next = addDays(focused, -7);
        break;
      case "ArrowDown":
        next = addDays(focused, 7);
        break;
      case "Home":
        next = addDays(focused, -fromKey(focused).getDay());
        break;
      case "End":
        next = addDays(focused, 6 - fromKey(focused).getDay());
        break;
      case "PageUp": {
        const date = fromKey(focused);
        date.setMonth(date.getMonth() - 1);
        next = toKey(date);
        break;
      }
      case "PageDown": {
        const date = fromKey(focused);
        date.setMonth(date.getMonth() + 1);
        next = toKey(date);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        commit(focused);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next && next <= maxKey) setFocused(next);
  };

  const monthLabel = new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: "numeric",
  }).format(view);
  const nextMonthStart = new Date(view.getFullYear(), view.getMonth() + 1, 1);
  const nextDisabled = toKey(nextMonthStart) > maxKey;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={value ? `Jump to date, selected ${longLabel(value)}` : "Jump to date"}
          className="flex h-9 flex-1 items-center justify-between gap-2 rounded-2xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 text-sm outline-none transition hover:border-white/20 focus-visible:border-violet-300/40 focus-visible:ring-2 focus-visible:ring-violet-300/30 data-[state=open]:border-violet-300/40"
        >
          <span className={value ? "text-slate-100" : "text-slate-500"}>
            {value ? longLabel(value) : "Pick a date"}
          </span>
          <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          className="z-50 w-[18rem] rounded-2xl border border-white/10 bg-[rgba(17,19,34,0.97)] p-3 text-slate-100 shadow-[0_16px_44px_rgba(6,7,14,0.5)] outline-none backdrop-blur-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dayRefs.current.get(value || today)?.focus();
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
              aria-label="Previous month"
              className="rounded-lg p-1 text-slate-400 outline-none transition hover:bg-white/5 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-violet-300/40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm font-medium">{monthLabel}</div>
            <button
              type="button"
              disabled={nextDisabled}
              onClick={() => setView(nextMonthStart)}
              aria-label="Next month"
              className="rounded-lg p-1 text-slate-400 outline-none transition hover:bg-white/5 hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-violet-300/40 disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] uppercase tracking-wide text-slate-500">
            {WEEKDAYS.map((weekday) => (
              <div key={weekday} className="py-1">
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5" role="grid" onKeyDown={onGridKeyDown}>
            {cells.map(({ key, inMonth }) => {
              const disabled = key > maxKey;
              const isSelected = key === value;
              const isToday = key === today;
              const hasEntry = entryDates.has(key);
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  ref={(element) => {
                    dayRefs.current.set(key, element);
                  }}
                  tabIndex={key === focused ? 0 : -1}
                  disabled={disabled}
                  aria-label={`${longLabel(key)} — ${hasEntry ? "entry" : "no entry"}`}
                  aria-current={isToday ? "date" : undefined}
                  aria-selected={isSelected}
                  onClick={() => commit(key)}
                  onFocus={() => setFocused(key)}
                  className={[
                    "relative flex h-9 items-center justify-center rounded-lg text-sm outline-none transition",
                    disabled
                      ? "cursor-not-allowed text-slate-700"
                      : "cursor-pointer hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-violet-300/50",
                    !inMonth && !disabled ? "text-slate-600" : "",
                    isSelected
                      ? "bg-violet-500/30 font-semibold text-violet-50 ring-1 ring-violet-300/50"
                      : isToday
                        ? "ring-1 ring-white/15"
                        : "",
                  ].join(" ")}
                >
                  {fromKey(key).getDate()}
                  {hasEntry && !isSelected ? (
                    <span className="absolute bottom-1 h-1 w-1 rounded-full bg-violet-300" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

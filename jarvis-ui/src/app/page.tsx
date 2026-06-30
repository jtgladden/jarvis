"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Activity,
  Archive,
  BookOpen,
  Briefcase,
  CalendarDays,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Inbox,
  Languages,
  LayoutGrid,
  Mail,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { AssistantPanel } from "@/components/assistant-panel";
import { JournalDatePicker } from "@/components/ui/journal-date-picker";
import { MailCommandPanel } from "@/components/mail-command-panel";
import { MailRulesPanel } from "@/components/mail-rules-panel";
import dynamic from "next/dynamic";
import { warmApiCache } from "@/lib/sw-cache";

const MovementMap = dynamic(
  () => import("@/components/movement-map").then((m) => ({ default: m.MovementMap })),
  { ssr: false }
);
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const IMPORTANT_LABEL = "Jarvis Important";
const UNIMPORTANT_LABEL = "Jarvis Unimportant";
const LIVE_MOVEMENT_REFRESH_MS = 15000;
const KM_TO_MILES = 0.621371;
const KG_TO_POUNDS = 2.20462;
const ML_TO_FLUID_OUNCES = 0.033814;
const LEGACY_IMPORTANT_LABELS = new Set(["Important", "AI Important", "Rules Important"]);
const LEGACY_UNIMPORTANT_LABELS = new Set([
  "Unimportant",
  "AI Unimportant",
  "Rules Unimportant",
  "Rules Security",
  "Rules Shopping",
]);
const ALL_MAILBOX = "ALL";
const JARVIS_REVIEW_MAILBOX = "JARVIS_REVIEW";
const DEFAULT_VISIBLE_MAILBOXES = new Set([
  JARVIS_REVIEW_MAILBOX,
  IMPORTANT_LABEL,
  UNIMPORTANT_LABEL,
  "Reviewed",
]);

type Classification = {
  category?: string;
  importance_score?: number;
  needs_reply?: boolean;
  urgency?: string;
  suggested_action?: string;
  short_summary?: string;
  why_it_matters?: string;
  action_items?: string[];
  deadline_hint?: string | null;
  suggested_reply?: string | null;
  calendar_relevant?: boolean;
  calendar_title?: string | null;
  calendar_start?: string | null;
  calendar_end?: string | null;
  calendar_is_all_day?: boolean;
  calendar_location?: string | null;
  calendar_notes?: string | null;
  reason?: string;
};

type CleanupDecision = {
  action: "keep" | "archive" | "label";
  label_name?: string | null;
  archive: boolean;
  reason: string;
};

type EmailLink = {
  url: string;
  label: string;
  kind: "link" | "button";
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
  links?: EmailLink[];
  classification?: Classification;
  cleanupDecision?: CleanupDecision;
};

type EmailPageResponse = {
  items: Email[];
  next_page_token?: string | null;
};

type JobListing = {
  id: string;
  title: string;
  company: string;
  location: string;
  salary_range: string | null;
  apply_url: string | null;
  source_email_id: string;
  source_email_subject: string;
  relevance_score: number;
  relevance_reason: string;
  qualifies: boolean;
  qualification_note: string;
  closes_at: string | null;
  is_new: boolean;
};

type JobAlertsResponse = {
  items: JobListing[];
  total: number;
  from_emails: number;
};

type JobAlertsJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  total: number;
  current_subject: string | null;
  result: JobAlertsResponse | null;
  error: string | null;
};

type ClassificationOverview = {
  mailbox: string;
  total_cached: number;
  needs_reply: number;
  action_item_count: number;
  deadlines_found: number;
  categories: Record<string, number>;
  urgency: Record<string, number>;
  top_senders: Array<{
    sender: string;
    count: number;
  }>;
  top_action_items: Array<{
    message_id: string;
    subject: string;
    sender: string;
    text: string;
    count: number;
  }>;
  deadline_highlights: Array<{
    message_id: string;
    subject: string;
    sender: string;
    text: string;
    count: number;
  }>;
};

type ClassificationGuidance = {
  text: string;
  updated_at?: string | null;
  version: string;
};

type GoogleOAuthStatus = {
  authorized: boolean;
  start_path?: string;
  instructions?: string;
};

type PlannedRouteOverlay = {
  name: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

type NearbyTrailItem = {
  id: string;
  name: string;
  source: "usgs" | "nps" | "osm_relation" | "osm_way";
  trail_type: string;
  ref?: string | null;
  operator?: string | null;
  network?: string | null;
  distance_from_center_m?: number | null;
  length_m?: number | null;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
  osm_url?: string | null;
};

function normalizeOverview(data: Partial<ClassificationOverview>): ClassificationOverview {
  const legacyDeadlineExamples = (data as Partial<{ deadline_examples: ClassificationOverview["deadline_highlights"] }>).deadline_examples;
  return {
    mailbox: data.mailbox || ALL_MAILBOX,
    total_cached: data.total_cached || 0,
    needs_reply: data.needs_reply || 0,
    action_item_count: data.action_item_count || 0,
    deadlines_found: data.deadlines_found || 0,
    categories: data.categories || {},
    urgency: data.urgency || {},
    top_senders: data.top_senders || [],
    top_action_items: data.top_action_items || [],
    deadline_highlights: data.deadline_highlights || legacyDeadlineExamples || [],
  };
}

function isGoogleAuthIssue(message: string | null | undefined) {
  const normalized = (message || "").toLowerCase();
  return (
    normalized.includes("gmail credentials") ||
    normalized.includes("google access") ||
    normalized.includes("google calendar access") ||
    normalized.includes("oauth") ||
    normalized.includes("token.json") ||
    normalized.includes("authorize google")
  );
}

function parseCalendarDate(value: string | null | undefined) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = new Date(value.replace(" ", "T") + "Z");
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatLocalDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftLocalDateKey(value: string, offsetDays: number) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  const next = new Date(parsed);
  next.setDate(next.getDate() + offsetDays);
  return formatLocalDateKey(next);
}

function formatSelectedDayLabel(value: string | null | undefined) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return "Selected day";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(parsed);
}

function isSameLocalDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function formatRelativeDayLabel(value: string | null | undefined) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return "Scheduled";

  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);

  if (isSameLocalDay(parsed, now)) {
    return "Today";
  }

  if (isSameLocalDay(parsed, tomorrow)) {
    return "Tomorrow";
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  }).format(parsed);
}

function formatDashboardTaskDueText(task: DashboardTaskItem) {
  if (!task.due_text) return null;

  const parsed = parseCalendarDate(task.due_text);
  if (!parsed) return task.due_text;

  if (task.source === "calendar") {
    return `${formatRelativeDayLabel(task.due_text)} · ${formatScheduleTimeRange({
      start: task.due_text,
    })}`;
  }

  return formatScheduleDateTime(task.due_text);
}

function formatTaskSourceLabel(source: DashboardTaskItem["source"]) {
  switch (source) {
    case "mail":
      return "Mail";
    case "calendar":
      return "Calendar";
    case "news":
      return "News";
    case "planning":
      return "Planning";
    default:
      return "Custom";
  }
}

function formatHealthStat(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined) return "--";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatDistanceMiles(valueKm: number | null | undefined, digits = 1) {
  if (valueKm === null || valueKm === undefined) return "--";
  return `${formatHealthStat(valueKm * KM_TO_MILES, digits)} mi`;
}

function formatWeightPounds(valueKg: number | null | undefined, digits = 1) {
  if (valueKg === null || valueKg === undefined) return "--";
  return `${formatHealthStat(valueKg * KG_TO_POUNDS, digits)} lb`;
}

function formatWaterFluidOunces(valueMl: number | null | undefined, digits = 0) {
  if (valueMl === null || valueMl === undefined) return "--";
  return `${formatHealthStat(valueMl * ML_TO_FLUID_OUNCES, digits)} fl oz`;
}

function formatMovementStoryText(
  story: string | null | undefined,
  { selectedDate }: { selectedDate: string | null | undefined },
) {
  const trimmed = (story || "").trim();
  if (!trimmed) return "No movement story generated yet.";

  const todayKey = formatLocalDateKey(new Date());
  const normalized = trimmed.replace(/(\d+(?:\.\d+)?)\s*km\b/gi, (_, value: string) =>
    formatDistanceMiles(Number(value), 1)
  );

  if (selectedDate && selectedDate !== todayKey) {
    return normalized.replace(/\btoday\b/gi, "that day");
  }

  return normalized;
}

function formatMinutes(value: number | null | undefined) {
  if (value === null || value === undefined) return "--";
  if (value < 60) return `${formatHealthStat(value)} min`;
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  if (minutes === 0) return `${hours} hr`;
  return `${hours} hr ${minutes} min`;
}

function healthMetricLabel(key: string) {
  const labels: Record<string, string> = {
    walking_running_distance_km: "Distance",
    flights_climbed: "Flights climbed",
    exercise_minutes: "Exercise",
    stand_minutes: "Stand",
    basal_energy_kcal: "Basal energy",
    avg_heart_rate_bpm: "Avg heart rate",
    latest_heart_rate_bpm: "Latest heart rate",
    walking_heart_rate_avg_bpm: "Walking HR avg",
    respiratory_rate_bpm: "Respiratory rate",
    oxygen_saturation_percent: "Oxygen saturation",
    hrv_sdnn_ms: "HRV",
    vo2_max: "VO2 max",
    body_mass_kg: "Weight",
    body_fat_percentage: "Body fat",
    body_mass_index: "BMI",
    water_intake_ml: "Water",
  };

  return labels[key] || key.replaceAll("_", " ");
}

function formatHealthMetricValue(key: string, value: number | string | null | undefined) {
  if (value === null || value === undefined) return "--";
  if (typeof value === "string") return value;

  switch (key) {
    case "walking_running_distance_km":
      return formatDistanceMiles(value, 1);
    case "exercise_minutes":
    case "stand_minutes":
      return `${formatHealthStat(value)} min`;
    case "basal_energy_kcal":
      return `${formatHealthStat(value)} Cal`;
    case "avg_heart_rate_bpm":
    case "latest_heart_rate_bpm":
    case "walking_heart_rate_avg_bpm":
    case "respiratory_rate_bpm":
      return `${formatHealthStat(value)} bpm`;
    case "oxygen_saturation_percent":
    case "body_fat_percentage":
      return `${formatHealthStat(value)}%`;
    case "hrv_sdnn_ms":
      return `${formatHealthStat(value)} ms`;
    case "body_mass_kg":
      return formatWeightPounds(value, 1);
    case "water_intake_ml":
      return formatWaterFluidOunces(value);
    default:
      return formatHealthStat(value, key === "vo2_max" || key === "body_mass_index" ? 1 : 0);
  }
}

function formatScheduleDayLabel(value: string) {
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(parsed);
}

function formatScheduleDateTime(value: string | null | undefined, isAllDay = false) {
  if (!value) return "Not scheduled";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;

  if (isAllDay) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(parsed);
  }

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatScheduleTime(value: string | null | undefined) {
  if (!value) return "Unknown";
  const parsed = parseCalendarDate(value);
  if (!parsed) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatMovementWindow(start: string | null | undefined, end: string | null | undefined) {
  if (start && end) {
    return `${formatScheduleTime(start)} to ${formatScheduleTime(end)}`;
  }
  if (start) {
    return `Started ${formatScheduleTime(start)}`;
  }
  if (end) {
    return `Ended ${formatScheduleTime(end)}`;
  }
  return "No commute markers";
}

function workoutToMapEntry(workout: {
  route_points: Array<{
    timestamp: string;
    latitude: number;
    longitude: number;
  }>;
}) {
  return {
    route_points: workout.route_points.map((point) => ({
      timestamp: point.timestamp,
      latitude: point.latitude,
      longitude: point.longitude,
      horizontal_accuracy_m: null,
    })),
    visits: [],
  };
}

function normalizePlannedRoutePoints(
  points: Array<{ latitude: number; longitude: number }>
) {
  return points.filter(
    (point) =>
      Number.isFinite(point.latitude) &&
      Number.isFinite(point.longitude) &&
      Math.abs(point.latitude) <= 90 &&
      Math.abs(point.longitude) <= 180
  );
}

function buildTrailPlanningPrompt(trail: NearbyTrailItem) {
  const trailLength =
    trail.length_m && trail.length_m > 0
      ? `${formatDistanceMiles(trail.length_m / 1000, 1)} trail distance`
      : "unknown trail distance";
  const trailRef = trail.ref ? ` (${trail.ref})` : "";
  const operator = trail.operator ? ` Operated or maintained by ${trail.operator}.` : "";

  return `Plan a hike around ${trail.name}${trailRef}. Use it as the anchor outdoor excursion for the next few days. Consider drive time, prep time, water and gear, a realistic hiking window, and recovery afterward. Assume ${trailLength}.${operator}`;
}

function isLineStringGeometry(
  value: unknown
): value is { type: "LineString"; coordinates: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type?: unknown }).type === "LineString" &&
    "coordinates" in value &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  );
}

function getFeatureRouteName(
  feature: { properties?: { name?: string; title?: string } } | unknown,
  fallbackName: string
) {
  if (
    typeof feature === "object" &&
    feature !== null &&
    "properties" in feature &&
    typeof feature.properties === "object" &&
    feature.properties !== null
  ) {
    const properties = feature.properties as { name?: string; title?: string };
    return properties.name || properties.title || fallbackName;
  }

  return fallbackName;
}

function parseGeoJsonRoute(text: string, fallbackName: string): PlannedRouteOverlay | null {
  const parsed = JSON.parse(text) as
    | {
        type?: string;
        coordinates?: unknown;
        features?: Array<{
          geometry?: {
            type?: string;
            coordinates?: unknown;
          };
          properties?: {
            name?: string;
            title?: string;
          };
        }>;
        properties?: {
          name?: string;
        };
      }
    | Array<unknown>;

  const candidateFeatures =
    Array.isArray(parsed)
      ? []
      : parsed.type === "FeatureCollection"
      ? parsed.features || []
      : parsed.type === "Feature"
      ? [parsed]
      : [parsed];

  for (const feature of candidateFeatures) {
    const geometry = "geometry" in feature ? feature.geometry : feature;
    if (!isLineStringGeometry(geometry)) {
      continue;
    }

    const points = normalizePlannedRoutePoints(
      geometry.coordinates
        .filter((coordinate): coordinate is [number, number] =>
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          typeof coordinate[0] === "number" &&
          typeof coordinate[1] === "number"
        )
        .map(([longitude, latitude]) => ({ latitude, longitude }))
    );

    if (points.length) {
      const featureName =
        getFeatureRouteName(feature, fallbackName) ||
        (!Array.isArray(parsed) && parsed.properties?.name) ||
        fallbackName;
      return {
        name: featureName || fallbackName,
        points,
      };
    }
  }

  return null;
}

function parseGpxRoute(text: string, fallbackName: string): PlannedRouteOverlay | null {
  if (typeof window === "undefined") {
    return null;
  }

  const xml = new window.DOMParser().parseFromString(text, "application/xml");
  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    return null;
  }

  const trackPoints = Array.from(xml.querySelectorAll("trkpt"))
    .map((node) => ({
      latitude: Number(node.getAttribute("lat")),
      longitude: Number(node.getAttribute("lon")),
    }))
    .filter(
      (point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    );

  if (!trackPoints.length) {
    return null;
  }

  const routeName =
    xml.querySelector("trk > name")?.textContent?.trim() ||
    xml.querySelector("rte > name")?.textContent?.trim() ||
    fallbackName;

  return {
    name: routeName,
    points: normalizePlannedRoutePoints(trackPoints),
  };
}

function workoutActivityLabelFromType(activityType: string | null | undefined) {
  const normalized = (activityType || "").trim();
  const rawMatch = normalized.match(/(\d+)/);
  const rawValue = rawMatch ? Number(rawMatch[1]) : Number(normalized);

  switch (rawValue) {
    case 9:
      return "Climbing";
    case 13:
      return "Cycling";
    case 16:
      return "Elliptical";
    case 20:
      return "Functional Strength";
    case 24:
      return "Hike";
    case 35:
      return "Rowing";
    case 37:
      return "Run";
    case 44:
    case 68:
    case 69:
      return "Stairs";
    case 46:
      return "Swim";
    case 50:
      return "Strength";
    case 52:
      return "Walk";
    case 57:
      return "Yoga";
    case 59:
      return "Core Training";
    case 63:
      return "HIIT";
    case 66:
      return "Pilates";
    case 73:
      return "Mixed Cardio";
    case 77:
      return "Dance";
    case 79:
      return "Pickleball";
    case 80:
      return "Cooldown";
    default:
      return null;
  }
}

function formatWorkoutLabel(label: string | null | undefined, activityType?: string | null, overrideLabel?: string | null) {
  if (overrideLabel?.trim()) return overrideLabel.trim();
  const normalized = (label || "").trim();
  if (normalized && !/^workout$/i.test(normalized) && !/^\(RawValue:\s*\d+\)$/i.test(normalized)) {
    return normalized;
  }

  const fallback = workoutActivityLabelFromType(activityType);
  if (fallback) return fallback;
  return "Workout";
}

function formatTimeOnly(value: string | null | undefined) {
  if (!value) return null;
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function minutesBetween(start: string | null | undefined, end: string | null | undefined) {
  const startDate = parseCalendarDate(start);
  const endDate = parseCalendarDate(end);
  if (!startDate || !endDate) return null;
  const minutes = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
  return Number.isFinite(minutes) ? minutes : null;
}

function formatMovementVisitTitle(
  visit: { label?: string | null; arrival?: string | null; departure?: string | null },
  index: number
) {
  if (visit.label?.trim()) return visit.label.trim();
  if (visit.arrival && !visit.departure) return `Arrival ${index + 1}`;
  if (visit.departure && !visit.arrival) return `Departure ${index + 1}`;
  if (visit.arrival && visit.departure) return `Place ${index + 1}`;
  return `Visit ${index + 1}`;
}

function buildMovementStoryboard(entry: MovementDailyEntry) {
  const items = entry.visits
    .map((visit, index) => {
      const arrivalText = formatTimeOnly(visit.arrival);
      const departureText = formatTimeOnly(visit.departure);
      const stayMinutes = minutesBetween(visit.arrival, visit.departure);
      const title = formatMovementVisitTitle(visit, index);
      let detail = "Visit detected";
      if (arrivalText && departureText) {
        detail = `${arrivalText} to ${departureText}`;
      } else if (arrivalText) {
        detail = `Arrived ${arrivalText}`;
      } else if (departureText) {
        detail = `Departed ${departureText}`;
      }

      const meta = stayMinutes ? `${formatMinutes(stayMinutes)} there` : null;
      return {
        id: `${visit.latitude}-${visit.longitude}-${visit.arrival ?? visit.departure ?? index}`,
        title,
        detail,
        meta,
      };
    });

  if (entry.commute_start || entry.commute_end) {
    items.unshift({
      id: "commute-window",
      title: "Commute window",
      detail: formatMovementWindow(entry.commute_start, entry.commute_end),
      meta: null,
    });
  }

  return items;
}

function formatScheduleTimeRange(item: {
  start: string;
  end?: string | null;
  is_all_day?: boolean;
}) {
  if (item.is_all_day) {
    return "All day";
  }

  const start = parseCalendarDate(item.start);
  if (!start) return item.start;

  const end = parseCalendarDate(item.end);
  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const startLabel = timeFormatter.format(start);

  if (!end) {
    return startLabel;
  }

  return `${startLabel} - ${timeFormatter.format(end)}`;
}

function buildAgendaDayGroups(items: CalendarAgendaItem[]): AgendaDayGroup[] {
  const groups = new Map<string, AgendaDayGroup>();

  for (const item of items) {
    const parsed = parseCalendarDate(item.start);
    const key = parsed ? formatLocalDateKey(parsed) : item.start;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label: formatScheduleDayLabel(item.start),
      items: [item],
    });
  }

  return Array.from(groups.values());
}

function buildPlanningDayGroups(items: PlanningItem[]): Array<{
  key: string;
  label: string;
  items: PlanningItem[];
}> {
  const groups = new Map<string, { key: string; label: string; items: PlanningItem[] }>();

  for (const item of items) {
    const parsed = parseCalendarDate(item.start);
    const key = parsed ? formatLocalDateKey(parsed) : item.day_label;
    const label = parsed ? formatScheduleDayLabel(item.start) : item.day_label;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    groups.set(key, {
      key,
      label,
      items: [item],
    });
  }

  return Array.from(groups.values());
}

type GmailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  messages_total: number;
  messages_unread: number;
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

type EmailUpdateResponse = {
  email: Email;
};

type ClassifiedEmailResponse = {
  email: Email;
  classification: Classification;
};

type CalendarPreview = {
  message_id: string;
  thread_id: string;
  relevant: boolean;
  title?: string | null;
  start?: string | null;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  notes?: string | null;
  reason?: string | null;
};

type CalendarCreateResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  preview: CalendarPreview;
};

type CalendarQuickAddResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  title?: string | null;
  start?: string | null;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  notes?: string | null;
  source_text: string;
};

type CalendarAgendaItem = {
  event_id: string;
  title: string;
  start: string;
  end?: string | null;
  is_all_day: boolean;
  location?: string | null;
  description?: string | null;
  html_link?: string | null;
  removed?: boolean;
};

type CalendarAgenda = {
  calendar_id: string;
  time_min: string;
  time_max: string;
  items: CalendarAgendaItem[];
};

type DashboardMailItem = {
  message_id: string;
  subject: string;
  sender: string;
  summary: string;
  why_it_matters: string;
  urgency: "low" | "medium" | "high";
  needs_reply: boolean;
  deadline_hint?: string | null;
  action_items: string[];
};

type DashboardNewsItem = {
  title: string;
  source?: string | null;
  link?: string | null;
  published_at?: string | null;
};

type DashboardTaskItem = {
  id: string;
  title: string;
  detail?: string | null;
  due_text?: string | null;
  source: "mail" | "calendar" | "news" | "planning" | "custom";
  priority: "high" | "medium" | "low";
  related_message_id?: string | null;
  related_event_id?: string | null;
  completed: boolean;
  updated_at?: string | null;
  custom: boolean;
};

type HealthDailyEntry = {
  date: string;
  source: string;
  steps: number;
  active_energy_kcal?: number | null;
  sleep_hours?: number | null;
  workouts: number;
  resting_heart_rate?: number | null;
  extra_metrics: Record<string, number | string | null>;
  synced_at?: string | null;
};

type DashboardHealthSummary = {
  latest_date?: string | null;
  last_synced_at?: string | null;
  today_entry?: HealthDailyEntry | null;
  recent_entries: HealthDailyEntry[];
  seven_day_avg_steps?: number | null;
  seven_day_avg_sleep_hours?: number | null;
  streak_days: number;
};

type HealthListResponse = {
  entries: HealthDailyEntry[];
};

type MovementVisit = {
  arrival?: string | null;
  departure?: string | null;
  latitude: number;
  longitude: number;
  horizontal_accuracy_m?: number | null;
  label?: string | null;
};

type MovementRoutePoint = {
  timestamp: string;
  latitude: number;
  longitude: number;
  horizontal_accuracy_m?: number | null;
};

type MovementDailyEntry = {
  date: string;
  source: string;
  total_distance_km: number;
  time_away_minutes?: number | null;
  visited_places_count: number;
  movement_story: string;
  home_label?: string | null;
  commute_start?: string | null;
  commute_end?: string | null;
  visits: MovementVisit[];
  route_points: MovementRoutePoint[];
  place_labels: string[];
  synced_at?: string | null;
};

type MovementListResponse = {
  entries: MovementDailyEntry[];
};

type WorkoutRoutePoint = {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude_m?: number | null;
  horizontal_accuracy_m?: number | null;
  vertical_accuracy_m?: number | null;
};

type WorkoutSetEntry = { exercise: string; sets: string; reps: string; weight: string; notes: string };

type WorkoutEntry = {
  workout_id: string;
  date: string;
  source: string;
  activity_type: string;
  activity_label: string;
  override_label?: string | null;
  exercise_log: WorkoutSetEntry[];
  start_date: string;
  end_date: string;
  duration_minutes: number;
  total_distance_km?: number | null;
  active_energy_kcal?: number | null;
  avg_heart_rate_bpm?: number | null;
  max_heart_rate_bpm?: number | null;
  source_name?: string | null;
  route_points: WorkoutRoutePoint[];
  synced_at?: string | null;
};

type WorkoutListResponse = {
  workouts: WorkoutEntry[];
};

type DashboardResponse = {
  generated_at: string;
  date_label: string;
  overview: string;
  mail_summary: string;
  news_summary: string;
  tasks_summary: string;
  health_summary?: DashboardHealthSummary | null;
  calendar_items: CalendarAgendaItem[];
  important_emails: DashboardMailItem[];
  news_items: DashboardNewsItem[];
  tasks: DashboardTaskItem[];
  google_error?: string | null;
};

const WORKOUT_PLAN = {
  profile: { age: 22, height: "5'8\"", weight: "140 lbs", goal: "Lean bulk — bigger chest and abs", bodyFat: "5.8%", skeletalMuscle: "71.7 lbs" },
  schedule: [
    { day: "Monday", label: "Chest + Triceps", color: "blue" as const, exercises: [
      { name: "Push-ups (weighted or elevated)", sets: 4, reps: "12" },
      { name: "Dumbbell bench press", sets: 4, reps: "10" },
      { name: "Incline dumbbell press", sets: 3, reps: "10" },
      { name: "Cable flyes or dumbbell flyes", sets: 3, reps: "12" },
      { name: "Tricep dips", sets: 3, reps: "12" },
      { name: "Overhead tricep extension", sets: 3, reps: "12" },
    ]},
    { day: "Tuesday", label: "Rock Climbing", color: "emerald" as const, notes: "30 min climbing session · After: 10 min core work (planks, hollow holds, leg raises)" },
    { day: "Wednesday", label: "Handstand + Shoulders", color: "violet" as const, exercises: [
      { name: "Frog pose holds", sets: 5, reps: "30 sec" },
      { name: "Pike push-ups", sets: 4, reps: "10" },
      { name: "Wall handstand holds", sets: 5, reps: "20–30 sec" },
      { name: "Dumbbell shoulder press", sets: 3, reps: "10" },
      { name: "Lateral raises", sets: 3, reps: "15" },
    ]},
    { day: "Thursday", label: "Back + Biceps", color: "cyan" as const, exercises: [
      { name: "Pull-ups or assisted pull-ups", sets: 4, reps: "8" },
      { name: "Dumbbell rows (each side)", sets: 4, reps: "10" },
      { name: "Face pulls", sets: 3, reps: "15" },
      { name: "Bicep curls", sets: 3, reps: "12" },
      { name: "Hammer curls", sets: 3, reps: "12" },
    ]},
    { day: "Friday", label: "Rock Climbing", color: "emerald" as const, notes: "30 min climbing session · After: light stretching + hip flexor work for frog pose" },
    { day: "Saturday", label: "Legs + Abs", color: "amber" as const, exercises: [
      { name: "Squats", sets: 4, reps: "10" },
      { name: "Romanian deadlifts", sets: 3, reps: "10" },
      { name: "Lunges (each leg)", sets: 3, reps: "12" },
      { name: "Plank", sets: 3, reps: "60 sec" },
      { name: "Hollow body hold", sets: 3, reps: "30 sec" },
      { name: "Ab wheel or hanging leg raises", sets: 3, reps: "12" },
    ]},
    { day: "Sunday", label: "Rest", color: "slate" as const, notes: "Full rest or light walk · Focus on sleep (7–9 hrs) and hitting protein target" },
  ],
  goals: [
    "Weight: 140 → ~146 lbs",
    "Skeletal muscle mass: 71.7 → ~76 lbs",
    "Body fat: stay controlled under ~10%",
    "Handstand: frog pose → tuck hold → wall handstand",
  ],
  notes: [
    "Progressive overload: add reps or small weight every 1–2 weeks on main lifts",
    "Weigh in daily at same time (morning, before eating); use weekly average",
    "Face pulls on Thursday protect shoulder health given climbing volume",
    "Do not add heavy pulling work the day after a climbing session",
    "Retest InBody in ~12 weeks to track muscle vs fat changes",
  ],
} as const;

const PLAN_COLORS: Record<string, { border: string; bg: string; text: string; badge: string }> = {
  blue:   { border: "border-blue-300/16",   bg: "bg-[rgba(37,99,235,0.10)]",   text: "text-blue-200",   badge: "bg-blue-400/15 text-blue-200" },
  emerald:{ border: "border-emerald-300/16", bg: "bg-[rgba(16,185,129,0.10)]", text: "text-emerald-200", badge: "bg-emerald-400/15 text-emerald-200" },
  violet: { border: "border-violet-300/16",  bg: "bg-[rgba(139,92,246,0.10)]", text: "text-violet-200",  badge: "bg-violet-400/15 text-violet-200" },
  cyan:   { border: "border-cyan-300/16",    bg: "bg-[rgba(6,182,212,0.10)]",  text: "text-cyan-200",   badge: "bg-cyan-400/15 text-cyan-200" },
  amber:  { border: "border-amber-300/16",   bg: "bg-[rgba(245,158,11,0.10)]", text: "text-amber-200",  badge: "bg-amber-400/15 text-amber-200" },
  slate:  { border: "border-white/8",        bg: "bg-[rgba(30,32,50,0.60)]",   text: "text-slate-300",  badge: "bg-white/8 text-slate-300" },
};

function HealthDetailPanel({
  dashboard,
  healthEntries,
  selectedHealthDate,
  onSelectedHealthDateChange,
  movementEntries,
  workoutEntries,
  movementLoading,
  loading,
  onBackToDashboard,
  onUseTrailForPlanner,
}: {
  dashboard: DashboardResponse | null;
  healthEntries: HealthDailyEntry[];
  selectedHealthDate: string | null;
  onSelectedHealthDateChange: (value: string) => void;
  movementEntries: MovementDailyEntry[];
  workoutEntries: WorkoutEntry[];
  movementLoading: boolean;
  loading: boolean;
  onBackToDashboard?: () => void;
  onUseTrailForPlanner?: (trail: NearbyTrailItem) => void;
}) {
  const healthSummary = dashboard?.health_summary ?? null;
  const [healthAtlasTab, setHealthAtlasTab] = useState<"overview" | "routes" | "nutrition" | "plan">("overview");

  // ── Nutrition state ──────────────────────────────────────────────────────────
  type FoodLogEntry = { id: string; date: string; name: string; calories: number; protein_g: number; carbs_g: number; fat_g: number; meal: string; logged_at: string };
  type ManualWorkoutLog = { id: string; date: string; type: string; duration_minutes: number; notes: string; logged_at: string };
  type MacroTargets = { calories: number; protein_g: number; carbs_g: number; fat_g: number };
  type DailyFoodLog = { date: string; entries: FoodLogEntry[]; manual_workout: ManualWorkoutLog | null; targets: MacroTargets };
  type MealPrepItem = { id: string; name: string; calories: number; protein_g: number; carbs_g: number; fat_g: number; notes: string; created_at: string };

  const [nutritionTab, setNutritionTab] = useState<"today" | "log" | "meal-prep" | "history">("today");
  const [foodLog, setFoodLog] = useState<DailyFoodLog | null>(null);
  const [mealPrepItems, setMealPrepItems] = useState<MealPrepItem[]>([]);
  const [foodLogHistory, setFoodLogHistory] = useState<DailyFoodLog[]>([]);
  const [nutritionLoading, setNutritionLoading] = useState(false);
  const [nutritionError, setNutritionError] = useState("");
  type CoachMsg = { role: "user" | "assistant"; content: string };
  const [coachingMessages, setCoachingMessages] = useState<CoachMsg[]>([]);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [coachingInput, setCoachingInput] = useState("");
  const [coachingChatId, setCoachingChatId] = useState<string | null>(null);
  // food form
  const [fName, setFName] = useState(""); const [fCal, setFCal] = useState(""); const [fPro, setFPro] = useState(""); const [fCarb, setFCarb] = useState(""); const [fFat, setFFat] = useState(""); const [fMeal, setFMeal] = useState("Other");
  // AI parse
  const [aiParseText, setAiParseText] = useState(""); const [aiParsing, setAiParsing] = useState(false);
  // inline edit
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", cal: "", pro: "", carb: "", fat: "", meal: "Other" });
  // workout form
  const [wType, setWType] = useState("Chest + triceps"); const [wDur, setWDur] = useState(""); const [wNotes, setWNotes] = useState("");
  const [editingWorkout, setEditingWorkout] = useState(false);
  const [labelingWorkoutId, setLabelingWorkoutId] = useState<string | null>(null);
  const [workoutLabelOverrides, setWorkoutLabelOverrides] = useState<Record<string, string | null>>({});
  const [loggingExercisesId, setLoggingExercisesId] = useState<string | null>(null);
  const [exerciseDrafts, setExerciseDrafts] = useState<WorkoutSetEntry[]>([]);
  const [exerciseSaving, setExerciseSaving] = useState(false);
  const [exerciseLogOverrides, setExerciseLogOverrides] = useState<Record<string, WorkoutSetEntry[]>>({});
  // meal prep form
  const [mpName, setMpName] = useState(""); const [mpCal, setMpCal] = useState(""); const [mpPro, setMpPro] = useState(""); const [mpCarb, setMpCarb] = useState(""); const [mpFat, setMpFat] = useState(""); const [mpNotes, setMpNotes] = useState("");

  const loadFoodLog = async (date: string) => {
    setNutritionLoading(true); setNutritionError("");
    setFoodLog(null);
    try {
      const res = await fetch(`${API_BASE}/nutrition/log/${date}`);
      if (!res.ok) throw new Error(`${res.status}`);
      setFoodLog(await res.json());
    } catch { setNutritionError("Failed to load food log."); }
    finally { setNutritionLoading(false); }
  };

  const loadMealPrep = async () => {
    try { const res = await fetch(`${API_BASE}/nutrition/meal-prep`); if (res.ok) setMealPrepItems(await res.json()); } catch { /* silent */ }
  };

  const loadHistory = async () => {
    try { const res = await fetch(`${API_BASE}/nutrition/history?days=14`); if (res.ok) { const d = await res.json(); setFoodLogHistory(d.days ?? []); } } catch { /* silent */ }
  };

  const addFood = async () => {
    if (!fName.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fName, calories: parseFloat(fCal)||0, protein_g: parseFloat(fPro)||0, carbs_g: parseFloat(fCarb)||0, fat_g: parseFloat(fFat)||0, meal: fMeal }) });
      if (res.ok) { setFName(""); setFCal(""); setFPro(""); setFCarb(""); setFFat(""); await loadFoodLog(activeHealthDate); }
    } catch { /* silent */ }
  };

  const deleteFood = async (id: string) => {
    try { await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/entries/${id}`, { method: "DELETE" }); await loadFoodLog(activeHealthDate); } catch { /* silent */ }
  };

  const startEdit = (f: FoodLogEntry) => {
    setEditingEntryId(f.id);
    setEditForm({ name: f.name, cal: String(f.calories), pro: String(f.protein_g), carb: String(f.carbs_g), fat: String(f.fat_g), meal: f.meal });
  };

  const saveEdit = async () => {
    if (!editingEntryId) return;
    try {
      const res = await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/entries/${editingEntryId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editForm.name, calories: parseFloat(editForm.cal)||0, protein_g: parseFloat(editForm.pro)||0, carbs_g: parseFloat(editForm.carb)||0, fat_g: parseFloat(editForm.fat)||0, meal: editForm.meal }),
      });
      if (res.ok) { setEditingEntryId(null); await loadFoodLog(activeHealthDate); }
    } catch { /* silent */ }
  };

  const parseFood = async () => {
    if (!aiParseText.trim()) return;
    setAiParsing(true);
    try {
      const res = await fetch(`${API_BASE}/nutrition/parse-food`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: aiParseText }) });
      if (res.ok) {
        const d = await res.json();
        setFName(d.name ?? ""); setFCal(String(d.calories ?? "")); setFPro(String(d.protein_g ?? "")); setFCarb(String(d.carbs_g ?? "")); setFFat(String(d.fat_g ?? "")); setFMeal(d.meal ?? "Other");
        setAiParseText("");
      }
    } catch { /* silent */ }
    finally { setAiParsing(false); }
  };

  const logWorkout = async () => {
    try {
      const res = await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/workout`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: wType, duration_minutes: parseInt(wDur)||0, notes: wNotes }) });
      if (res.ok) { setWDur(""); setWNotes(""); setEditingWorkout(false); await loadFoodLog(activeHealthDate); }
    } catch { /* silent */ }
  };

  const deleteWorkout = async () => {
    try { await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/workout`, { method: "DELETE" }); await loadFoodLog(activeHealthDate); } catch { /* silent */ }
  };

  const setWorkoutLabel = async (workoutId: string, label: string | null) => {
    try {
      await fetch(`${API_BASE}/workouts/${workoutId}/label`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) });
      setWorkoutLabelOverrides(prev => ({ ...prev, [workoutId]: label }));
      setLabelingWorkoutId(null);
    } catch { /* silent */ }
  };

  const startEditWorkout = (w: { type: string; duration_minutes: number | null; notes: string | null }) => {
    setWType(w.type); setWDur(w.duration_minutes ? String(w.duration_minutes) : ""); setWNotes(w.notes ?? ""); setEditingWorkout(true);
  };

  const openExerciseLog = (w: WorkoutEntry) => {
    if (loggingExercisesId === w.workout_id) { setLoggingExercisesId(null); return; }
    const existing = exerciseLogOverrides[w.workout_id] ?? w.exercise_log;
    setExerciseDrafts(existing.length > 0 ? [...existing] : [{ exercise: "", sets: "", reps: "", weight: "", notes: "" }]);
    setLoggingExercisesId(w.workout_id);
  };

  const saveExerciseLog = async (workoutId: string) => {
    setExerciseSaving(true);
    try {
      const saved = exerciseDrafts.filter(e => e.exercise.trim());
      await fetch(`${API_BASE}/workouts/${workoutId}/exercises`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exercises: saved }) });
      setExerciseLogOverrides(prev => ({ ...prev, [workoutId]: saved }));
      setLoggingExercisesId(null);
    } catch { /* silent */ }
    finally { setExerciseSaving(false); }
  };

  const quickAdd = async (item: MealPrepItem) => {
    try {
      await fetch(`${API_BASE}/nutrition/log/${activeHealthDate}/entries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: item.name, calories: item.calories, protein_g: item.protein_g, carbs_g: item.carbs_g, fat_g: item.fat_g, meal: "Meal prep" }) });
      await loadFoodLog(activeHealthDate);
    } catch { /* silent */ }
  };

  const saveMealPrep = async () => {
    if (!mpName.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/nutrition/meal-prep`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mpName, calories: parseFloat(mpCal)||0, protein_g: parseFloat(mpPro)||0, carbs_g: parseFloat(mpCarb)||0, fat_g: parseFloat(mpFat)||0, notes: mpNotes }) });
      if (res.ok) { setMpName(""); setMpCal(""); setMpPro(""); setMpCarb(""); setMpFat(""); setMpNotes(""); await loadMealPrep(); }
    } catch { /* silent */ }
  };

  const deleteMealPrep = async (id: string) => {
    try { await fetch(`${API_BASE}/nutrition/meal-prep/${id}`, { method: "DELETE" }); await loadMealPrep(); } catch { /* silent */ }
  };

  const sendCoachingMessage = async () => {
    const text = coachingInput.trim();
    if (!text || coachingLoading) return;
    setCoachingInput("");
    setCoachingMessages(prev => [...prev, { role: "user", content: text }]);
    setCoachingLoading(true);
    try {
      const res = await fetch(`${API_BASE}/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text, chat_id: coachingChatId }) });
      if (res.ok) { const d = await res.json(); setCoachingChatId(d.chat_id ?? null); setCoachingMessages(prev => [...prev, { role: "assistant", content: d.answer || "" }]); }
    } catch { /* silent */ }
    finally { setCoachingLoading(false); }
  };

  const getNutritionFeedback = async () => {
    setCoachingLoading(true); setCoachingMessages([]); setCoachingChatId(null);
    try {
      const histRes = await fetch(`${API_BASE}/nutrition/history?days=3`);
      const histDays: DailyFoodLog[] = histRes.ok ? ((await histRes.json()).days ?? []) : [];

      // Always use the already-loaded foodLog for the active date — avoids server-side date
      // calculation mismatches where the history endpoint returns empty entries for "today".
      const days: DailyFoodLog[] = [
        ...(foodLog ? [foodLog] : []),
        ...histDays.filter(d => d.date !== activeHealthDate),
      ].sort((a, b) => b.date.localeCompare(a.date));

      const summariseDay = (day: DailyFoodLog) => {
        const tot = day.entries.reduce((a, f) => ({ cal: a.cal + f.calories, pro: a.pro + f.protein_g, carb: a.carb + f.carbs_g, fat: a.fat + f.fat_g }), { cal: 0, pro: 0, carb: 0, fat: 0 });
        const t = day.targets;
        const dateLabel = day.date === activeHealthDate ? `${day.date} (selected day)` : day.date;
        const entries = day.entries.length
          ? day.entries.map(f => `  - ${f.name} (${Math.round(f.calories)} cal, ${Math.round(f.protein_g)}g P, ${Math.round(f.carbs_g)}g C, ${Math.round(f.fat_g)}g F) — ${f.meal}`).join("\n")
          : "  Nothing logged";
        const workout = day.manual_workout
          ? `  Workout: ${day.manual_workout.type}${day.manual_workout.duration_minutes ? ` — ${day.manual_workout.duration_minutes} min` : ""}${day.manual_workout.notes ? ` (${day.manual_workout.notes})` : ""}`
          : "  No workout logged";
        return `${dateLabel}\n  Totals: ${Math.round(tot.cal)}/${t.calories} cal · ${Math.round(tot.pro)}/${t.protein_g}g P · ${Math.round(tot.carb)}/${t.carbs_g}g C · ${Math.round(tot.fat)}/${t.fat_g}g F\n${entries}\n${workout}`;
      };

      const dayBlock = days.map(summariseDay).join("\n\n");

      const recentWatchWorkouts = workoutEntries.slice(0, 6).map(w =>
        `- ${w.activity_label}: ${Math.round(w.duration_minutes)} min${w.active_energy_kcal ? `, ${Math.round(w.active_energy_kcal)} cal burned` : ""}${w.avg_heart_rate_bpm ? `, avg ${Math.round(w.avg_heart_rate_bpm)} bpm` : ""}`
      ).join("\n");

      const question = `Here's my nutrition and training data for the last ${days.length} day(s):\n\n${dayBlock}${recentWatchWorkouts ? `\n\nRecent Apple Watch workouts (for training load context):\n${recentWatchWorkouts}` : ""}\n\nGive me specific, actionable coaching feedback. Look for patterns across the days — what I'm doing consistently well, where I'm falling short of targets, and give me 2-3 concrete things to focus on tomorrow. Be direct and practical.`;

      const res = await fetch(`${API_BASE}/assistant/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      if (res.ok) { const d = await res.json(); setCoachingChatId(d.chat_id ?? null); setCoachingMessages([{ role: "assistant", content: d.answer || "" }]); }
    } catch { /* silent */ }
    finally { setCoachingLoading(false); }
  };

  const [expandedMetricsOpen, setExpandedMetricsOpen] = useState(false);
  const latestHealthDate = healthEntries[0]?.date ?? healthSummary?.today_entry?.date ?? formatLocalDateKey(new Date());
  const earliestHealthDate = healthEntries[healthEntries.length - 1]?.date ?? latestHealthDate;
  const activeHealthDate = selectedHealthDate ?? latestHealthDate;

  useEffect(() => {
    if (healthAtlasTab === "nutrition") void loadFoodLog(activeHealthDate);
    setCoachingMessages([]); setCoachingChatId(null); setCoachingInput("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHealthDate, healthAtlasTab]);

  const selectedHealthEntry = healthEntries.find((entry) => entry.date === activeHealthDate)
    ?? (healthSummary?.today_entry?.date === activeHealthDate ? healthSummary.today_entry : null);
  const selectedMovementEntry = movementEntries.find((entry) => entry.date === activeHealthDate) ?? null;
  const selectedWorkoutEntries = workoutEntries.filter((workout) => {
    const parsed = parseCalendarDate(workout.start_date);
    return parsed ? formatLocalDateKey(parsed) === activeHealthDate : false;
  });
  const movementStoryboard = selectedMovementEntry ? buildMovementStoryboard(selectedMovementEntry) : [];
  const mappedWorkouts = selectedWorkoutEntries.filter((workout) => workout.route_points.length > 1).slice(0, 2);
  const featuredWorkout = selectedWorkoutEntries[0] ?? null;
  const hasMovementMap = Boolean(
    selectedMovementEntry && (selectedMovementEntry.route_points.length || selectedMovementEntry.visits.length)
  );

  return (
    <div className="space-y-6">
      <Card className="overflow-hidden rounded-[2rem] border border-white/8 bg-[linear-gradient(180deg,rgba(19,24,42,0.94),rgba(13,15,28,0.94))] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-4">
            <CardTitle className="text-xl text-white">Health</CardTitle>
            {onBackToDashboard ? (
              <Button variant="outline" className="rounded-2xl" onClick={onBackToDashboard}>
                Back to dashboard
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-3 rounded-[1.4rem] border border-white/8 bg-white/5 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Selected day</div>
              <div className="mt-1 text-base font-semibold text-white">{formatSelectedDayLabel(activeHealthDate)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => onSelectedHealthDateChange(shiftLocalDateKey(activeHealthDate, -1))}
                disabled={activeHealthDate <= earliestHealthDate}
              >
                <ChevronLeft className="mr-2 h-4 w-4" />
                Previous day
              </Button>
              <input
                type="date"
                value={activeHealthDate}
                min={earliestHealthDate}
                max={latestHealthDate}
                onChange={(event) => onSelectedHealthDateChange(event.target.value)}
                className="h-10 rounded-2xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/40"
              />
              <Button
                variant="outline"
                className="rounded-2xl"
                onClick={() => onSelectedHealthDateChange(shiftLocalDateKey(activeHealthDate, 1))}
                disabled={activeHealthDate >= latestHealthDate}
              >
                Next day
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setHealthAtlasTab("overview")}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "overview"
                  ? "border-cyan-300/25 bg-cyan-400/12 text-cyan-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Body
            </button>
            <button
              type="button"
              onClick={() => { setHealthAtlasTab("routes"); void loadFoodLog(activeHealthDate); }}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "routes"
                  ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Activity
            </button>
            <button
              type="button"
              onClick={() => { setHealthAtlasTab("nutrition"); void loadMealPrep(); }}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "nutrition"
                  ? "border-orange-300/25 bg-orange-400/12 text-orange-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Nutrition
            </button>
            <button
              type="button"
              onClick={() => setHealthAtlasTab("plan")}
              className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${
                healthAtlasTab === "plan"
                  ? "border-violet-300/25 bg-violet-400/12 text-violet-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              Plan
            </button>
          </div>
        </CardHeader>
        <CardContent>

          {/* ── BODY TAB ── */}
          {healthAtlasTab === "overview" && (
            selectedHealthEntry ? (
              <div className="space-y-5">
                {healthSummary ? (
                  <div className="grid gap-3 xl:grid-cols-[1.35fr_0.85fr_0.85fr_0.95fr]">
                    <div className="rounded-[1.6rem] border border-cyan-300/16 bg-[linear-gradient(135deg,rgba(37,99,235,0.16),rgba(17,19,34,0.64))] p-5">
                      <div className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">Steps</div>
                      <div className="mt-3 text-3xl font-semibold text-white">
                        {formatHealthStat(selectedHealthEntry?.steps)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-cyan-100">
                        <span className="rounded-full border border-cyan-300/25 bg-black/10 px-3 py-1">
                          7-day avg {formatHealthStat(healthSummary.seven_day_avg_steps)}
                        </span>
                        <span className="rounded-full border border-cyan-300/25 bg-black/10 px-3 py-1">
                          {healthSummary.streak_days} day streak
                        </span>
                      </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Active energy</div>
                      <div className="mt-2 text-2xl font-semibold text-white">
                        {formatHealthStat(selectedHealthEntry?.active_energy_kcal)} Cal
                      </div>
                      <div className="mt-2 text-xs text-slate-400">
                        {healthSummary.streak_days} day streak
                      </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Sleep average</div>
                      <div className="mt-2 text-2xl font-semibold text-white">
                        {formatHealthStat(healthSummary.seven_day_avg_sleep_hours, 1)} hr
                      </div>
                      <div className="mt-2 text-xs text-slate-400">
                        7-day average
                      </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">Resting heart rate</div>
                      <div className="mt-2 text-2xl font-semibold text-white">
                        {formatHealthStat(selectedHealthEntry?.resting_heart_rate)} bpm
                      </div>
                      <div className="mt-2 text-xs text-slate-400">
                        Synced {healthSummary.last_synced_at ? formatScheduleDateTime(healthSummary.last_synced_at) : "unknown"}
                      </div>
                    </div>
                  </div>
                ) : null}

                {healthSummary ? (
                  <div className="flex flex-wrap gap-2">
                    {healthSummary.latest_date ? (
                      <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-100">
                        Latest data {healthSummary.latest_date}
                      </span>
                    ) : null}
                    <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-100">
                      {healthSummary.recent_entries.length} synced day{healthSummary.recent_entries.length === 1 ? "" : "s"}
                    </span>
                  </div>
                ) : null}

                {selectedHealthEntry?.extra_metrics &&
                Object.keys(selectedHealthEntry.extra_metrics).length ? (
                  <div className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <button
                      type="button"
                      onClick={() => setExpandedMetricsOpen((current) => !current)}
                      className="flex w-full items-center justify-between gap-3 text-left"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">Expanded metrics</div>
                      <span className="text-xs text-cyan-200">{expandedMetricsOpen ? "Hide" : "Show"}</span>
                    </button>
                    {expandedMetricsOpen ? (
                      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                        {Object.entries(selectedHealthEntry.extra_metrics)
                          .filter(([, value]) => value !== null && value !== undefined)
                          .map(([key, value]) => (
                            <div key={key} className="rounded-[1rem] border border-white/6 bg-[rgba(17,19,34,0.45)] px-3 py-2">
                              <div className="text-xs uppercase tracking-wide text-slate-400">{healthMetricLabel(key)}</div>
                              <div className="mt-1 text-sm font-medium text-slate-100">{formatHealthMetricValue(key, value)}</div>
                            </div>
                          ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                {loading ? "Loading health data…" : "No Apple Health data synced yet. Use the iPhone app to send data into Jarvis."}
              </div>
            )
          )}

          {/* ── ACTIVITY TAB ── */}
          {healthAtlasTab === "routes" && (
            <div className="space-y-5">
              {/* Manual workout */}
              <div className="rounded-[1.5rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-5">
                <div className="mb-3 text-xs uppercase tracking-[0.2em] text-slate-400">Logged workout — {activeHealthDate}</div>
                {nutritionLoading ? (
                  <div className="text-sm text-slate-400">Loading…</div>
                ) : foodLog?.manual_workout ? (
                  <div>
                    <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                      {foodLog.manual_workout.type}
                    </span>
                    {foodLog.manual_workout.duration_minutes ? (
                      <span className="ml-2 text-sm text-slate-400">{foodLog.manual_workout.duration_minutes} min</span>
                    ) : null}
                    {foodLog.manual_workout.notes ? (
                      <div className="mt-2 text-sm text-slate-300">{foodLog.manual_workout.notes}</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">
                    No workout logged for this day. Use <span className="text-slate-300">Nutrition → Log Food</span> to add one.
                  </div>
                )}
              </div>

              {/* HealthKit workouts */}
              {selectedWorkoutEntries.length > 0 && (
                <div className="space-y-3">
                  <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Apple Health workouts</div>
                  {selectedWorkoutEntries.map((workout) => (
                    <div key={workout.workout_id} className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                        <div>
                          <div className="text-sm font-medium text-slate-100">
                            {formatWorkoutLabel(workout.activity_label, workout.activity_type, workout.override_label)}
                          </div>
                          <div className="mt-1 text-xs text-slate-400">{formatScheduleDateTime(workout.start_date)}</div>
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-slate-300">
                          <span>{formatHealthStat(workout.duration_minutes, 0)} min</span>
                          <span>{formatDistanceMiles(workout.total_distance_km, 1)}</span>
                          <span>{formatHealthStat(workout.active_energy_kcal)} Cal</span>
                          <span>{formatHealthStat(workout.avg_heart_rate_bpm)} avg bpm</span>
                        </div>
                      </div>
                      {workout.route_points.length > 1 && (
                        <div className="mt-3 overflow-hidden rounded-[1.2rem] border border-white/8">
                          <MovementMap entry={workoutToMapEntry(workout)} className="h-[280px]" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Movement journal */}
              {selectedMovementEntry ? (
                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-emerald-300/15 bg-[linear-gradient(135deg,rgba(16,185,129,0.16),rgba(14,18,30,0.92))] p-5">
                    <div className="text-xs uppercase tracking-[0.22em] text-emerald-100/80">Movement story</div>
                    <div className="mt-3 text-lg font-semibold text-white">
                      {formatMovementStoryText(selectedMovementEntry.movement_story, { selectedDate: activeHealthDate })}
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Distance</div>
                        <div className="mt-1 text-xl font-semibold text-white">{formatDistanceMiles(selectedMovementEntry.total_distance_km, 1)}</div>
                      </div>
                      <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Away from home</div>
                        <div className="mt-1 text-xl font-semibold text-white">{formatMinutes(selectedMovementEntry.time_away_minutes)}</div>
                      </div>
                      <div className="rounded-[1.1rem] border border-white/8 bg-black/10 px-4 py-3">
                        <div className="text-[11px] uppercase tracking-[0.18em] text-slate-300">Visited places</div>
                        <div className="mt-1 text-xl font-semibold text-white">{selectedMovementEntry.visited_places_count}</div>
                      </div>
                    </div>
                  </div>

                  {hasMovementMap ? (
                    <div className="overflow-hidden rounded-[1.3rem] border border-white/6 bg-[rgba(17,19,34,0.45)]">
                      <MovementMap entry={selectedMovementEntry} className="h-[440px] xl:h-[500px]" />
                      <div className="flex flex-wrap gap-2 px-4 py-3 text-xs text-slate-300">
                        <span className="rounded-full border border-emerald-300/20 bg-emerald-400/10 px-3 py-1">Start</span>
                        <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1">End</span>
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">{selectedMovementEntry.place_labels.length} labeled places</span>
                      </div>
                    </div>
                  ) : null}

                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {[
                      { label: "Travel", val: formatDistanceMiles(selectedMovementEntry.total_distance_km, 1), sub: `${selectedMovementEntry.route_points.length} route points` },
                      { label: "Away time", val: formatMinutes(selectedMovementEntry.time_away_minutes), sub: `${selectedMovementEntry.visited_places_count} visit event${selectedMovementEntry.visited_places_count === 1 ? "" : "s"}` },
                      { label: "Commute window", val: formatMovementWindow(selectedMovementEntry.commute_start, selectedMovementEntry.commute_end), sub: selectedMovementEntry.synced_at ? `Synced ${formatScheduleDateTime(selectedMovementEntry.synced_at)}` : "" },
                      { label: "Places", val: String(selectedMovementEntry.place_labels.length), sub: "labels captured" },
                    ].map(({ label, val, sub }) => (
                      <div key={label} className="rounded-[1.2rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
                        <div className="mt-2 text-xl font-semibold text-white">{val}</div>
                        <div className="mt-1 text-xs text-slate-400">{sub}</div>
                      </div>
                    ))}
                  </div>

                  {selectedMovementEntry.place_labels.length ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedMovementEntry.place_labels.map((label) => (
                        <span key={label} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">{label}</span>
                      ))}
                    </div>
                  ) : null}

                  <div className="rounded-[1.3rem] border border-white/6 bg-[rgba(17,19,34,0.45)] p-4">
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Movement storyboard</div>
                    <div className="space-y-3">
                      {movementStoryboard.length ? movementStoryboard.map((item, index) => (
                        <div key={`${item.id}-${index}`} className="flex gap-3 rounded-[1rem] border border-white/6 bg-[rgba(255,255,255,0.03)] px-4 py-3">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-400/15 text-xs font-semibold text-emerald-100">
                            {index + 1}
                          </div>
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-slate-100">{item.title}</div>
                            <div className="mt-1 text-sm text-slate-300">{item.detail}</div>
                            {item.meta ? <div className="mt-1 text-xs text-slate-500">{item.meta}</div> : null}
                          </div>
                        </div>
                      )) : (
                        <div className="rounded-[1rem] border border-dashed border-white/10 px-4 py-3 text-sm text-slate-400">
                          No movement storyboard yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ) : !featuredWorkout && !foodLog?.manual_workout && !nutritionLoading ? (
                <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                  {movementLoading ? "Loading activity data…" : "No activity data for this day. Log a workout in the Nutrition tab, or sync Apple Health workouts via the iPhone app."}
                </div>
              ) : null}
            </div>
          )}

          {/* ── NUTRITION TAB ── */}
          {healthAtlasTab === "nutrition" ? (
            <div className="space-y-4">
              {/* Sub-nav */}
              <div className="flex flex-wrap gap-2">
                {(["today", "log", "meal-prep", "history"] as const).map((t) => (
                  <button key={t} type="button"
                    onClick={() => { setNutritionTab(t); if (t === "history") void loadHistory(); if (t === "meal-prep") void loadMealPrep(); }}
                    className={`rounded-full border px-3 py-1.5 text-xs uppercase tracking-[0.18em] transition ${nutritionTab === t ? "border-orange-300/25 bg-orange-400/12 text-orange-100" : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"}`}
                  >
                    {t === "log" ? "Log Food" : t === "meal-prep" ? "Meal Prep" : t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>

              {nutritionError ? <div className="rounded-xl bg-red-500/10 px-4 py-2 text-sm text-red-300">{nutritionError}</div> : null}

              {/* TODAY TAB */}
              {nutritionTab === "today" && (() => {
                const t = foodLog?.targets ?? { calories: 2600, protein_g: 155, carbs_g: 320, fat_g: 75 };
                const totals = (foodLog?.entries ?? []).reduce((a, f) => ({ cal: a.cal + f.calories, pro: a.pro + f.protein_g, carb: a.carb + f.carbs_g, fat: a.fat + f.fat_g }), { cal: 0, pro: 0, carb: 0, fat: 0 });
                const pct = (v: number, max: number) => Math.min(100, Math.round((v / max) * 100));
                return (
                  <div className="space-y-4">
                    {nutritionLoading ? <div className="text-sm text-slate-400">Loading...</div> : null}
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                      {[
                        { label: "Calories", val: Math.round(totals.cal), target: t.calories, unit: "kcal", color: "text-blue-300" },
                        { label: "Protein", val: Math.round(totals.pro), target: t.protein_g, unit: "g", color: "text-emerald-300" },
                        { label: "Carbs", val: Math.round(totals.carb), target: t.carbs_g, unit: "g", color: "text-amber-300" },
                        { label: "Fat", val: Math.round(totals.fat), target: t.fat_g, unit: "g", color: "text-pink-300" },
                      ].map(({ label, val, target, unit, color }) => (
                        <div key={label} className="rounded-[1.2rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs text-slate-400">{label}</div>
                          <div className={`mt-1 text-2xl font-semibold ${color}`}>{val}<span className="ml-1 text-sm font-normal text-slate-400">{unit}</span></div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-current opacity-70 transition-all" style={{ width: `${pct(val, target)}%` }} /></div>
                          <div className="mt-1 text-xs text-slate-500">{pct(val, target)}% of {target}{unit}</div>
                        </div>
                      ))}
                    </div>

                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Food log — {activeHealthDate}</div>
                      {(foodLog?.entries ?? []).length === 0 ? (
                        <div className="text-sm text-slate-500">Nothing logged yet. Use the Log Food tab to add entries.</div>
                      ) : (
                        <div className="space-y-2">
                          {(foodLog?.entries ?? []).map((f) => (
                            <div key={f.id} className="rounded-xl border border-white/5 bg-white/3 px-4 py-2">
                              {editingEntryId === f.id ? (
                                <div className="space-y-2">
                                  <input value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} placeholder="Food name" className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                                  <div className="grid grid-cols-2 gap-2">
                                    {([["Cal", "cal"], ["Protein g", "pro"], ["Carbs g", "carb"], ["Fat g", "fat"]] as const).map(([label, key]) => (
                                      <input key={key} type="number" value={editForm[key]} onChange={e => setEditForm(p => ({ ...p, [key]: e.target.value }))} placeholder={label} min="0" className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                                    ))}
                                  </div>
                                  <select value={editForm.meal} onChange={e => setEditForm(p => ({ ...p, meal: e.target.value }))} className="w-full rounded-lg border border-white/10 bg-[rgba(20,22,37,0.88)] px-2 py-1.5 text-sm text-slate-100 outline-none">
                                    {["Breakfast","Lunch","Pre-workout","Dinner","Snack","Other"].map(m => <option key={m}>{m}</option>)}
                                  </select>
                                  <div className="flex gap-2">
                                    <button onClick={() => void saveEdit()} disabled={!editForm.name.trim()} className="flex-1 rounded-xl border border-orange-300/20 bg-orange-400/10 py-1.5 text-xs text-orange-200 hover:bg-orange-400/20 disabled:opacity-50">Save</button>
                                    <button onClick={() => setEditingEntryId(null)} className="flex-1 rounded-xl border border-white/10 bg-white/5 py-1.5 text-xs text-slate-400 hover:bg-white/10">Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-center justify-between gap-4">
                                  <div>
                                    <div className="text-sm text-slate-100">{f.name}</div>
                                    <div className="text-xs text-slate-500">{f.meal} · {Math.round(f.calories)} cal · {Math.round(f.protein_g)}g P · {Math.round(f.carbs_g)}g C · {Math.round(f.fat_g)}g F</div>
                                  </div>
                                  <div className="flex shrink-0 gap-2">
                                    <button onClick={() => startEdit(f)} className="text-slate-500 hover:text-slate-200" title="Edit">✎</button>
                                    <button onClick={() => void deleteFood(f.id)} className="text-slate-500 hover:text-red-400" title="Delete">✕</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Workout — {activeHealthDate}</div>
                      {selectedWorkoutEntries.length === 0 && !foodLog?.manual_workout ? (
                        <div className="text-sm text-slate-500">No workout logged. Use the Log Food tab to add one.</div>
                      ) : (
                        <div className="space-y-2">
                          {selectedWorkoutEntries.map((w) => {
                            const effectiveLabel = workoutLabelOverrides.hasOwnProperty(w.workout_id) ? workoutLabelOverrides[w.workout_id] : w.override_label;
                            const effectiveLog = exerciseLogOverrides[w.workout_id] ?? w.exercise_log;
                            const planDay = WORKOUT_PLAN.schedule.find(s => s.label === effectiveLabel);
                            const planExercises = planDay && "exercises" in planDay ? (planDay as unknown as { exercises: { name: string; sets: number; reps: string }[] }).exercises : null;
                            return (
                            <div key={w.workout_id} className="rounded-xl border border-white/5 bg-white/3 px-3 py-2">
                              <div className="flex items-center gap-3">
                                <span className="text-lg">⌚</span>
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm text-slate-100">{formatWorkoutLabel(w.activity_label, w.activity_type, effectiveLabel)}</div>
                                  <div className="text-xs text-slate-500">
                                    {Math.round(w.duration_minutes)} min
                                    {w.active_energy_kcal ? ` · ${Math.round(w.active_energy_kcal)} cal` : ""}
                                    {w.avg_heart_rate_bpm ? ` · ${Math.round(w.avg_heart_rate_bpm)} bpm avg` : ""}
                                    {w.total_distance_km ? ` · ${w.total_distance_km.toFixed(1)} km` : ""}
                                  </div>
                                </div>
                                <div className="flex shrink-0 gap-1.5">
                                  <button onClick={() => openExerciseLog(w)} className={`text-xs px-2 py-0.5 rounded-full border transition ${loggingExercisesId === w.workout_id ? "border-orange-300/30 bg-orange-400/15 text-orange-200" : effectiveLog.length > 0 ? "border-white/10 bg-white/6 text-slate-300 hover:bg-white/12" : "border-white/6 text-slate-500 hover:text-slate-300"}`} title="Log sets & reps">
                                    {effectiveLog.length > 0 ? `${effectiveLog.length} ex` : "+ sets"}
                                  </button>
                                  <button onClick={() => setLabelingWorkoutId(labelingWorkoutId === w.workout_id ? null : w.workout_id)} className="shrink-0 text-slate-500 hover:text-slate-200" title="Set plan label">🏷</button>
                                </div>
                              </div>

                              {/* Exercise log panel */}
                              {loggingExercisesId === w.workout_id && (
                                <div className="mt-2 space-y-2 border-t border-white/6 pt-2">
                                  {planExercises && exerciseDrafts.every(d => !d.exercise.trim()) && (
                                    <div className="flex flex-wrap gap-1.5">
                                      <span className="text-xs text-slate-500">From plan:</span>
                                      {planExercises.map(pe => (
                                        <button key={pe.name} onClick={() => setExerciseDrafts(prev => [...prev.filter(d => d.exercise.trim()), { exercise: pe.name, sets: String(pe.sets), reps: pe.reps, weight: "", notes: "" }])}
                                          className="rounded-full bg-white/6 px-2 py-0.5 text-xs text-slate-300 hover:bg-white/12">
                                          {pe.name}
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  <div className="space-y-1.5">
                                    {exerciseDrafts.map((row, i) => (
                                      <div key={i} className="grid grid-cols-[1fr_3rem_3rem_4rem_1.5rem] gap-1.5 items-center">
                                        <input value={row.exercise} onChange={e => setExerciseDrafts(prev => prev.map((r, j) => j === i ? { ...r, exercise: e.target.value } : r))}
                                          placeholder="Exercise" className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-orange-300/40" />
                                        <input value={row.sets} onChange={e => setExerciseDrafts(prev => prev.map((r, j) => j === i ? { ...r, sets: e.target.value } : r))}
                                          placeholder="Sets" className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-orange-300/40 text-center" />
                                        <input value={row.reps} onChange={e => setExerciseDrafts(prev => prev.map((r, j) => j === i ? { ...r, reps: e.target.value } : r))}
                                          placeholder="Reps" className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-orange-300/40 text-center" />
                                        <input value={row.weight} onChange={e => setExerciseDrafts(prev => prev.map((r, j) => j === i ? { ...r, weight: e.target.value } : r))}
                                          placeholder="Weight" className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-slate-100 outline-none focus:border-orange-300/40 text-center" />
                                        <button onClick={() => setExerciseDrafts(prev => prev.filter((_, j) => j !== i))} className="text-slate-600 hover:text-red-400 text-xs">✕</button>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="flex gap-2 pt-0.5">
                                    <button onClick={() => setExerciseDrafts(prev => [...prev, { exercise: "", sets: "", reps: "", weight: "", notes: "" }])}
                                      className="text-xs text-slate-500 hover:text-slate-300">+ add row</button>
                                    <div className="flex-1" />
                                    <button onClick={() => setLoggingExercisesId(null)} className="rounded-xl border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-400 hover:bg-white/10">Cancel</button>
                                    <button onClick={() => void saveExerciseLog(w.workout_id)} disabled={exerciseSaving}
                                      className="rounded-xl border border-orange-300/20 bg-orange-400/10 px-3 py-1 text-xs text-orange-200 hover:bg-orange-400/20 disabled:opacity-50">
                                      {exerciseSaving ? "Saving…" : "Save"}
                                    </button>
                                  </div>
                                  {/* Saved summary (when not editing) */}
                                </div>
                              )}

                              {/* Saved log preview when closed */}
                              {loggingExercisesId !== w.workout_id && effectiveLog.length > 0 && (
                                <div className="mt-1.5 space-y-0.5 border-t border-white/5 pt-1.5">
                                  {effectiveLog.map((e, i) => (
                                    <div key={i} className="flex gap-2 text-xs text-slate-500">
                                      <span className="flex-1 text-slate-400">{e.exercise}</span>
                                      {e.sets && <span>{e.sets}×{e.reps}</span>}
                                      {e.weight && <span>{e.weight}</span>}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {labelingWorkoutId === w.workout_id && (
                                <div className="mt-2 space-y-1.5 border-t border-white/6 pt-2">
                                  <div className="text-xs text-slate-500">Label as plan workout:</div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {WORKOUT_PLAN.schedule.filter(s => s.label !== "Rest").map(s => (
                                      <button key={s.label} onClick={() => void setWorkoutLabel(w.workout_id, s.label)}
                                        className={`rounded-full px-2.5 py-0.5 text-xs transition ${effectiveLabel === s.label ? "bg-orange-400/25 text-orange-200 ring-1 ring-orange-300/30" : "bg-white/6 text-slate-300 hover:bg-white/12"}`}>
                                        {s.label}
                                      </button>
                                    ))}
                                    {effectiveLabel && (
                                      <button onClick={() => void setWorkoutLabel(w.workout_id, null)} className="rounded-full bg-white/4 px-2.5 py-0.5 text-xs text-slate-500 hover:text-red-400">
                                        Clear label
                                      </button>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                            );
                          })}
                          {foodLog?.manual_workout && (
                            <div className="rounded-xl border border-white/5 bg-white/3 px-3 py-2">
                              {editingWorkout ? (
                                <div className="space-y-2">
                                  <select value={wType} onChange={e => setWType(e.target.value)} className="w-full rounded-lg border border-white/10 bg-[rgba(20,22,37,0.88)] px-2 py-1.5 text-sm text-slate-100 outline-none">
                                    {["Chest + triceps","Back + biceps","Legs","Shoulders","Full body","Cardio","Run","Swim","Yoga","Other"].map(t => <option key={t}>{t}</option>)}
                                  </select>
                                  <input type="number" value={wDur} onChange={e => setWDur(e.target.value)} placeholder="Duration (min)" min="0" className="w-full rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                                  <textarea value={wNotes} onChange={e => setWNotes(e.target.value)} placeholder="Notes..." rows={2} className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                                  <div className="flex gap-2">
                                    <button onClick={() => void logWorkout()} className="flex-1 rounded-xl border border-orange-300/20 bg-orange-400/10 py-1.5 text-xs text-orange-200 hover:bg-orange-400/20">Save</button>
                                    <button onClick={() => setEditingWorkout(false)} className="flex-1 rounded-xl border border-white/10 bg-white/5 py-1.5 text-xs text-slate-400 hover:bg-white/10">Cancel</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="flex items-start justify-between gap-4">
                                  <div>
                                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">{foodLog.manual_workout.type}</span>
                                    {foodLog.manual_workout.duration_minutes ? <span className="ml-2 text-xs text-slate-400">{foodLog.manual_workout.duration_minutes} min</span> : null}
                                    {foodLog.manual_workout.notes ? <div className="mt-1 text-xs text-slate-400">{foodLog.manual_workout.notes}</div> : null}
                                  </div>
                                  <div className="flex shrink-0 gap-2">
                                    <button onClick={() => startEditWorkout(foodLog.manual_workout!)} className="text-slate-500 hover:text-slate-200" title="Edit">✎</button>
                                    <button onClick={() => void deleteWorkout()} className="text-slate-500 hover:text-red-400" title="Delete">✕</button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="rounded-[1.4rem] border border-cyan-300/10 bg-[rgba(35,37,58,0.72)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-[0.18em] text-cyan-300/80">✦ Health coach</div>
                      {coachingMessages.length === 0 ? (
                        <div className="space-y-3">
                          <p className="text-xs text-slate-500">Analyzes the last 3 days of nutrition and recent workouts.</p>
                          <button onClick={() => void getNutritionFeedback()} disabled={coachingLoading}
                            className="rounded-2xl border border-cyan-300/20 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-200 transition hover:bg-cyan-400/20 disabled:opacity-50">
                            {coachingLoading ? "Getting feedback…" : "Get coaching feedback →"}
                          </button>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                            {coachingMessages.map((msg, i) => (
                              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${msg.role === "user" ? "bg-cyan-500/18 text-white" : "bg-white/6 text-slate-200"}`}>
                                  {msg.content}
                                </div>
                              </div>
                            ))}
                            {coachingLoading && (
                              <div className="flex justify-start">
                                <div className="flex items-center gap-1 rounded-2xl bg-white/6 px-4 py-3">
                                  {[0,1,2].map(i => <span key={i} className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-cyan-400/70" style={{ animationDelay: `${i * 0.15}s` }} />)}
                                </div>
                              </div>
                            )}
                          </div>
                          <div className="flex items-end gap-2 border-t border-white/6 pt-3">
                            <textarea
                              value={coachingInput}
                              onChange={e => setCoachingInput(e.target.value)}
                              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendCoachingMessage(); } }}
                              placeholder="Ask a follow-up…"
                              rows={1}
                              className="flex-1 resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-300/30"
                            />
                            <button onClick={() => void sendCoachingMessage()} disabled={!coachingInput.trim() || coachingLoading}
                              className="shrink-0 rounded-xl border border-cyan-300/20 bg-cyan-400/15 px-3 py-2 text-sm text-cyan-200 transition hover:bg-cyan-400/25 disabled:opacity-40">
                              ↑
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* LOG FOOD TAB */}
              {nutritionTab === "log" && (
                <div className="space-y-4">
                  <div className="rounded-[1.4rem] border border-cyan-300/12 bg-[linear-gradient(135deg,rgba(6,78,200,0.12),rgba(17,19,34,0.72))] p-4 space-y-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-cyan-200/80">AI parse</div>
                    <textarea
                      value={aiParseText}
                      onChange={e => setAiParseText(e.target.value)}
                      placeholder={'Describe what you ate… e.g. "2 scrambled eggs, toast with butter, and a glass of OJ"'}
                      rows={2}
                      className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-300/40"
                    />
                    <button onClick={() => void parseFood()} disabled={aiParsing || !aiParseText.trim()} className="w-full rounded-2xl border border-cyan-300/20 bg-cyan-400/10 py-2 text-sm text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50">
                      {aiParsing ? "Parsing…" : "Parse with AI → fills form below"}
                    </button>
                  </div>

                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 space-y-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Log custom food</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <input value={fName} onChange={e => setFName(e.target.value)} placeholder="Food name" className="col-span-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                      {[["Calories", fCal, setFCal], ["Protein (g)", fPro, setFPro], ["Carbs (g)", fCarb, setFCarb], ["Fat (g)", fFat, setFFat]].map(([label, val, setter]) => (
                        <input key={label as string} type="number" value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)} placeholder={label as string} min="0" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                      ))}
                      <select value={fMeal} onChange={e => setFMeal(e.target.value)} className="rounded-xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40">
                        {["Breakfast","Lunch","Pre-workout","Dinner","Snack","Other"].map(m => <option key={m}>{m}</option>)}
                      </select>
                    </div>
                    <button onClick={() => void addFood()} disabled={!fName.trim()} className="w-full rounded-2xl border border-orange-300/20 bg-orange-400/10 py-2 text-sm text-orange-200 hover:bg-orange-400/20 disabled:opacity-50">Log food</button>
                  </div>

                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 space-y-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Log workout</div>
                    <select value={wType} onChange={e => setWType(e.target.value)} className="w-full rounded-xl border border-white/10 bg-[rgba(20,22,37,0.88)] px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40">
                      {["Chest + triceps","Rock climbing","Handstand + shoulders","Back + biceps","Legs + abs","Rest day","Other"].map(t => <option key={t}>{t}</option>)}
                    </select>
                    <input type="number" value={wDur} onChange={e => setWDur(e.target.value)} placeholder="Duration (min)" min="0" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                    <textarea value={wNotes} onChange={e => setWNotes(e.target.value)} placeholder="Sets, reps, PRs, how it felt..." rows={3} className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                    <button onClick={() => void logWorkout()} className="w-full rounded-2xl border border-emerald-300/20 bg-emerald-400/10 py-2 text-sm text-emerald-200 hover:bg-emerald-400/20">Log workout</button>
                  </div>
                </div>
              )}

              {/* MEAL PREP TAB */}
              {nutritionTab === "meal-prep" && (
                <div className="space-y-4">
                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Quick add</div>
                    {mealPrepItems.length === 0 ? (
                      <div className="text-sm text-slate-500">No saved meal preps yet.</div>
                    ) : (
                      <div className="space-y-2">
                        {mealPrepItems.map((item) => (
                          <div key={item.id} className="flex items-center justify-between gap-4 rounded-xl border border-white/5 bg-white/3 px-4 py-2">
                            <div>
                              <div className="text-sm text-slate-100">{item.name}</div>
                              <div className="text-xs text-slate-500">{Math.round(item.calories)} cal · {Math.round(item.protein_g)}g P · {Math.round(item.carbs_g)}g C · {Math.round(item.fat_g)}g F</div>
                            </div>
                            <button onClick={() => void quickAdd(item)} className="rounded-xl border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200 hover:bg-cyan-400/20">Add</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                    <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Saved recipes</div>
                    {mealPrepItems.length === 0 ? (
                      <div className="text-sm text-slate-500">No saved meal preps yet.</div>
                    ) : (
                      <div className="space-y-2">
                        {mealPrepItems.map((item) => (
                          <div key={item.id} className="flex items-start justify-between gap-4 rounded-xl border border-white/5 bg-white/3 px-4 py-3">
                            <div>
                              <div className="text-sm font-medium text-slate-100">{item.name}</div>
                              <div className="mt-0.5 text-xs text-slate-500">{Math.round(item.calories)} cal · {Math.round(item.protein_g)}g P · {Math.round(item.carbs_g)}g C · {Math.round(item.fat_g)}g F</div>
                              {item.notes ? <div className="mt-1 text-xs text-slate-400">{item.notes}</div> : null}
                            </div>
                            <button onClick={() => void deleteMealPrep(item.id)} className="text-slate-500 hover:text-red-400">✕</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 space-y-3">
                    <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Save new recipe</div>
                    <input value={mpName} onChange={e => setMpName(e.target.value)} placeholder="Recipe name" className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                    <div className="grid gap-2 md:grid-cols-2">
                      {[["Calories", mpCal, setMpCal], ["Protein (g)", mpPro, setMpPro], ["Carbs (g)", mpCarb, setMpCarb], ["Fat (g)", mpFat, setMpFat]].map(([label, val, setter]) => (
                        <input key={label as string} type="number" value={val as string} onChange={e => (setter as (v: string) => void)(e.target.value)} placeholder={label as string} min="0" className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                      ))}
                    </div>
                    <textarea value={mpNotes} onChange={e => setMpNotes(e.target.value)} placeholder="Ingredients, prep notes, servings..." rows={2} className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 outline-none focus:border-orange-300/40" />
                    <button onClick={() => void saveMealPrep()} disabled={!mpName.trim()} className="w-full rounded-2xl border border-orange-300/20 bg-orange-400/10 py-2 text-sm text-orange-200 hover:bg-orange-400/20 disabled:opacity-50">Save to library</button>
                  </div>
                </div>
              )}

              {/* HISTORY TAB */}
              {nutritionTab === "history" && (
                <div className="space-y-3">
                  {foodLogHistory.length === 0 ? (
                    <div className="rounded-[1.4rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">No history yet — start logging to see trends.</div>
                  ) : foodLogHistory.filter(d => d.entries.length > 0 || d.manual_workout).map((day) => {
                    const totals = day.entries.reduce((a, f) => ({ cal: a.cal + f.calories, pro: a.pro + f.protein_g }), { cal: 0, pro: 0 });
                    const pctCal = Math.min(100, Math.round((totals.cal / day.targets.calories) * 100));
                    return (
                      <div key={day.date} className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] px-4 py-3">
                        <div className="flex items-center justify-between gap-4">
                          <div className="text-sm font-medium text-slate-100">{day.date}</div>
                          <div className="flex items-center gap-2">
                            {day.manual_workout ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">{day.manual_workout.type}</span> : null}
                            <span className="text-xs text-slate-400">{Math.round(totals.cal)} cal · {pctCal}% target</span>
                          </div>
                        </div>
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full rounded-full bg-blue-400/60 transition-all" style={{ width: `${pctCal}%` }} />
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{Math.round(totals.pro)}g protein · {day.entries.length} item{day.entries.length === 1 ? "" : "s"} logged</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}

          {/* ── PLAN TAB ── */}
          {healthAtlasTab === "plan" && (
            <div className="space-y-5">
              {/* Profile strip */}
              <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
                {[
                  { label: "Age", val: String(WORKOUT_PLAN.profile.age) },
                  { label: "Height", val: WORKOUT_PLAN.profile.height },
                  { label: "Weight", val: WORKOUT_PLAN.profile.weight },
                  { label: "Body fat", val: WORKOUT_PLAN.profile.bodyFat },
                  { label: "Muscle mass", val: WORKOUT_PLAN.profile.skeletalMuscle },
                  { label: "Goal", val: "Lean bulk" },
                ].map(({ label, val }) => (
                  <div key={label} className="rounded-[1.2rem] border border-white/6 bg-[rgba(35,37,58,0.72)] px-3 py-3 text-center">
                    <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
                    <div className="mt-1 text-sm font-semibold text-white">{val}</div>
                  </div>
                ))}
              </div>

              {/* Weekly schedule */}
              <div>
                <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Weekly schedule</div>
                <div className="space-y-3">
                  {WORKOUT_PLAN.schedule.map((day) => {
                    const c = PLAN_COLORS[day.color];
                    return (
                      <div key={day.day} className={`rounded-[1.4rem] border ${c.border} ${c.bg} p-4`}>
                        <div className="flex items-center gap-3">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${c.badge}`}>{day.day}</span>
                          <span className={`text-sm font-semibold ${c.text}`}>{day.label}</span>
                        </div>
                        {"exercises" in day && day.exercises ? (
                          <div className="mt-3 overflow-hidden rounded-[1rem] border border-white/6">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="border-b border-white/6 text-left text-slate-400">
                                  <th className="px-3 py-2 font-normal">Exercise</th>
                                  <th className="px-3 py-2 font-normal text-center">Sets</th>
                                  <th className="px-3 py-2 font-normal text-center">Reps</th>
                                </tr>
                              </thead>
                              <tbody>
                                {day.exercises.map((ex, i) => (
                                  <tr key={ex.name} className={i % 2 === 0 ? "bg-white/2" : ""}>
                                    <td className="px-3 py-2 text-slate-200">{ex.name}</td>
                                    <td className="px-3 py-2 text-center text-slate-300">{ex.sets}</td>
                                    <td className="px-3 py-2 text-center text-slate-300">{ex.reps}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : "notes" in day && day.notes ? (
                          <div className="mt-2 text-sm text-slate-300">{day.notes}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 12-week goals */}
              <div className="rounded-[1.4rem] border border-violet-300/16 bg-[rgba(139,92,246,0.08)] p-4">
                <div className="mb-3 text-xs uppercase tracking-[0.18em] text-violet-200/80">12-week goals</div>
                <ul className="space-y-2">
                  {WORKOUT_PLAN.goals.map((g) => (
                    <li key={g} className="flex items-start gap-2 text-sm text-slate-200">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400" />
                      {g}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Notes */}
              <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                <div className="mb-3 text-xs uppercase tracking-[0.18em] text-slate-400">Notes</div>
                <ul className="space-y-2">
                  {WORKOUT_PLAN.notes.map((n) => (
                    <li key={n} className="flex items-start gap-2 text-sm text-slate-300">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-500" />
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type TaskListResponse = {
  generated_at: string;
  tasks: DashboardTaskItem[];
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
    published_at?: string | null;
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
  language_sessions: Array<{ id: string; language: string; mode: string; minutes: number; notes: string; created_at?: string | null }>;
  updated_at?: string | null;
};

type JournalResponse = {
  generated_at: string;
  entries: JournalDayEntry[];
  total_entries: number;
  has_more: boolean;
  next_before?: string | null;
  saved_only: boolean;
  query: string;
};

type JournalEntryDateCount = {
  date: string;
  words: number;
};

type JournalEntryDatesResponse = {
  generated_at: string;
  days: JournalEntryDateCount[];
};

type JournalDraft = {
  journal_entry: string;
  accomplishments: string;
  gratitude_entry: string;
  scripture_study: string;
  spiritual_notes: string;
  photo_data_url?: string | null;
  calendar_items: CalendarAgendaItem[];
};

type JournalSectionState = {
  dayOpen: boolean;
  calendarOpen: boolean;
  articlesOpen: boolean;
};

type JournalLoadOptions = {
  before?: string | null;
  query?: string;
  savedOnly?: boolean;
  history?: Array<string | null>;
};

type TaskWindow = "today" | "this_week" | "next_week";

type TaskDraft = {
  title: string;
  detail: string;
  due_at: string;
  due_note: string;
  priority: "high" | "medium" | "low";
};

type AgendaDayGroup = {
  key: string;
  label: string;
  items: CalendarAgendaItem[];
};

type PlanningItem = {
  id: string;
  title: string;
  start: string;
  end: string;
  day_label: string;
  priority: "high" | "medium" | "low";
  kind: "focus" | "meeting_prep" | "admin" | "personal" | "buffer";
  rationale: string;
};

type PlanningResponse = {
  summary: string;
  strategy: string;
  priorities: string[];
  items: PlanningItem[];
};

type PlanningJobStartResponse = {
  job_id: string;
  status: "queued" | "running";
};

type PlanningJobStatus = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  goals: string;
  days: number;
  result?: PlanningResponse | null;
  error?: string | null;
};

type PlanningCalendarCreateResponse = {
  created: boolean;
  event_id?: string | null;
  html_link?: string | null;
  item: PlanningItem;
};

type PlanningCalendarBulkCreateResponse = {
  created_count: number;
  items: PlanningCalendarCreateResponse[];
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

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getJournalSearchPatterns(query: string) {
  const normalized = query.trim();
  if (!normalized) return [];

  return Array.from(
    new Set(
      [normalized, ...normalized.split(/\s+/)]
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
    )
  ).sort((left, right) => right.length - left.length);
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

function textMatchesJournalQuery(text: string | null | undefined, query: string) {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return getJournalSearchPatterns(query).some((pattern) =>
    haystack.includes(pattern.toLowerCase())
  );
}

function highlightJournalSearchText(
  text: string | null | undefined,
  query: string
): React.ReactNode {
  const value = text || "";
  const patterns = getJournalSearchPatterns(query);
  if (!value || !patterns.length) {
    return value;
  }

  const matcher = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi");
  const segments = value.split(matcher);

  return segments.map((segment, index) =>
    patterns.some((pattern) => segment.toLowerCase() === pattern.toLowerCase()) ? (
      <mark
        key={`${segment}-${index}`}
        className="rounded-md bg-fuchsia-400/20 px-1 py-0.5 text-fuchsia-100 ring-1 ring-fuchsia-300/25"
      >
        {segment}
      </mark>
    ) : (
      <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>
    )
  );
}

function highlightJournalTextWithReferences(
  text: string | null | undefined,
  query: string,
  links: Array<{ matched_text?: string | null; label?: string | null }> | null | undefined
): React.ReactNode {
  const value = text || "";
  const searchPatterns = getJournalSearchPatterns(query);
  const referencePatterns = getStudyLinkPatterns(links);
  const patterns = Array.from(new Set([...searchPatterns, ...referencePatterns]))
    .sort((left, right) => right.length - left.length);

  if (!value || !patterns.length) {
    return value;
  }

  const matcher = new RegExp(`(${patterns.map(escapeRegex).join("|")})`, "gi");
  const segments = value.split(matcher);

  return segments.map((segment, index) => {
    const isReferenceMatch = referencePatterns.some(
      (pattern) => segment.toLowerCase() === pattern.toLowerCase()
    );
    const isSearchMatch = searchPatterns.some(
      (pattern) => segment.toLowerCase() === pattern.toLowerCase()
    );

    if (!isReferenceMatch && !isSearchMatch) {
      return <React.Fragment key={`${segment}-${index}`}>{segment}</React.Fragment>;
    }

    const className = isReferenceMatch
      ? "rounded-md bg-indigo-400/18 px-1 py-0.5 text-indigo-50 ring-1 ring-indigo-300/25"
      : "rounded-md bg-fuchsia-400/20 px-1 py-0.5 text-fuchsia-100 ring-1 ring-fuchsia-300/25";

    return (
      <mark key={`${segment}-${index}`} className={className}>
        {segment}
      </mark>
    );
  });
}

function JournalPreviewBlock({
  label,
  value,
  query,
  placeholder,
  compact = false,
  studyLinks,
}: {
  label: string;
  value: string | null | undefined;
  query: string;
  placeholder: string;
  compact?: boolean;
  studyLinks?: Array<{ matched_text?: string | null; label?: string | null }>;
}) {
  const hasValue = Boolean((value || "").trim());

  return (
    <div className="space-y-2">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div
        className={`${compact ? "" : "min-h-[180px]"} rounded-[1.2rem] border px-4 py-3 text-sm leading-6 ${
          hasValue
            ? "border-white/8 bg-[rgba(20,22,37,0.72)] text-slate-100"
            : "border-dashed border-white/10 bg-[rgba(20,22,37,0.42)] text-slate-500"
        }`}
      >
        <div className="whitespace-pre-wrap break-words">
          {hasValue ? highlightJournalTextWithReferences(value, query, studyLinks) : placeholder}
        </div>
      </div>
    </div>
  );
}

function journalHeatmapLevelClass(words: number) {
  // words < 0 means the day has no entry; 0+ means an entry exists (0 = photo only).
  if (words < 0) return "bg-white/5";
  if (words <= 40) return "bg-violet-500/30";
  if (words <= 120) return "bg-violet-500/55";
  if (words <= 300) return "bg-violet-400/75";
  return "bg-fuchsia-400/90";
}

function JournalHeatmap({
  days,
  onSelect,
}: {
  days: JournalEntryDateCount[];
  onSelect: (date: string) => void;
}) {
  const WEEKS = 53;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wordsByDate = useMemo(
    () => new Map(days.map((day) => [day.date, day.words])),
    [days]
  );

  const columns = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Complete the current week so the final column isn't clipped.
    const end = new Date(today);
    end.setDate(end.getDate() + (6 - end.getDay()));
    const cursor = new Date(end);
    cursor.setDate(cursor.getDate() - (WEEKS * 7 - 1));

    const grid: { key: string; inRange: boolean; words: number; monthLabel: string | null; label: string }[][] = [];
    let lastMonth = -1;
    for (let w = 0; w < WEEKS; w++) {
      const col: { key: string; inRange: boolean; words: number; monthLabel: string | null; label: string }[] = [];
      for (let d = 0; d < 7; d++) {
        const key = formatLocalDateKey(cursor);
        let monthLabel: string | null = null;
        if (d === 0 && cursor.getMonth() !== lastMonth) {
          monthLabel = cursor.toLocaleString(undefined, { month: "short" });
          lastMonth = cursor.getMonth();
        }
        col.push({
          key,
          inRange: cursor <= today,
          words: wordsByDate.get(key) ?? -1,
          monthLabel,
          label: cursor.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }),
        });
        cursor.setDate(cursor.getDate() + 1);
      }
      grid.push(col);
    }
    return grid;
  }, [wordsByDate]);

  useEffect(() => {
    // Open on the most recent weeks rather than a year ago.
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [columns]);

  return (
    <div className="space-y-2">
      <div ref={scrollRef} className="overflow-x-auto pb-1">
        <div className="inline-flex flex-col gap-1">
          <div className="flex gap-[3px]">
            {columns.map((col, index) => (
              <div key={index} className="w-[11px] text-[9px] leading-none text-slate-500">
                {col[0].monthLabel ?? ""}
              </div>
            ))}
          </div>
          <div className="flex gap-[3px]">
            {columns.map((col, index) => (
              <div key={index} className="flex flex-col gap-[3px]">
                {col.map((cell) => {
                  if (!cell.inRange) {
                    return <div key={cell.key} className="h-[11px] w-[11px]" />;
                  }
                  const hasEntry = cell.words >= 0;
                  const title = hasEntry
                    ? `${cell.label} · ${cell.words} word${cell.words === 1 ? "" : "s"}`
                    : `${cell.label} · no entry`;
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      title={title}
                      aria-label={`${cell.label} — ${hasEntry ? "entry" : "no entry"}`}
                      onClick={() => onSelect(cell.key)}
                      className={`h-[11px] w-[11px] cursor-pointer rounded-[2px] outline-none transition hover:ring-1 hover:ring-violet-200/70 focus-visible:ring-2 focus-visible:ring-violet-300/70 ${journalHeatmapLevelClass(cell.words)}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
        <span>Less</span>
        <span className="h-[11px] w-[11px] rounded-[2px] bg-white/5" />
        <span className="h-[11px] w-[11px] rounded-[2px] bg-violet-500/30" />
        <span className="h-[11px] w-[11px] rounded-[2px] bg-violet-500/55" />
        <span className="h-[11px] w-[11px] rounded-[2px] bg-violet-400/75" />
        <span className="h-[11px] w-[11px] rounded-[2px] bg-fuchsia-400/90" />
        <span>More</span>
      </div>
    </div>
  );
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

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (data && typeof data.detail === "string" && data.detail.trim()) {
      return data.detail;
    }
  } catch {
    // Ignore malformed or empty error bodies and fall back to the caller message.
  }

  return fallback;
}

function hasImportantLabel(labels: string[] | undefined) {
  return (labels || []).some(
    (label) => label === IMPORTANT_LABEL || LEGACY_IMPORTANT_LABELS.has(label)
  );
}

function hasUnimportantLabel(labels: string[] | undefined) {
  return (labels || []).some(
    (label) => label === UNIMPORTANT_LABEL || LEGACY_UNIMPORTANT_LABELS.has(label)
  );
}

function emailHasLabel(email: Email | null, labelName: string) {
  return (email?.labels || []).includes(labelName);
}

function emailMatchesMailbox(email: Email, mailbox: string) {
  if (mailbox === ALL_MAILBOX) return true;
  if (mailbox === JARVIS_REVIEW_MAILBOX) {
    return hasImportantLabel(email.labels) || hasUnimportantLabel(email.labels);
  }
  return (email.labels || []).includes(mailbox);
}

function isByuEmail(email: Email | null) {
  if (!email) return false;

  const haystack = [email.sender, email.subject, email.snippet, email.body]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes("@byu.edu");
}

function groupEmailsByThread(emails: Email[]) {
  const grouped = new Map<
    string,
    {
      email: Email;
      count: number;
    }
  >();

  for (const email of emails) {
    const existing = grouped.get(email.thread_id);
    if (existing) {
      existing.count += 1;
      continue;
    }

    grouped.set(email.thread_id, {
      email,
      count: 1,
    });
  }

  return Array.from(grouped.values());
}

function isEditableLabel(label: GmailLabel) {
  return label.type === "user";
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
  const cleanupDecision = email.cleanupDecision;
  const byuEmail = isByuEmail(email);

  return (
    <button
      onClick={onClick}
      className={`block w-full max-w-full min-w-0 overflow-hidden rounded-[1.6rem] border p-4 text-left transition duration-200 ${
        selected
          ? "border-fuchsia-400/70 bg-[linear-gradient(135deg,rgba(189,147,249,0.24),rgba(40,42,54,0.98))] ring-1 ring-fuchsia-400/20"
          : "border-white/8 bg-[rgba(24,26,42,0.82)] hover:border-cyan-300/30 hover:bg-[rgba(32,35,57,0.95)] hover:ring-1 hover:ring-cyan-300/12"
      }`}
    >
      <div className="mb-1.5 min-w-0">
        <div className="truncate text-sm font-semibold text-slate-100">
          {decodeHtmlEntities(email.subject) || "(No subject)"}
        </div>
        <div className="truncate text-xs text-slate-400">
          {decodeHtmlEntities(email.sender) || "Unknown sender"}
          {email.date ? ` · ${email.date}` : ""}
        </div>
      </div>

      <p className="mb-2 line-clamp-2 break-words text-sm text-slate-300">
        {decodeHtmlEntities(email.snippet) || ""}
      </p>

      {(byuEmail || cleanupDecision) ? (
        <div className="flex min-w-0 max-w-full flex-wrap gap-2 overflow-hidden">
          {byuEmail ? (
            <Badge className="max-w-full rounded-xl bg-sky-500/20 text-sky-100 hover:bg-sky-500/20">
              BYU mail
            </Badge>
          ) : null}
          {cleanupDecision ? (
            <Badge variant={decisionTone[cleanupDecision.action]} className="max-w-full truncate rounded-xl">
              {cleanupDecision.action}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function formatDateTimeLocalValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function buildTaskDraft(task: DashboardTaskItem): TaskDraft {
  const parsed = parseCalendarDate(task.due_text);
  return {
    title: task.title,
    detail: task.detail || "",
    due_at: parsed ? formatDateTimeLocalValue(parsed) : "",
    due_note: parsed ? "" : task.due_text || "",
    priority: task.priority,
  };
}

function getTaskDraftDueText(draft: TaskDraft) {
  return draft.due_at || draft.due_note.trim() || null;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfLocalWeek(value: Date) {
  const start = startOfLocalDay(value);
  start.setDate(start.getDate() - start.getDay());
  return start;
}

function taskMatchesWindow(task: DashboardTaskItem, window: TaskWindow) {
  const parsed = parseCalendarDate(task.due_text);
  if (!parsed) return true;

  const taskDay = startOfLocalDay(parsed);
  const today = startOfLocalDay(new Date());

  if (window === "today") {
    return taskDay.getTime() === today.getTime();
  }

  const currentWeekStart = startOfLocalWeek(today);
  const nextWeekStart = addLocalDays(currentWeekStart, 7);
  const weekAfterNextStart = addLocalDays(nextWeekStart, 7);

  if (window === "this_week") {
    return taskDay >= currentWeekStart && taskDay < nextWeekStart;
  }

  return taskDay >= nextWeekStart && taskDay < weekAfterNextStart;
}

export default function HomePage() {
  const router = useRouter();
  const [emails, setEmails] = useState<Email[]>([]);
  const [rawNextPageToken, setRawNextPageToken] = useState<string | null>(null);
  const [rawPageToken, setRawPageToken] = useState<string | null>(null);
  const [rawPageHistory, setRawPageHistory] = useState<string[]>([]);
  const [labels, setLabels] = useState<GmailLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [labelsLoading, setLabelsLoading] = useState(false);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [handleLoading, setHandleLoading] = useState(false);
  const [emailActionLoading, setEmailActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health" | "jobs">("dashboard");
  const [mailView, setMailView] = useState<"ai" | "raw">("raw");
  const [mailWorkspaceTab, setMailWorkspaceTab] = useState<"triage" | "insights">("triage");
  const [scheduleWorkspaceTab, setScheduleWorkspaceTab] = useState<"agenda" | "planner">("agenda");
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [healthEntries, setHealthEntries] = useState<HealthDailyEntry[]>([]);
  const [selectedHealthDate, setSelectedHealthDate] = useState<string | null>(null);
  const [movementEntries, setMovementEntries] = useState<MovementDailyEntry[]>([]);
  const [workoutEntries, setWorkoutEntries] = useState<WorkoutEntry[]>([]);
  const [movementLoading, setMovementLoading] = useState(false);
  const [tasks, setTasks] = useState<DashboardTaskItem[]>([]);
  const [taskDrafts, setTaskDrafts] = useState<Record<string, TaskDraft>>({});
  const [taskSavingId, setTaskSavingId] = useState<string | null>(null);
  const [taskEditingId, setTaskEditingId] = useState<string | null>(null);
  const [taskDeletingId, setTaskDeletingId] = useState<string | null>(null);
  const [calendarTaskLoadingId, setCalendarTaskLoadingId] = useState<string | null>(null);
  const [taskCreateLoading, setTaskCreateLoading] = useState(false);
  const [taskWindow, setTaskWindow] = useState<TaskWindow>("today");
  const [dashboardQuickTaskTitle, setDashboardQuickTaskTitle] = useState("");
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDetail, setNewTaskDetail] = useState("");
  const [newTaskDueAt, setNewTaskDueAt] = useState("");
  const [newTaskDueNote, setNewTaskDueNote] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<"high" | "medium" | "low">("medium");
  const [journal, setJournal] = useState<JournalResponse | null>(null);
  const [journalDrafts, setJournalDrafts] = useState<Record<string, JournalDraft>>({});
  const [journalSectionState, setJournalSectionState] = useState<Record<string, JournalSectionState>>({});
  const [journalSavingDate, setJournalSavingDate] = useState<string | null>(null);
  const [journalExtractingDate, setJournalExtractingDate] = useState<string | null>(null);
  const [journalScanningDate, setJournalScanningDate] = useState<string | null>(null);
  const [journalEditingDate, setJournalEditingDate] = useState<string | null>(null);
  const [journalSearchInput, setJournalSearchInput] = useState("");
  const [journalQuery, setJournalQuery] = useState("");
  const [journalSavedOnly, setJournalSavedOnly] = useState(false);
  const [journalBefore, setJournalBefore] = useState<string | null>(null);
  const [journalHistory, setJournalHistory] = useState<Array<string | null>>([]);
  const [journalJumpDate, setJournalJumpDate] = useState<string | null>(null);
  const [journalHeatmap, setJournalHeatmap] = useState<JournalEntryDateCount[] | null>(null);
  const [journalHeatmapOpen, setJournalHeatmapOpen] = useState(false);
  // Shared "which days have an entry" lookup for the heatmap and the jump-to picker.
  const journalEntryDateSet = useMemo(
    () => new Set((journalHeatmap ?? []).map((day) => day.date)),
    [journalHeatmap]
  );
  const [classifiedBucket] = useState<"all" | "important" | "unimportant">("all");
  const [overview, setOverview] = useState<ClassificationOverview | null>(null);
  const [agenda, setAgenda] = useState<CalendarAgenda | null>(null);
  const [scheduleDays, setScheduleDays] = useState("7");
  const [quickCalendarPrompt, setQuickCalendarPrompt] = useState("");
  const [quickCalendarLoading, setQuickCalendarLoading] = useState(false);
  const [quickCalendarResult, setQuickCalendarResult] = useState<CalendarQuickAddResponse | null>(null);
  const [selectedMailbox, setSelectedMailbox] = useState<string>(JARVIS_REVIEW_MAILBOX);
  const [mailSidebarOpen, setMailSidebarOpen] = useState(true);
  const [skipNextMailFetch, setSkipNextMailFetch] = useState(false);
  const [extraVisibleMailboxes, setExtraVisibleMailboxes] = useState<string[]>([]);
  const [mailboxAddOpen, setMailboxAddOpen] = useState(false);
  const [inboxLimit, setInboxLimit] = useState("");
  const [cleanupSummary, setCleanupSummary] = useState<CleanupSummary | null>(null);
  const [cleanupLimit, setCleanupLimit] = useState("");
  const [cleanupJob, setCleanupJob] = useState<CleanupJobStatus | null>(null);
  const [cleanupExpanded, setCleanupExpanded] = useState(false);
  const [calendarPreview, setCalendarPreview] = useState<CalendarPreview | null>(null);
  const [calendarLoading, setCalendarLoading] = useState(false);
  const [calendarCreateLoading, setCalendarCreateLoading] = useState(false);
  const [calendarCreateLink, setCalendarCreateLink] = useState<string | null>(null);
  const [classificationGuidance, setClassificationGuidance] = useState("");
  const [savedClassificationGuidance, setSavedClassificationGuidance] = useState("");
  const [classificationGuidanceUpdatedAt, setClassificationGuidanceUpdatedAt] = useState<string | null>(null);
  const [guidanceLoading, setGuidanceLoading] = useState(false);
  const [guidanceSaving, setGuidanceSaving] = useState(false);
  const [labelDraft, setLabelDraft] = useState<string[]>([]);
  const [labelSectionOpen, setLabelSectionOpen] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [planningPrompt, setPlanningPrompt] = useState("");
  const [planningDays, setPlanningDays] = useState("7");
  const [planningLoading, setPlanningLoading] = useState(false);
  const [planningResult, setPlanningResult] = useState<PlanningResponse | null>(null);
  const [planningJob, setPlanningJob] = useState<PlanningJobStatus | null>(null);
  const [planningCalendarLoading, setPlanningCalendarLoading] = useState(false);
  const [planningCalendarLink, setPlanningCalendarLink] = useState<string | null>(null);
  const [planningBulkCalendarLoading, setPlanningBulkCalendarLoading] = useState(false);
  const [planningBulkCalendarMessage, setPlanningBulkCalendarMessage] = useState("");
  const [googleAuthStatus, setGoogleAuthStatus] = useState<GoogleOAuthStatus | null>(null);
  const [jobAlerts, setJobAlerts] = useState<JobListing[]>([]);
  const [jobAlertsError, setJobAlertsError] = useState("");
  const [jobAlertsQualifiedOnly, setJobAlertsQualifiedOnly] = useState(false);
  const [jobAlertsFromEmails, setJobAlertsFromEmails] = useState(0);
  const [jobAlertsLoaded, setJobAlertsLoaded] = useState(false);
  const [jobAlertsJob, setJobAlertsJob] = useState<JobAlertsJobStatus | null>(null);
  const activePlanningJobIdRef = useRef<string | null>(null);
  const hasLoadedDashboardRef = useRef(false);
  const hasLoadedTasksRef = useRef(false);
  const hasLoadedJournalRef = useRef(false);

  useEffect(() => {
    void loadGoogleAuthStatus();
  }, []);

  const syncSelectedId = (nextEmails: Email[]) => {
    if (nextEmails.length > 0) {
      setSelectedId((prev) =>
        prev && nextEmails.some((email) => email.id === prev) ? prev : nextEmails[0].id
      );
      return;
    }

    setSelectedId(null);
  };

  // Advance selection to the next email after removing `removedId`, or the
  // previous one when it was the last in the list.
  const advanceSelectedId = (currentEmails: Email[], removedId: string) => {
    const idx = currentEmails.findIndex((e) => e.id === removedId);
    const nextEmails = currentEmails.filter((e) => e.id !== removedId);
    if (nextEmails.length === 0) {
      setSelectedId(null);
      return;
    }
    setSelectedId(nextEmails[Math.min(Math.max(idx, 0), nextEmails.length - 1)].id);
  };

  const syncTaskDrafts = (nextTasks: DashboardTaskItem[]) => {
    setTaskDrafts(
      Object.fromEntries(
        nextTasks.map((task) => [task.id, buildTaskDraft(task)])
      )
    );
  };

  const loadGoogleAuthStatus = async () => {
    try {
      const response = await fetch(`${API_BASE}/google/oauth/status`);
      if (!response.ok) {
        return;
      }

      const data: GoogleOAuthStatus = await response.json();
      setGoogleAuthStatus(data);
    } catch {
      // Keep the dashboard usable even if the auth status probe fails.
    }
  };

  const loadLabels = async () => {
    setLabelsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/labels`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Labels request failed with status ${response.status}`)
        );
      }

      const data: GmailLabel[] = await response.json();
      setLabels(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load folders.";
      setError(message);
    } finally {
      setLabelsLoading(false);
    }
  };

  const loadEmails = async (
    currentMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health" | "jobs" = mode,
    mailboxOverride?: string,
    pageTokenOverride?: string | null,
    currentMailView: "ai" | "raw" = mailView
  ) => {
    if (
      currentMode === "planning" ||
      currentMode === "assistant" ||
      currentMode === "dashboard" ||
      currentMode === "tasks" ||
      currentMode === "journal" ||
      currentMode === "news"
      || currentMode === "settings" ||
      currentMode === "health"
    ) {
      return;
    }

    setLoading(true);
    setError("");

    try {
      const targetMailbox = mailboxOverride ?? selectedMailbox;
      const targetsAllMail = targetMailbox === ALL_MAILBOX;
      const targetsJarvisReview = targetMailbox === JARVIS_REVIEW_MAILBOX;
      if (currentMode === "overview" && targetsAllMail) {
        setOverview(null);
        setAgenda(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(null);
        setError("All Mail is browse-only. Pick a specific mailbox for AI Report.");
        return;
      }
      if (currentMode === "mail" && currentMailView === "ai" && targetsAllMail) {
        setOverview(null);
        setAgenda(null);
        setCleanupSummary(null);
        setCleanupJob(null);
        setMailView("raw");
        return;
        setMailView("raw");
        return;
      }

      if (currentMode === "mail" && targetsJarvisReview) {
        const trimmed = inboxLimit.trim();
        const limit = trimmed ? Number(trimmed) : NaN;
        const requestLimit =
          trimmed && Number.isFinite(limit) && limit > 0
            ? Math.max(1, Math.floor(limit))
            : currentMailView === "raw"
              ? 50
              : 25;

        const endpoints =
          currentMailView === "ai"
            ? [
                `${API_BASE}/classify?limit=${requestLimit}&bucket=${classifiedBucket}&mailbox=${encodeURIComponent(IMPORTANT_LABEL)}`,
                `${API_BASE}/classify?limit=${requestLimit}&bucket=${classifiedBucket}&mailbox=${encodeURIComponent(UNIMPORTANT_LABEL)}`,
              ]
            : [
                `${API_BASE}/emails?limit=${requestLimit}&mailbox=${encodeURIComponent(IMPORTANT_LABEL)}`,
                `${API_BASE}/emails?limit=${requestLimit}&mailbox=${encodeURIComponent(UNIMPORTANT_LABEL)}`,
              ];

        const responses = await Promise.all(endpoints.map((endpoint) => fetch(endpoint)));
        for (const response of responses) {
          if (!response.ok) {
            throw new Error(
              await getErrorMessage(response, `Request failed with status ${response.status}`)
            );
          }
        }

        const payloads = await Promise.all(responses.map((response) => response.json()));
        const normalized =
          currentMailView === "ai"
            ? payloads
                .flatMap((items) => items as Array<{ email: Email; classification: Classification }>)
                .map((item) => ({
                  ...item.email,
                  classification: item.classification,
                }))
            : payloads.flatMap((items) => (items as EmailPageResponse).items);

        normalized.sort((a, b) => {
          const aTime = parseCalendarDate(a.date)?.getTime() ?? 0;
          const bTime = parseCalendarDate(b.date)?.getTime() ?? 0;
          return bTime - aTime;
        });

        const deduped = Array.from(
          new Map(normalized.map((email) => [email.id, email])).values()
        );

        setOverview(null);
        setAgenda(null);
        setEmails(deduped);
        setRawPageToken(null);
        setRawNextPageToken(null);
        setRawPageHistory([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        syncSelectedId(deduped);
        return;
      }

      const trimmed = inboxLimit.trim();
      const limit = trimmed ? Number(trimmed) : NaN;
      const params = new URLSearchParams();
      if (currentMode === "schedule") {
        const days = Number(scheduleDays);
        params.set("days", String(Number.isFinite(days) && days > 0 ? Math.floor(days) : 7));
      } else if (currentMode === "overview") {
        params.set("mailbox", targetMailbox);
      } else if (currentMode === "mail" && currentMailView === "raw") {
        const pageSize =
          trimmed && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
        params.set("limit", String(pageSize));
        params.set("mailbox", targetMailbox);
        if (pageTokenOverride) {
          params.set("page_token", pageTokenOverride);
        }
      } else if (trimmed && Number.isFinite(limit) && limit > 0) {
        params.set("limit", String(Math.floor(limit)));
        params.set("bucket", classifiedBucket);
        params.set("mailbox", targetMailbox);
      } else if (currentMode === "mail") {
        params.set("bucket", classifiedBucket);
        params.set("mailbox", targetMailbox);
      }
      const endpoint =
        currentMode === "mail" && currentMailView === "ai"
          ? "/classify"
          : currentMode === "overview"
            ? "/overview"
            : currentMode === "schedule"
              ? "/calendar/schedule"
            : "/emails";
      const queryString = params.toString() ? `?${params.toString()}` : "";
      const response = await fetch(`${API_BASE}${endpoint}${queryString}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Request failed with status ${response.status}`)
        );
      }

      const data = await response.json();

      if (currentMode === "schedule") {
        const nextAgenda = data as CalendarAgenda;
        setAgenda(nextAgenda);
        setOverview(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(nextAgenda.items[0]?.event_id || null);
        return;
      }

      if (currentMode === "overview") {
        setOverview(normalizeOverview(data as Partial<ClassificationOverview>));
        setAgenda(null);
        setEmails([]);
        setCleanupSummary(null);
        setCleanupJob(null);
        setSelectedId(null);
        return;
      }

      const normalized: Email[] =
        currentMode === "mail" && currentMailView === "ai"
          ? data.map((item: { email: Email; classification: Classification }) => ({
              ...item.email,
              classification: item.classification,
            }))
          : (data as EmailPageResponse).items;

      setOverview(null);
      setAgenda(null);
      setEmails(normalized);
      if (currentMode === "mail" && currentMailView === "raw") {
        setRawPageToken(pageTokenOverride ?? null);
        setRawNextPageToken((data as EmailPageResponse).next_page_token ?? null);
      } else {
        setRawPageToken(null);
        setRawNextPageToken(null);
        setRawPageHistory([]);
      }
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

  const loadDashboard = async () => {
    setLoading(true);
    setMovementLoading(true);
    setError("");
    setOverview(null);
    setAgenda(null);
    setEmails([]);
    setCleanupSummary(null);
    setCleanupJob(null);
    setSelectedId(null);

    try {
      const [dashboardResponse, healthResponse, movementResponse, workoutsResponse, journalWarmResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`),
        fetch(`${API_BASE}/health?days=3650`),
        fetch(`${API_BASE}/movement?days=14`),
        fetch(`${API_BASE}/workouts?days=90&limit=60`),
        // Pre-warm the journal cache so the journal tab works offline.
        // days=14 matches the default loadJournal param so the SW cache key aligns.
        fetch(`${API_BASE}/journal?days=14`),
      ]);

      // Write all responses into the SW's Cache API directly. This ensures
      // offline fallback works even on the first visit, before the service
      // worker's fetch interception is active (first-visit race condition).
      void Promise.all([
        warmApiCache(`${API_BASE}/dashboard`, dashboardResponse),
        warmApiCache(`${API_BASE}/health?days=3650`, healthResponse),
        warmApiCache(`${API_BASE}/movement?days=14`, movementResponse),
        warmApiCache(`${API_BASE}/workouts?days=90&limit=60`, workoutsResponse),
        warmApiCache(`${API_BASE}/journal?days=14`, journalWarmResponse),
      ]);

      if (!dashboardResponse.ok) {
        throw new Error(
          await getErrorMessage(dashboardResponse, `Dashboard request failed with status ${dashboardResponse.status}`)
        );
      }

      const data: DashboardResponse = await dashboardResponse.json();
      setDashboard(data);
      hasLoadedDashboardRef.current = true;
      if (data.google_error) {
        setGoogleAuthStatus(prev => prev ? { ...prev, authorized: false } : { authorized: false, start_path: `${API_BASE}/google/oauth/start` });
      }

      if (healthResponse.ok) {
        const healthData: HealthListResponse = await healthResponse.json();
        const nextHealthEntries = [...healthData.entries].sort((left, right) => right.date.localeCompare(left.date));
        setHealthEntries(nextHealthEntries);
        setSelectedHealthDate((current) => current ?? nextHealthEntries[0]?.date ?? data.health_summary?.today_entry?.date ?? null);
      } else {
        setHealthEntries([]);
      }

      if (movementResponse.ok) {
        const movementData: MovementListResponse = await movementResponse.json();
        setMovementEntries(movementData.entries);
      } else {
        setMovementEntries([]);
      }
      if (workoutsResponse.ok) {
        const workoutData: WorkoutListResponse = await workoutsResponse.json();
        setWorkoutEntries(workoutData.workouts);
      } else {
        setWorkoutEntries([]);
      }

      await loadTasks(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load dashboard.";
      setError(message);
    } finally {
      setLoading(false);
      setMovementLoading(false);
    }
  };

  const jobClosingInfo = (closesAt: string | null) => {
    if (!closesAt) return null;
    const days = Math.ceil((new Date(closesAt).getTime() - Date.now()) / 86400000);
    if (days < 0) return { label: "Closed", className: "text-slate-500" };
    if (days === 0) return { label: "Closes today", className: "text-red-400 font-semibold" };
    if (days <= 3) return { label: `Closes in ${days}d`, className: "text-red-400 font-semibold" };
    if (days <= 7) return { label: `Closes in ${days}d`, className: "text-amber-400" };
    return { label: `Closes in ${days}d`, className: "text-slate-400" };
  };

  const startJobAlerts = async (force = false) => {
    setJobAlertsError("");
    try {
      const res = await fetch(`${API_BASE}/job-alerts/start?force=${force}`, { method: "POST" });
      if (!res.ok) throw new Error(await getErrorMessage(res, `Failed to start job alerts scan: ${res.status}`));
      const data: JobAlertsJobStatus = await res.json();
      setJobAlertsJob(data);
    } catch (err) {
      setJobAlertsError(err instanceof Error ? err.message : "Failed to start job alerts scan.");
    }
  };

  const loadTasks = async (includeCompleted = true, showLoading = false) => {
    if (showLoading) {
      setLoading(true);
    }
    setError("");

    try {
      const response = await fetch(
        `${API_BASE}/tasks?include_completed=${includeCompleted ? "true" : "false"}`
      );
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Tasks request failed with status ${response.status}`)
        );
      }

      const data: TaskListResponse = await response.json();
      setTasks(data.tasks);
      syncTaskDrafts(data.tasks);
      hasLoadedTasksRef.current = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load tasks.";
      setError(message);
    } finally {
      if (showLoading) {
        setLoading(false);
      }
    }
  };

  const loadJournal = async (options: JournalLoadOptions = {}) => {
    setLoading(true);
    setError("");

    try {
      const before = options.before !== undefined ? options.before : journalBefore;
      const nextQuery = options.query ?? journalQuery;
      const nextSavedOnly = options.savedOnly ?? journalSavedOnly;
      const params = new URLSearchParams();
      params.set("days", nextSavedOnly || nextQuery ? "20" : "14");
      if (before) {
        params.set("before", before);
      }
      if (nextSavedOnly) {
        params.set("saved_only", "true");
      }
      if (nextQuery.trim()) {
        params.set("query", nextQuery.trim());
      }

      const response = await fetch(`${API_BASE}/journal?${params.toString()}`);
      if (!response.ok) {
        if (!navigator.onLine) {
          throw new Error("You're offline and journal data hasn't been cached yet. Open the journal while connected first.");
        }
        throw new Error(
          await getErrorMessage(response, `Journal request failed with status ${response.status}`)
        );
      }

      const data: JournalResponse = await response.json();
      setJournal(data);
      hasLoadedJournalRef.current = true;
      setJournalDrafts((current) => ({
        ...current,
        ...Object.fromEntries(
          data.entries.map((entry) => [
            entry.date,
            {
              journal_entry: entry.journal_entry || "",
              accomplishments: entry.accomplishments || "",
              gratitude_entry: entry.gratitude_entry || "",
              scripture_study: entry.scripture_study || "",
              spiritual_notes: entry.spiritual_notes || "",
              photo_data_url: entry.photo_data_url || null,
              calendar_items: entry.calendar_items || [],
            },
          ])
        ),
      }));
      setJournalBefore(before);
      setJournalQuery(nextQuery);
      setJournalSearchInput(nextQuery);
      setJournalSavedOnly(nextSavedOnly || Boolean(nextQuery.trim()));
      setJournalHistory(options.history ?? journalHistory);
      setOverview(null);
      setAgenda(null);
      setEmails([]);
      setCleanupSummary(null);
      setCleanupJob(null);
      setSelectedId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load journal.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const loadJournalHeatmap = async () => {
    try {
      const response = await fetch(`${API_BASE}/journal/entry-dates`);
      if (!response.ok) return;
      const data: JournalEntryDatesResponse = await response.json();
      setJournalHeatmap(data.days);
    } catch {
      // Heatmap is a non-critical enhancement; ignore fetch failures.
    }
  };

  const jumpToJournalDate = async (date: string) => {
    // Heatmap jumps always land in the recent-timeline view so the exact day renders,
    // regardless of any active saved-only filter or search.
    setJournalJumpDate(date);
    await loadJournal({ before: shiftLocalDateKey(date, 1), query: "", savedOnly: false, history: [] });
    if (typeof window !== "undefined") {
      window.setTimeout(() => {
        document
          .getElementById(`journal-entry-${date}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    }
  };

  const persistJournalDraft = async (entryDate: string, draft: JournalDraft) => {
    setJournalSavingDate(entryDate);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Journal save failed with status ${response.status}`)
        );
      }

      const saved: JournalDayEntry = await response.json();
      setJournal((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.date === entryDate
                  ? {
                      ...entry,
                      journal_entry: saved.journal_entry,
                      accomplishments: saved.accomplishments,
                      gratitude_entry: saved.gratitude_entry,
                      scripture_study: saved.scripture_study,
                      spiritual_notes: saved.spiritual_notes,
                      study_links: saved.study_links,
                      photo_data_url: saved.photo_data_url,
                      calendar_items: saved.calendar_items,
                      updated_at: saved.updated_at,
                    }
                  : entry
              ),
            }
          : current
      );
      await loadJournal({
        before: journalBefore,
        query: journalQuery,
        savedOnly: journalSavedOnly,
        history: journalHistory,
      });
      void loadJournalHeatmap();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save journal entry.";
      setError(message);
    } finally {
      setJournalSavingDate(null);
      setJournalEditingDate(null);
    }
  };

  const extractJournalCitations = async (entryDate: string, draft: JournalDraft) => {
    setJournalExtractingDate(entryDate);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/journal/${entryDate}/extract-citations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Citation extraction failed with status ${response.status}`)
        );
      }

      const saved: JournalDayEntry = await response.json();
      setJournal((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) =>
                entry.date === entryDate
                  ? {
                      ...entry,
                      journal_entry: saved.journal_entry,
                      accomplishments: saved.accomplishments,
                      gratitude_entry: saved.gratitude_entry,
                      scripture_study: saved.scripture_study,
                      spiritual_notes: saved.spiritual_notes,
                      study_links: saved.study_links,
                      photo_data_url: saved.photo_data_url,
                      calendar_items: saved.calendar_items,
                      updated_at: saved.updated_at,
                    }
                  : entry
              ),
            }
          : current
      );
      await loadJournal({
        before: journalBefore,
        query: journalQuery,
        savedOnly: journalSavedOnly,
        history: journalHistory,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to extract citations.";
      setError(message);
    } finally {
      setJournalExtractingDate(null);
    }
  };

  const saveJournalEntry = async (entryDate: string) => {
    const draft = journalDrafts[entryDate];
    if (!draft) return;
    await persistJournalDraft(entryDate, draft);
  };

  const applyJournalSearch = async () => {
    const nextQuery = journalSearchInput.trim();
    await loadJournal({
      before: null,
      query: nextQuery,
      savedOnly: journalSavedOnly || Boolean(nextQuery),
      history: [],
    });
  };

  const clearJournalSearch = async () => {
    setJournalSearchInput("");
    await loadJournal({
      before: null,
      query: "",
      savedOnly: false,
      history: [],
    });
  };

  const toggleJournalArchiveMode = async (savedOnly: boolean) => {
    if (!savedOnly && journalSearchInput.trim()) {
      setJournalSearchInput("");
    }
    await loadJournal({
      before: null,
      query: savedOnly ? journalSearchInput.trim() : "",
      savedOnly,
      history: [],
    });
  };

  const loadOlderJournalEntries = async () => {
    if (!journal?.next_before) return;
    await loadJournal({
      before: journal.next_before,
      query: journalQuery,
      savedOnly: journalSavedOnly,
      history: [...journalHistory, journalBefore],
    });
  };

  const loadNewerJournalEntries = async () => {
    if (!journalHistory.length) return;
    const nextHistory = journalHistory.slice(0, -1);
    const previousBefore = journalHistory[journalHistory.length - 1] ?? null;
    await loadJournal({
      before: previousBefore,
      query: journalQuery,
      savedOnly: journalSavedOnly,
      history: nextHistory,
    });
  };

  const toggleJournalSection = (
    entryDate: string,
    key: keyof JournalSectionState
  ) => {
    setJournalSectionState((current) => ({
      ...current,
      [entryDate]: {
        dayOpen: current[entryDate]?.dayOpen ?? false,
        calendarOpen: current[entryDate]?.calendarOpen ?? false,
        articlesOpen: current[entryDate]?.articlesOpen ?? false,
        [key]: !(current[entryDate]?.[key] ?? false),
      },
    }));
  };

  const handleJournalPhotoChange = async (
    entryDate: string,
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const currentDraft = journalDrafts[entryDate];
    if (!currentDraft) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (!result) return;
      const nextDraft: JournalDraft = {
        ...currentDraft,
        photo_data_url: result,
      };
      setJournalDrafts((current) => {
        return {
          ...current,
          [entryDate]: nextDraft,
        };
      });
      await persistJournalDraft(entryDate, nextDraft);
    };
    reader.readAsDataURL(file);
  };

  const scanJournalFromImage = async (
    entryDate: string,
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const currentDraft = journalDrafts[entryDate];
    if (!currentDraft) return;

    setJournalScanningDate(entryDate);
    setError("");
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const mediaType = file.type || "image/jpeg";

      const response = await fetch(`${API_BASE}/journal/extract-from-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: base64, media_type: mediaType }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json() as {
        detected_date?: string | null;
        scripture_study?: string;
        spiritual_notes?: string;
        journal_entry?: string;
        confidence?: string;
      };

      const nextDraft: JournalDraft = {
        ...currentDraft,
        ...(result.scripture_study ? { scripture_study: result.scripture_study } : {}),
        ...(result.journal_entry ? { journal_entry: result.journal_entry } : {}),
        ...(result.spiritual_notes ? { spiritual_notes: result.spiritual_notes } : {}),
      };
      setJournalDrafts((current) => ({ ...current, [entryDate]: nextDraft }));
      setJournalEditingDate(entryDate);
    } catch (err) {
      setError(`Scan failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setJournalScanningDate(null);
    }
  };

  const saveTask = async (
    taskId: string,
    payload: {
      title?: string;
      detail?: string;
      due_text?: string | null;
      priority?: "high" | "medium" | "low";
      completed?: boolean;
    }
  ) => {
    setTaskSavingId(taskId);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task update failed with status ${response.status}`)
        );
      }

      const saved: DashboardTaskItem = await response.json();
      setTasks((current) => {
        const next = current.some((task) => task.id === saved.id)
          ? current.map((task) => (task.id === saved.id ? saved : task))
          : [...current, saved];
        return next;
      });
      setTaskDrafts((current) => ({
        ...current,
        [saved.id]: buildTaskDraft(saved),
      }));
      if (payload.completed === undefined) {
        setTaskEditingId(null);
      }
      if (mode === "dashboard") {
        await loadTasks(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update task.";
      setError(message);
    } finally {
      setTaskSavingId(null);
    }
  };

  const deleteTask = async (taskId: string) => {
    setTaskDeletingId(taskId);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks/${taskId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task delete failed with status ${response.status}`)
        );
      }

      setTasks((current) => current.filter((task) => task.id !== taskId));
      setTaskDrafts((current) => {
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      if (taskEditingId === taskId) {
        setTaskEditingId(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete task.";
      setError(message);
    } finally {
      setTaskDeletingId(null);
    }
  };

  const createTaskFromCalendarItem = async (item: CalendarAgendaItem) => {
    setCalendarTaskLoadingId(item.event_id);
    setError("");
    try {
      const detailParts = [item.location, item.description].filter(Boolean);
      const response = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: item.title,
          detail: detailParts.join("\n\n"),
          due_text: item.start || null,
          priority: "medium",
          source: "calendar",
          related_event_id: item.event_id,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task create failed with status ${response.status}`)
        );
      }

      const created: DashboardTaskItem = await response.json();
      setTasks((current) => {
        const next = current.some((task) => task.id === created.id)
          ? current.map((task) => (task.id === created.id ? created : task))
          : [created, ...current];
        return next;
      });
      setTaskDrafts((current) => ({
        ...current,
        [created.id]: buildTaskDraft(created),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create task from event.";
      setError(message);
    } finally {
      setCalendarTaskLoadingId(null);
    }
  };

  const createTaskItem = async (
    overrides?: {
      title: string;
      detail?: string;
      due_text?: string | null;
      priority?: "high" | "medium" | "low";
      onSuccess?: () => void;
    }
  ) => {
    const title = (overrides?.title ?? newTaskTitle).trim();
    if (!title) return;

    setTaskCreateLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          detail: overrides?.detail ?? newTaskDetail,
          due_text: overrides?.due_text ?? (newTaskDueAt || newTaskDueNote.trim() || null),
          priority: overrides?.priority ?? newTaskPriority,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Task create failed with status ${response.status}`)
        );
      }

      const created: DashboardTaskItem = await response.json();
      setTasks((current) => [created, ...current]);
      setTaskDrafts((current) => ({
        ...current,
        [created.id]: buildTaskDraft(created),
      }));
      if (overrides) {
        overrides.onSuccess?.();
      } else {
        setNewTaskTitle("");
        setNewTaskDetail("");
        setNewTaskDueAt("");
        setNewTaskDueNote("");
        setNewTaskPriority("medium");
      }
      if (mode === "dashboard") {
        await loadTasks(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create task.";
      setError(message);
    } finally {
      setTaskCreateLoading(false);
    }
  };

  const updateJournalCalendarItems = async (
    entryDate: string,
    updater: (items: CalendarAgendaItem[]) => CalendarAgendaItem[],
    persist = false
  ) => {
    const currentDraft = journalDrafts[entryDate];
    if (!currentDraft) return;

    const nextDraft: JournalDraft = {
      ...currentDraft,
      calendar_items: updater(currentDraft.calendar_items),
    };

    setJournalDrafts((current) => ({
      ...current,
      [entryDate]: nextDraft,
    }));

    if (persist) {
      await persistJournalDraft(entryDate, nextDraft);
    }
  };

  const fetchEmailsEffect = useEffectEvent(
    (
      currentMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health" | "jobs",
      mailboxName?: string,
      currentMailView: "ai" | "raw" = mailView
    ) => {
      if (currentMode === "dashboard" || currentMode === "news") {
        if (!hasLoadedDashboardRef.current) {
          void loadDashboard();
        }
        return;
      }
      if (currentMode === "settings") {
        void loadLabels();
        void loadClassificationGuidance();
        return;
      }
      if (currentMode === "health") {
        if (!hasLoadedDashboardRef.current) {
          void loadDashboard();
        }
        return;
      }
      if (currentMode === "tasks") {
        if (!hasLoadedTasksRef.current) {
          void loadTasks(true, true);
        }
        return;
      }
      if (currentMode === "journal") {
        if (!hasLoadedJournalRef.current) {
          void loadJournal();
        }
        void loadJournalHeatmap();
        return;
      }
      if (currentMode === "planning" || (currentMode === "schedule" && scheduleWorkspaceTab === "planner")) {
        return;
      }
      if (currentMode === "overview" || (currentMode === "mail" && mailWorkspaceTab === "insights")) {
        void loadEmails("overview", mailboxName);
        return;
      }
      if (currentMode === "mail" && skipNextMailFetch) {
        setSkipNextMailFetch(false);
        return;
      }
      if (currentMode === "schedule") {
        void loadEmails("schedule", mailboxName, undefined, currentMailView);
        return;
      }
      void loadEmails(currentMode, mailboxName, undefined, currentMailView);
    }
  );

  const refreshDashboardMovementEffect = useEffectEvent(async () => {
    try {
      const [dashboardResponse, movementResponse] = await Promise.all([
        fetch(`${API_BASE}/dashboard`, { cache: "no-store" }),
        fetch(`${API_BASE}/movement?days=14`, { cache: "no-store" }),
      ]);

      if (dashboardResponse.ok) {
        const dashboardData: DashboardResponse = await dashboardResponse.json();
        setDashboard(dashboardData);
        hasLoadedDashboardRef.current = true;
        if (dashboardData.google_error) {
          setGoogleAuthStatus(prev => prev ? { ...prev, authorized: false } : { authorized: false, start_path: `${API_BASE}/google/oauth/start` });
        }
      }

      if (movementResponse.ok) {
        const movementData: MovementListResponse = await movementResponse.json();
        setMovementEntries(movementData.entries);
      }
    } catch {
      // Keep background refresh quiet so transient failures do not disrupt the dashboard.
    }
  });

  const replaceOrRemoveEmail = (updatedEmail: Email) => {
    setEmails((currentEmails) => {
      const nextEmails = currentEmails
        .map((email) => (email.id === updatedEmail.id ? { ...email, ...updatedEmail } : email))
        .filter((email) =>
          mode === "mail" && mailView === "raw" ? emailMatchesMailbox(email, selectedMailbox) : true
        );
      syncSelectedId(nextEmails);
      return nextEmails;
    });
  };

  const updateSelectedEmail = async (payload: {
    add_label_names?: string[];
    remove_label_names?: string[];
    archive?: boolean;
    unread?: boolean;
  }) => {
    if (!selectedEmail) return;

    setEmailActionLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${selectedEmail.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Email update failed with status ${response.status}`)
        );
      }

      const data: EmailUpdateResponse = await response.json();
      replaceOrRemoveEmail(data.email);
      await loadLabels();
      if (mode === "mail" && mailView === "ai") {
        await loadEmails("mail", selectedMailbox, undefined, "ai");
      }
      if (isMailInsightsMode) {
        await loadEmails("overview");
      }
      if (isScheduleAgendaMode) {
        await loadEmails("schedule");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update the email.";
      setError(message);
    } finally {
      setEmailActionLoading(false);
    }
  };

  const toggleDraftLabel = (labelName: string) => {
    setLabelDraft((current) =>
      current.includes(labelName)
        ? current.filter((label) => label !== labelName)
        : [...current, labelName]
    );
  };

  const applyLabelDraft = async () => {
    if (!selectedEmail) return;

    const currentEditableLabels = (selectedEmail.labels || []).filter((labelName) =>
      editableLabelNames.includes(labelName)
    );
    const addLabelNames = labelDraft.filter((labelName) => !currentEditableLabels.includes(labelName));
    const removeLabelNames = currentEditableLabels.filter(
      (labelName) => !labelDraft.includes(labelName)
    );
    const cleanedNewLabel = newLabelName.split(/\s+/).filter(Boolean).join(" ").trim();
    if (
      cleanedNewLabel &&
      !labelDraft.includes(cleanedNewLabel) &&
      !addLabelNames.includes(cleanedNewLabel)
    ) {
      addLabelNames.push(cleanedNewLabel);
    }

    if (addLabelNames.length === 0 && removeLabelNames.length === 0) {
      setNewLabelName("");
      return;
    }

    await updateSelectedEmail({
      add_label_names: addLabelNames,
      remove_label_names: removeLabelNames,
    });
    setNewLabelName("");
  };

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
        throw new Error(
          await getErrorMessage(response, `Cleanup request failed with status ${response.status}`)
        );
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
    const handledEmail = selectedEmail;

    setEmails((currentEmails) => {
      advanceSelectedId(currentEmails, handledEmail.id);
      return currentEmails.filter((email) => email.id !== handledEmail.id);
    });

    try {
      const response = await fetch(`${API_BASE}/emails/${handledEmail.id}/handle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thread_id: handledEmail.thread_id }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Handle request failed with status ${response.status}`)
        );
      }
    } catch (err) {
      setEmails((currentEmails) => {
        const restored = [handledEmail, ...currentEmails];
        syncSelectedId(restored);
        return restored;
      });
      const message = err instanceof Error ? err.message : "Failed to mark email handled.";
      setError(message);
    } finally {
      setHandleLoading(false);
    }
  };

  const trashEmail = async () => {
    if (!selectedEmail) return;

    setEmailActionLoading(true);
    setError("");
    const targetEmail = selectedEmail;

    setEmails((currentEmails) => {
      advanceSelectedId(currentEmails, targetEmail.id);
      return currentEmails.filter((email) => email.id !== targetEmail.id);
    });

    try {
      const response = await fetch(`${API_BASE}/emails/${targetEmail.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Delete request failed with status ${response.status}`)
        );
      }
    } catch (err) {
      setEmails((currentEmails) => {
        const restored = [targetEmail, ...currentEmails];
        syncSelectedId(restored);
        return restored;
      });
      const message = err instanceof Error ? err.message : "Failed to delete email.";
      setError(message);
    } finally {
      setEmailActionLoading(false);
    }
  };

  const loadCalendarPreview = async (messageId: string) => {
    setCalendarLoading(true);
    try {
      const response = await fetch(`${API_BASE}/calendar/preview/${messageId}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Calendar preview failed with status ${response.status}`)
        );
      }

      const data: CalendarPreview = await response.json();
      setCalendarPreview(data.relevant ? data : null);
    } catch {
      setCalendarPreview(null);
    } finally {
      setCalendarLoading(false);
    }
  };

  const createCalendarEvent = async () => {
    if (!selectedEmail) return;

    setCalendarCreateLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_BASE}/calendar/create/${selectedEmail.id}`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Calendar create failed with status ${response.status}`)
        );
      }

      const data: CalendarCreateResponse = await response.json();
      setCalendarPreview(data.preview.relevant ? data.preview : null);
      setCalendarCreateLink(data.html_link || null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create calendar event.";
      setError(message);
    } finally {
      setCalendarCreateLoading(false);
    }
  };

  const createQuickCalendarEvent = async () => {
    const description = quickCalendarPrompt.trim();
    if (!description) return;

    setQuickCalendarLoading(true);
    setError("");
    setQuickCalendarResult(null);

    try {
      const response = await fetch(`${API_BASE}/calendar/quick-add`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ description }),
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Quick add failed with status ${response.status}`)
        );
      }

      const data: CalendarQuickAddResponse = await response.json();
      setQuickCalendarResult(data);
      setQuickCalendarPrompt("");
      await loadEmails("schedule");
      if (data.event_id) {
        setSelectedId(data.event_id);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add the event to Calendar.";
      setError(message);
    } finally {
      setQuickCalendarLoading(false);
    }
  };

  const generatePlan = async () => {
    setPlanningLoading(true);
    setError("");
    setPlanningCalendarLink(null);
    setPlanningBulkCalendarMessage("");
    setPlanningResult(null);

    try {
      const days = Number(planningDays);
      const requestBody = JSON.stringify({
        goals: planningPrompt,
        days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 7,
      });

      let response: Response | null = null;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(`${API_BASE}/planning/plan`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: requestBody,
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (attempt === 0) {
            await new Promise((resolve) => window.setTimeout(resolve, 400));
          }
        }
      }

      if (!response) {
        throw lastError instanceof Error
          ? lastError
          : new Error("Planning request could not reach the backend.");
      }

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Planning request failed with status ${response.status}`)
        );
      }

      const data: PlanningJobStartResponse = await response.json();
      activePlanningJobIdRef.current = data.job_id;
      setPlanningJob({
        job_id: data.job_id,
        status: data.status,
        goals: planningPrompt,
        days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 7,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to generate plan.";
      setError(message);
      setPlanningLoading(false);
    }
  };

  const createPlanningCalendarEvent = async () => {
    if (!selectedPlanningItem) return;

    setPlanningCalendarLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/planning/calendar`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ item: selectedPlanningItem }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Planning calendar create failed with status ${response.status}`
          )
        );
      }

      const data: PlanningCalendarCreateResponse = await response.json();
      setPlanningCalendarLink(data.html_link || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add the planning block to Calendar.";
      setError(message);
    } finally {
      setPlanningCalendarLoading(false);
    }
  };

  const createPlanningCalendarEvents = async (items: PlanningItem[], successLabel: string) => {
    if (items.length === 0) return;

    setPlanningBulkCalendarLoading(true);
    setPlanningBulkCalendarMessage("");
    setError("");

    try {
      const response = await fetch(`${API_BASE}/planning/calendar/bulk`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Planning calendar bulk create failed with status ${response.status}`
          )
        );
      }

      const data: PlanningCalendarBulkCreateResponse = await response.json();
      setPlanningBulkCalendarMessage(
        `${successLabel}: added ${data.created_count} of ${items.length} block${items.length === 1 ? "" : "s"} to Google Calendar.`
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add planning blocks to Calendar.";
      setError(message);
    } finally {
      setPlanningBulkCalendarLoading(false);
    }
  };

  const openOverviewEmail = async (messageId: string) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/emails/${messageId}/classified`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Email lookup failed with status ${response.status}`)
        );
      }

      const data: ClassifiedEmailResponse = await response.json();
      const email: Email = {
        ...data.email,
        classification: data.classification,
      };

      setSkipNextMailFetch(true);
      setSelectedMailbox(ALL_MAILBOX);
      setMailWorkspaceTab("triage");
      setMode("mail");
      setMailView("raw");
      setOverview(null);
      setAgenda(null);
      setCleanupSummary(null);
      setCleanupJob(null);
      setEmails([email]);
      setSelectedId(email.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to open the selected email.";
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const loadClassificationGuidance = async () => {
    setGuidanceLoading(true);
    try {
      const response = await fetch(`${API_BASE}/classification-guidance`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Classification guidance failed with status ${response.status}`
          )
        );
      }

      const data: ClassificationGuidance = await response.json();
      setClassificationGuidance(data.text || "");
      setSavedClassificationGuidance(data.text || "");
      setClassificationGuidanceUpdatedAt(data.updated_at || null);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load classification guidance.";
      setError(message);
    } finally {
      setGuidanceLoading(false);
    }
  };

  const saveClassificationGuidance = async () => {
    setGuidanceSaving(true);
    setError("");

    try {
      const response = await fetch(`${API_BASE}/classification-guidance`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ text: classificationGuidance }),
      });

      if (!response.ok) {
        throw new Error(
          await getErrorMessage(
            response,
            `Classification guidance save failed with status ${response.status}`
          )
        );
      }

      const data: ClassificationGuidance = await response.json();
      setClassificationGuidance(data.text || "");
      setSavedClassificationGuidance(data.text || "");
      setClassificationGuidanceUpdatedAt(data.updated_at || null);

      if (mode === "mail" && mailView === "ai") {
        await loadEmails("mail", selectedMailbox, undefined, "ai");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to save classification guidance.";
      setError(message);
    } finally {
      setGuidanceSaving(false);
    }
  };

  useEffect(() => {
    void loadLabels();
    void loadClassificationGuidance();
  }, []);

  useEffect(() => {
    fetchEmailsEffect(mode, selectedMailbox, mailView);
  }, [mode, selectedMailbox, classifiedBucket, scheduleDays, mailView, mailWorkspaceTab, scheduleWorkspaceTab]);

  useEffect(() => {
    if (mode !== "dashboard") {
      return;
    }

    const poll = window.setInterval(() => {
      void refreshDashboardMovementEffect();
    }, LIVE_MOVEMENT_REFRESH_MS);

    return () => window.clearInterval(poll);
  }, [mode]);

  useEffect(() => {
    if (mode !== "mail" || mailView !== "raw") return;
    setRawPageToken(null);
    setRawNextPageToken(null);
    setRawPageHistory([]);
  }, [mode, selectedMailbox, mailView]);

  useEffect(() => {
    if (mode === "overview") {
      setMailWorkspaceTab("insights");
      setMode("mail");
    } else if (mode === "planning") {
      setScheduleWorkspaceTab("planner");
      setMode("schedule");
    }
  }, [mode]);

  useEffect(() => {
    if (!cleanupJob || (cleanupJob.status !== "queued" && cleanupJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`${API_BASE}/cleanup/jobs/${cleanupJob.job_id}`);
        if (!response.ok) {
          throw new Error(
            await getErrorMessage(
              response,
              `Cleanup status failed with status ${response.status}`
            )
          );
        }

        const data: CleanupJobStatus = await response.json();
        setCleanupJob(data);

        if (data.status === "completed" && data.result) {
          const normalized = normalizeCleanupItems(data.result);
          setMailWorkspaceTab("triage");
          setMode("mail");
          setMailView("raw");
          setEmails(normalized);
          setCleanupSummary(data.result.summary);
          syncSelectedId(normalized);
          setCleanupLoading(false);
          await loadLabels();
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

  useEffect(() => {
    if (!planningJob || (planningJob.status !== "queued" && planningJob.status !== "running")) {
      return;
    }

    const poll = window.setInterval(async () => {
      try {
        const expectedJobId = planningJob.job_id;
        const response = await fetch(`${API_BASE}/planning/jobs/${expectedJobId}`);
        if (!response.ok) {
          throw new Error(
            await getErrorMessage(
              response,
              `Planning status failed with status ${response.status}`
            )
          );
        }

        const data: PlanningJobStatus = await response.json();
        if (activePlanningJobIdRef.current !== data.job_id || data.job_id !== expectedJobId) {
          return;
        }
        setPlanningJob(data);

        if (data.status === "completed" && data.result) {
          setPlanningResult(data.result);
          setSelectedId(data.result.items[0]?.id || null);
          setPlanningLoading(false);
        }

        if (data.status === "failed") {
          setError(data.error || "Planning failed.");
          setPlanningLoading(false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch planning status.";
        setError(message);
        setPlanningLoading(false);
      }
    }, 1200);

    return () => window.clearInterval(poll);
  }, [planningJob]);

  useEffect(() => {
    if (!jobAlertsJob || (jobAlertsJob.status !== "queued" && jobAlertsJob.status !== "running")) return;
    const expectedId = jobAlertsJob.job_id;
    const poll = window.setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/job-alerts/jobs/${expectedId}`);
        if (!res.ok) return;
        const data: JobAlertsJobStatus = await res.json();
        if (data.job_id !== expectedId) return;
        setJobAlertsJob(data);
        if (data.status === "completed" && data.result) {
          const all: JobListing[] = data.result.items ?? [];
          setJobAlerts(jobAlertsQualifiedOnly ? all.filter((j) => j.qualifies) : all);
          setJobAlertsFromEmails(data.result.from_emails ?? 0);
          setJobAlertsLoaded(true);
        }
        if (data.status === "failed") {
          setJobAlertsError(data.error ?? "Scan failed.");
        }
      } catch { /* ignore poll errors */ }
    }, 1500);
    return () => window.clearInterval(poll);
  }, [jobAlertsJob, jobAlertsQualifiedOnly]);

  const filteredEmails = useMemo(() => {
    const q = safeLower(query.trim());
    if (!q) return emails;

    return emails.filter((email) => {
      const haystack = [
        email.subject,
        email.sender,
        email.snippet,
        email.body,
        ...(email.labels || []),
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

  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.completed),
    [tasks]
  );
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.completed),
    [tasks]
  );
  const filteredActiveTasks = useMemo(
    () => activeTasks.filter((task) => taskMatchesWindow(task, taskWindow)),
    [activeTasks, taskWindow]
  );
  const filteredCompletedTasks = useMemo(
    () => completedTasks.filter((task) => taskMatchesWindow(task, taskWindow)),
    [completedTasks, taskWindow]
  );

  const isMailWorkspaceMode = mode === "mail" || mode === "overview";
  const isMailInsightsMode = mode === "overview" || (mode === "mail" && mailWorkspaceTab === "insights");
  const isMailTriageMode = mode === "mail" && mailWorkspaceTab === "triage";
  const isScheduleWorkspaceMode = mode === "schedule" || mode === "planning";
  const isScheduleAgendaMode = mode === "schedule" && scheduleWorkspaceTab === "agenda";
  const isSchedulePlannerMode = mode === "planning" || (mode === "schedule" && scheduleWorkspaceTab === "planner");
  const isMailMode = mode === "mail";
  const isAiMailView = isMailTriageMode && mailView === "ai";
  const isRawMailView = isMailTriageMode && mailView === "raw";
  const groupedRawEmails = useMemo(() => groupEmailsByThread(filteredEmails), [filteredEmails]);
  const displayEmails = isRawMailView ? groupedRawEmails.map((item) => item.email) : filteredEmails;
  const threadCountByEmailId = useMemo(
    () =>
      new Map(groupedRawEmails.map((item) => [item.email.id, item.count])),
    [groupedRawEmails]
  );

  const selectedEmail =
    displayEmails.find((email) => email.id === selectedId) ||
    displayEmails[0] ||
    null;
  const canMarkHandled =
    !!selectedEmail &&
    !isMailInsightsMode &&
    !isScheduleWorkspaceMode &&
    !emailHasLabel(selectedEmail, "Reviewed");
  const canMarkImportant = !!selectedEmail && !hasImportantLabel(selectedEmail.labels);
  const canMarkUnimportant = !!selectedEmail && !hasUnimportantLabel(selectedEmail.labels);
  const isUnread = emailHasLabel(selectedEmail, "UNREAD");
  const isInInbox = emailHasLabel(selectedEmail, "INBOX");

  const mailboxLabels = useMemo(
    () => [
      {
        id: JARVIS_REVIEW_MAILBOX,
        name: JARVIS_REVIEW_MAILBOX,
        type: "system" as const,
        messages_total:
          (labels.find((label) => label.name === IMPORTANT_LABEL)?.messages_total ?? 0) +
          (labels.find((label) => label.name === UNIMPORTANT_LABEL)?.messages_total ?? 0),
        messages_unread:
          (labels.find((label) => label.name === IMPORTANT_LABEL)?.messages_unread ?? 0) +
          (labels.find((label) => label.name === UNIMPORTANT_LABEL)?.messages_unread ?? 0),
      },
      {
        id: ALL_MAILBOX,
        name: ALL_MAILBOX,
        type: "system" as const,
        messages_total: 0,
        messages_unread: 0,
      },
      ...labels.filter((label) => label.name !== "CHAT"),
    ],
    [labels]
  );
  const visibleMailboxLabels = useMemo(
    () =>
      mailboxLabels.filter(
        (label) =>
          DEFAULT_VISIBLE_MAILBOXES.has(label.name) ||
          extraVisibleMailboxes.includes(label.name) ||
          label.name === selectedMailbox
      ),
    [extraVisibleMailboxes, mailboxLabels, selectedMailbox]
  );
  const hiddenMailboxLabels = useMemo(
    () =>
      mailboxLabels.filter(
        (label) =>
          !DEFAULT_VISIBLE_MAILBOXES.has(label.name) &&
          !extraVisibleMailboxes.includes(label.name) &&
          label.name !== selectedMailbox
      ),
    [extraVisibleMailboxes, mailboxLabels, selectedMailbox]
  );
  const editableLabels = useMemo(
    () => labels.filter((label) => isEditableLabel(label)).sort((a, b) => a.name.localeCompare(b.name)),
    [labels]
  );
  const editableLabelNames = useMemo(() => editableLabels.map((label) => label.name), [editableLabels]);

  useEffect(() => {
    if (!selectedEmail) {
      setLabelDraft([]);
      return;
    }

    setLabelDraft(
      (selectedEmail.labels || []).filter((labelName) => editableLabelNames.includes(labelName))
    );
  }, [selectedEmail, editableLabelNames]);

  useEffect(() => {
    setCalendarCreateLink(null);
    if (!selectedEmail || isMailInsightsMode) {
      setCalendarPreview(null);
      return;
    }
  }, [selectedEmail, mode]);

  useEffect(() => {
    setPlanningCalendarLink(null);
  }, [selectedId, planningResult]);

  useEffect(() => {
    setPlanningBulkCalendarMessage("");
  }, [planningResult]);

  useEffect(() => {
    if (!isScheduleAgendaMode) {
      setQuickCalendarResult(null);
    }
  }, [isScheduleAgendaMode]);

  useEffect(() => {
    if (!journalJumpDate || !journal?.entries?.length) return;
    const el = document.getElementById(`journal-entry-${journalJumpDate}`);
    if (!el) return;
    setJournalSectionState((prev) => ({
      ...prev,
      [journalJumpDate]: {
        dayOpen: true,
        calendarOpen: prev[journalJumpDate]?.calendarOpen ?? false,
        articlesOpen: prev[journalJumpDate]?.articlesOpen ?? false,
      },
    }));
    setTimeout(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    setJournalJumpDate(null);
  }, [journalJumpDate, journal?.entries]);

  const selectedMailboxLabel =
    mailboxLabels.find((label) => label.name === selectedMailbox) ||
    visibleMailboxLabels.find((label) => label.name === ALL_MAILBOX) ||
    null;
  const agendaDayGroups = useMemo(
    () => buildAgendaDayGroups(agenda?.items || []),
    [agenda?.items]
  );
  const selectedAgendaEvent =
    agenda?.items.find((item) => item.event_id === selectedId) || agenda?.items[0] || null;
  const planningDayGroups = useMemo(
    () => buildPlanningDayGroups(planningResult?.items || []),
    [planningResult?.items]
  );
  const selectedPlanningItem =
    planningResult?.items.find((item) => item.id === selectedId) || planningResult?.items[0] || null;
  const selectedPlanningDayItems = useMemo(
    () =>
      selectedPlanningItem
        ? (planningResult?.items || []).filter(
            (item) => item.day_label === selectedPlanningItem.day_label
          )
        : [],
    [planningResult?.items, selectedPlanningItem]
  );
  const highPriorityPlanningItems = useMemo(
    () => (planningResult?.items || []).filter((item) => item.priority === "high"),
    [planningResult?.items]
  );

  const cleanupProgressPercent =
    cleanupJob && cleanupJob.total > 0
      ? Math.min(100, Math.round((cleanupJob.processed / cleanupJob.total) * 100))
      : 0;
  const rawHasPreviousPage = rawPageHistory.length > 0;
  const selectedThreadCount = selectedEmail ? threadCountByEmailId.get(selectedEmail.id) ?? 1 : 1;
  const guidanceDirty = classificationGuidance !== savedClassificationGuidance;

  const setTopLevelMode = (
    nextMode: "dashboard" | "assistant" | "tasks" | "journal" | "mail" | "news" | "overview" | "schedule" | "planning" | "settings" | "health" | "jobs"
  ) => {
    if (nextMode === "overview") {
      setMailWorkspaceTab("insights");
      setMode("mail");
      setError("");
  
      if (selectedMailbox === ALL_MAILBOX || selectedMailbox === JARVIS_REVIEW_MAILBOX) {
        setSelectedMailbox(IMPORTANT_LABEL);
      }
      return;
    }

    if (nextMode === "planning") {
      setScheduleWorkspaceTab("planner");
      setMode("schedule");
      setError("");
  
      return;
    }

    if (nextMode === "mail") {
      setMailWorkspaceTab("triage");
    }

    if (nextMode === "schedule") {
      setScheduleWorkspaceTab("agenda");
    }

    setError("");
    setMode(nextMode);

  };

  const correctClassification = async (targetLabel: "important" | "unimportant") => {
    if (!selectedEmail) return;

    const addLabelName = targetLabel === "important" ? IMPORTANT_LABEL : UNIMPORTANT_LABEL;
    const removeLabelNames =
      targetLabel === "important"
        ? [UNIMPORTANT_LABEL, ...LEGACY_UNIMPORTANT_LABELS]
        : [IMPORTANT_LABEL, ...LEGACY_IMPORTANT_LABELS];

    await updateSelectedEmail({
      add_label_names: [addLabelName],
      remove_label_names: removeLabelNames,
    });
  };

  const renderTaskCard = (task: DashboardTaskItem, compact = false) => {
    const draft = taskDrafts[task.id] || buildTaskDraft(task);
    const isEditing = taskEditingId === task.id;

    return (
      <div
        key={task.id}
        className={`rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] ${
          compact ? "p-4" : "p-5"
        }`}
      >
        {isEditing ? (
          <div className="space-y-3">
            <Input
              value={draft.title}
              onChange={(e) =>
                setTaskDrafts((current) => ({
                  ...current,
                  [task.id]: { ...draft, title: e.target.value },
                }))
              }
              className="rounded-xl"
              placeholder="Task title"
            />
            <textarea
              value={draft.detail}
              onChange={(e) =>
                setTaskDrafts((current) => ({
                  ...current,
                  [task.id]: { ...draft, detail: e.target.value },
                }))
              }
              className="min-h-[96px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
              placeholder="Task details"
            />
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_120px]">
              <Input
                type="datetime-local"
                value={draft.due_at}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: { ...draft, due_at: e.target.value },
                  }))
                }
                className="rounded-xl"
              />
              <Input
                value={draft.due_note}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: { ...draft, due_note: e.target.value },
                  }))
                }
                className="rounded-xl"
                placeholder="Or a quick due note"
              />
              <select
                value={draft.priority}
                onChange={(e) =>
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: {
                      ...draft,
                      priority: e.target.value as "high" | "medium" | "low",
                    },
                  }))
                }
                className="rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none"
              >
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="rounded-2xl"
                onClick={() =>
                    void saveTask(task.id, {
                      title: draft.title,
                      detail: draft.detail,
                      due_text: getTaskDraftDueText(draft),
                      priority: draft.priority,
                    })
                }
                disabled={taskSavingId === task.id}
              >
                {taskSavingId === task.id ? "Saving..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => {
                  setTaskDrafts((current) => ({
                    ...current,
                    [task.id]: buildTaskDraft(task),
                  }));
                  setTaskEditingId(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl border-rose-400/30 text-rose-200 hover:bg-rose-500/10"
                onClick={() => void deleteTask(task.id)}
                disabled={taskDeletingId === task.id}
              >
                {taskDeletingId === task.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-semibold ${task.completed ? "text-slate-400 line-through" : "text-slate-100"}`}>
                  {task.title}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                    {formatTaskSourceLabel(task.source)}
                  </span>
                  {task.due_text ? (
                    <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-100">
                      {formatDashboardTaskDueText(task) || task.due_text}
                    </span>
                  ) : null}
                  {task.completed ? (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-400">
                      Completed
                    </span>
                  ) : null}
                </div>
                {task.detail ? (
                  <div className={`mt-2 text-sm ${compact ? "line-clamp-2 text-slate-400" : "text-slate-300"}`}>
                    {task.detail}
                  </div>
                ) : (
                  <div className="mt-2 text-xs text-slate-500">
                    {task.source === "calendar"
                      ? "Calendar-derived task"
                      : task.source === "mail"
                        ? "Pulled forward from mail"
                        : "Ready to work"}
                  </div>
                )}
              </div>
              <Badge
                variant={
                  task.priority === "high"
                    ? "default"
                    : task.priority === "medium"
                      ? "secondary"
                      : "outline"
                }
                className="rounded-xl"
              >
                {task.priority}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="rounded-2xl"
                variant={task.completed ? "outline" : "default"}
                onClick={() => void saveTask(task.id, { completed: !task.completed })}
                disabled={taskSavingId === task.id}
              >
                {task.completed ? "Reopen" : "Complete"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => setTaskEditingId(task.id)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-2xl border-rose-400/30 text-rose-200 hover:bg-rose-500/10"
                onClick={() => void deleteTask(task.id)}
                disabled={taskDeletingId === task.id}
              >
                {taskDeletingId === task.id ? "Deleting..." : "Delete"}
              </Button>
            </div>
          </div>
        )}
      </div>
    );
  };

  const utilitiesPanel = (
    <Card className="rounded-[1.5rem] border border-white/8 bg-[rgba(20,22,37,0.6)] shadow-[0_12px_32px_rgba(6,7,14,0.2)] backdrop-blur-xl">
      <CardHeader className="px-5 py-4">
        <button
          type="button"
          onClick={() => setCleanupExpanded((current) => !current)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Utilities
            </CardTitle>
            <p className="mt-1 text-xs text-slate-400">
              Inbox maintenance and cleanup tools.
            </p>
          </div>
          <div className="flex items-center gap-2 text-slate-400">
            {cleanupJob && (cleanupJob.status === "queued" || cleanupJob.status === "running") ? (
              <Badge variant="secondary" className="rounded-xl">
                Cleanup running
              </Badge>
            ) : null}
            {cleanupExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </div>
        </button>
      </CardHeader>

      {cleanupExpanded ? (
        <CardContent className="space-y-4 px-5 pb-5 pt-0">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl text-sm leading-6 text-slate-300">
              Clean up the whole inbox with one click. Every processed message is labeled as Jarvis Important or Jarvis Unimportant and then archived so the inbox can reach zero. This version never deletes messages.
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

          {cleanupJob ? (
            <>
              <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
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

                <div className="h-2 overflow-hidden rounded-full bg-white/8">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#bd93f9,#8be9fd)] transition-all"
                    style={{ width: `${cleanupProgressPercent}%` }}
                  />
                </div>

                <div className="mt-3 flex flex-col gap-1 text-sm text-slate-300">
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
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Processed
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.total_processed}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Archived
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.archived}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Labeled only
                        </div>
                        <div className="mt-1 text-2xl font-semibold">
                          {cleanupSummary.labeled_only}
                        </div>
                      </CardContent>
                    </Card>
                    <Card className="rounded-2xl shadow-none">
                      <CardContent className="p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">Kept</div>
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
                      Cleanup uses only Jarvis Important and Jarvis Unimportant
                    </Badge>
                  </div>
                </>
              ) : null}
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );

  return (
    <div className="min-h-screen text-slate-100">
      <nav className="sticky top-0 z-20 border-b border-white/8 bg-[rgba(11,13,26,0.96)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-1 px-3 py-1.5">
          <span className="mr-2 text-[10px] font-bold tracking-[0.25em] text-white/40">JARVIS</span>

          <Button variant={mode === "dashboard" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("dashboard")}>
            <Sparkles className="mr-1.5 h-3 w-3" />Dashboard
          </Button>
          <Button variant={mode === "assistant" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("assistant")}>
            <Sparkles className="mr-1.5 h-3 w-3" />Ask
          </Button>
          <Button variant={isMailWorkspaceMode ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("mail")}>
            <Inbox className="mr-1.5 h-3 w-3" />Mail
          </Button>
          <Button variant={mode === "journal" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("journal")}>
            <BookOpen className="mr-1.5 h-3 w-3" />Journal
          </Button>
          <Button variant={mode === "tasks" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("tasks")}>
            <ShieldCheck className="mr-1.5 h-3 w-3" />Tasks
          </Button>
          <Button variant={mode === "health" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("health")}>
            <Activity className="mr-1.5 h-3 w-3" />Health
          </Button>
          <Button variant={isScheduleWorkspaceMode ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("schedule")}>
            <CalendarDays className="mr-1.5 h-3 w-3" />Schedule
          </Button>
          <Button variant={mode === "jobs" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("jobs")}>
            <Briefcase className="mr-1.5 h-3 w-3" />Jobs
          </Button>
          <Button variant={mode === "news" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("news")}>
            <Newspaper className="mr-1.5 h-3 w-3" />News
          </Button>
          <Button asChild variant="ghost" size="sm" className="h-7 rounded-xl px-2.5 text-xs">
            <Link href="/language">
              <Languages className="mr-1.5 h-3 w-3" />Language
            </Link>
          </Button>
          <Button variant={mode === "settings" ? "default" : "ghost"} size="sm" className="h-7 rounded-xl px-2.5 text-xs" onClick={() => setTopLevelMode("settings")}>
            <SlidersHorizontal className="mr-1.5 h-3 w-3" />Settings
          </Button>

          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              className="h-7 w-7 rounded-xl p-0"
              variant="ghost"
              onClick={() => {
                setRawPageToken(null);
                setRawNextPageToken(null);
                setRawPageHistory([]);
                void loadLabels();
                if (mode === "dashboard") {
                  void loadDashboard();
                  return;
                }
                if (mode === "tasks") {
                  void loadTasks(true, true);
                  return;
                }
                if (mode === "journal") {
                  void loadJournal();
                  return;
                }
                if (isSchedulePlannerMode) {
                  if (planningPrompt.trim()) {
                    void generatePlan();
                  }
                  return;
                }
                if (mode === "news") {
                  void loadDashboard();
                  return;
                }
                if (mode === "settings") {
                  void loadLabels();
                  void loadClassificationGuidance();
                  return;
                }
                if (mode === "health") {
                  void loadDashboard();
                  return;
                }
                if (mode === "assistant") {
                  return;
                }
                if (isMailInsightsMode) {
                  void loadEmails("overview", selectedMailbox);
                  return;
                }
                if (isScheduleAgendaMode) {
                  void loadEmails("schedule", selectedMailbox);
                  return;
                }
                void loadEmails(mode, selectedMailbox);
              }}
              disabled={loading || cleanupLoading || emailActionLoading || planningLoading}
              aria-label="Refresh current page"
              title="Refresh current page"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading || labelsLoading || planningLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-[1500px] space-y-6 p-4 md:p-6">

        {googleAuthStatus && !googleAuthStatus.authorized && mode !== "settings" ? (
          <div className="flex flex-col gap-3 rounded-[1.4rem] border border-amber-300/20 bg-amber-400/8 px-4 py-3 text-sm text-amber-50 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-amber-300" />
              <span className="text-amber-100/90">Google disconnected — calendar, mail, and tasks may be incomplete.</span>
            </div>
            <a href={googleAuthStatus.start_path || `${API_BASE}/google/oauth/start`}
              className="shrink-0 rounded-2xl border border-amber-300/30 bg-amber-400/15 px-4 py-1.5 text-xs font-medium text-amber-200 transition hover:bg-amber-400/25">
              Reconnect Google →
            </a>
          </div>
        ) : null}

        {mode === "dashboard" ? (
          <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Sparkles className="h-5 w-5" />
                    Daily briefing
                  </CardTitle>
                  <p className="text-sm leading-6 text-slate-300">
                    {dashboard?.date_label || "Today"} at a glance, generated from your calendar, important mail, and current headlines.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  {error ? (
                    <div className="flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                      <AlertCircle className="mt-0.5 h-4 w-4" />
                      <div>{error}</div>
                    </div>
                  ) : null}
                  {(googleAuthStatus ? !googleAuthStatus.authorized : false) || isGoogleAuthIssue(error) ? (
                    <div className="flex flex-col gap-3 rounded-[1.4rem] border border-cyan-300/15 bg-cyan-400/10 p-4 text-sm text-cyan-50 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium text-white">
                          <ShieldCheck className="h-4 w-4 text-cyan-200" />
                          Google connection
                        </div>
                        <div className="mt-1 text-sm leading-6 text-cyan-100/85">
                          {googleAuthStatus?.authorized
                            ? "Google is connected, but the latest Gmail or Calendar request looks like it needs re-authorization."
                            : googleAuthStatus?.instructions || "Connect Google so this running container can reach Gmail and Calendar."}
                        </div>
                      </div>
                      <Button
                        asChild
                        variant="outline"
                        className="rounded-2xl border-cyan-200/30 bg-white/5 text-cyan-50 hover:bg-white/10"
                      >
                        <a href={googleAuthStatus?.start_path || `${API_BASE}/google/oauth/start`}>
                          Connect Google
                        </a>
                      </Button>
                    </div>
                  ) : null}
                  <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.16),rgba(35,37,58,0.92))] p-5">
                    <div className="text-xs uppercase tracking-[0.22em] text-cyan-100/80">
                      AI overview
                    </div>
                    <div className="mt-3 text-sm leading-7 text-slate-100">
                      {dashboard?.overview || (loading ? "Building your dashboard..." : "Refresh to generate your daily overview.")}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMailbox(IMPORTANT_LABEL);
                        setMailWorkspaceTab("triage");
                        setMailView("raw");
                        setMode("mail");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Important</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.important_emails.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open mail triage</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("tasks")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Open tasks</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{activeTasks.length}</div>
                      <div className="mt-2 text-xs text-cyan-100">Review task list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("news")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Headlines</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.news_items.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open article list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScheduleWorkspaceTab("agenda");
                        setMode("schedule");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Calendar today</div>
                      <div className="mt-2 text-2xl font-semibold text-white">{dashboard?.calendar_items.length || 0}</div>
                      <div className="mt-2 text-xs text-cyan-100">Open schedule</div>
                    </button>
                    <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left">
                      <div className="text-xs uppercase tracking-[0.18em] text-slate-400">Health today</div>
                      <div className="mt-2 text-2xl font-semibold text-white">
                        {formatHealthStat(dashboard?.health_summary?.today_entry?.steps)}
                      </div>
                      <div className="mt-2 text-xs text-cyan-100">Steps from Apple Health</div>
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedMailbox(IMPORTANT_LABEL);
                        setMailWorkspaceTab("triage");
                        setMailView("raw");
                        setMode("mail");
                      }}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">Mail</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.mail_summary || "No mail summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open important mail</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("news")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">News</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.news_summary || "No news summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open article list</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setMode("tasks")}
                      className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                    >
                      <div className="text-xs uppercase tracking-wide text-slate-400">Tasks</div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {dashboard?.tasks_summary || "No task summary yet."}
                      </div>
                      <div className="mt-3 text-xs text-cyan-100">Open task manager</div>
                    </button>
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-lg">
                        <Plus className="h-5 w-5" />
                        Quick task capture
                      </CardTitle>
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        Add something fast from the dashboard, then use the full task editor only when you need more detail.
                      </p>
                    </div>
                    <Button variant="outline" className="rounded-2xl" onClick={() => setMode("tasks")}>
                      Open full task editor
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-3 md:flex-row">
                    <Input
                      value={dashboardQuickTaskTitle}
                      onChange={(e) => setDashboardQuickTaskTitle(e.target.value)}
                      className="h-11 rounded-2xl"
                      placeholder="Capture a task before it slips away"
                    />
                    <Button
                      className="rounded-2xl md:px-6"
                      onClick={() =>
                        void createTaskItem({
                          title: dashboardQuickTaskTitle,
                          detail: "",
                          due_text: null,
                          priority: "medium",
                          onSuccess: () => setDashboardQuickTaskTitle(""),
                        })
                      }
                      disabled={taskCreateLoading || !dashboardQuickTaskTitle.trim()}
                    >
                      {taskCreateLoading ? "Adding..." : "Add task"}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 xl:grid-cols-2">
                <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <CalendarDays className="h-5 w-5" />
                      Today&apos;s schedule
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {dashboard?.calendar_items?.length ? (
                        dashboard.calendar_items.map((item) => (
                          <div
                            key={item.event_id}
                            className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                                <div className="mt-1 text-sm text-cyan-100">
                                  {formatScheduleTimeRange(item)}
                                </div>
                                {item.location ? (
                                  <div className="mt-1 text-xs text-slate-400">{item.location}</div>
                                ) : null}
                              </div>
                              <div className="flex flex-col items-end gap-2">
                                <Badge variant="outline" className="rounded-xl">
                                  {item.is_all_day
                                    ? `${formatRelativeDayLabel(item.start)} · All day`
                                    : formatRelativeDayLabel(item.start)}
                                </Badge>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="rounded-2xl"
                                  onClick={() => void createTaskFromCalendarItem(item)}
                                  disabled={calendarTaskLoadingId === item.event_id}
                                >
                                  {calendarTaskLoadingId === item.event_id ? "Adding..." : "Add task"}
                                </Button>
                              </div>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                          {loading ? "Loading today's schedule..." : "No calendar items found for today."}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>

                <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ShieldCheck className="h-5 w-5" />
                      Task list
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {activeTasks.length ? (
                        activeTasks.map((task) => renderTaskCard(task, true))
                      ) : (
                        <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                          {loading ? "Loading tasks..." : "No tasks surfaced yet."}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>

            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Activity className="h-5 w-5" />
                    Health snapshot
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {dashboard?.health_summary ? (
                    <div className="space-y-4">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Steps</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {formatHealthStat(dashboard.health_summary.today_entry?.steps)}
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            7-day avg {formatHealthStat(dashboard.health_summary.seven_day_avg_steps)}
                          </div>
                        </div>
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Sleep avg</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {formatHealthStat(dashboard.health_summary.seven_day_avg_sleep_hours, 1)} hr
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            Resting HR {formatHealthStat(dashboard.health_summary.today_entry?.resting_heart_rate)} bpm
                          </div>
                        </div>
                        <div className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">Movement</div>
                          <div className="mt-2 text-2xl font-semibold text-white">
                            {movementEntries[0] ? formatDistanceMiles(movementEntries[0].total_distance_km, 1) : "--"}
                          </div>
                          <div className="mt-2 text-xs text-slate-400">
                            {movementEntries[0]
                              ? `${movementEntries[0].visited_places_count} visits · ${formatMinutes(movementEntries[0].time_away_minutes)} away`
                              : "Waiting for movement sync"}
                          </div>
                        </div>
                      </div>
                      <div className="rounded-[1.4rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(35,37,58,0.85))] p-4">
                        <div className="text-sm leading-6 text-slate-100">
                          {movementEntries[0]?.movement_story
                            ? movementEntries[0].movement_story
                            : `${dashboard.health_summary.streak_days} day movement streak, ${formatHealthStat(dashboard.health_summary.today_entry?.workouts)} workouts today, and ${dashboard.health_summary.recent_entries.length} synced health days available.`}
                        </div>
                        <Button
                          variant="outline"
                          className="mt-4 rounded-2xl"
                          onClick={() => setMode("health")}
                        >
                          Open full health view
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      Sync from the iPhone companion app to start showing Apple Health data here.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Mail className="h-5 w-5" />
                    Important mail
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {dashboard?.important_emails?.length ? (
                      dashboard.important_emails.map((item) => (
                        <button
                          key={item.message_id}
                          type="button"
                          onClick={() => void openOverviewEmail(item.message_id)}
                          className="w-full rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.9)]"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-100">{item.subject}</div>
                              <div className="mt-1 text-xs text-slate-400">{item.sender}</div>
                            </div>
                            <Badge
                              variant={
                                item.urgency === "high"
                                  ? "default"
                                  : item.urgency === "medium"
                                    ? "secondary"
                                    : "outline"
                              }
                              className="rounded-xl"
                            >
                              {item.urgency}
                            </Badge>
                          </div>
                          <div className="mt-3 rounded-[1rem] border border-cyan-300/16 bg-cyan-400/8 px-3 py-2 text-sm leading-6 text-slate-100">
                            {item.summary}
                          </div>
                          {item.why_it_matters ? (
                            <div className="mt-3 text-sm leading-6 text-slate-300">{item.why_it_matters}</div>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            {item.needs_reply ? (
                              <span className="rounded-full border border-fuchsia-300/25 bg-fuchsia-400/12 px-2.5 py-1 text-fuchsia-100">
                                Needs reply
                              </span>
                            ) : null}
                            {item.action_items.length ? (
                              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                                {item.action_items.length} action item{item.action_items.length === 1 ? "" : "s"}
                              </span>
                            ) : null}
                            {item.deadline_hint ? (
                              <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-1 text-cyan-100">
                                {item.deadline_hint}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-3 text-xs text-cyan-100">Open focused detail</div>
                        </button>
                      ))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading important mail..." : "No important mail surfaced yet."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Inbox className="h-5 w-5" />
                    News summary
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {dashboard?.news_items?.length ? (
                      dashboard.news_items.map((item, index) => (
                        <div
                          key={`${item.title}-${index}`}
                          className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                        >
                          <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            {item.source ? <span>{item.source}</span> : null}
                            {item.published_at ? (
                              <span>{formatScheduleDateTime(item.published_at)}</span>
                            ) : null}
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
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading news..." : "No news items available right now."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

            </div>
          </div>
        ) : mode === "jobs" ? (
          <div className="space-y-6">
            {/* header controls */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                {jobAlertsLoaded && !jobAlertsJob ? (
                  <p className="text-sm text-slate-400">
                    {jobAlertsFromEmails} email{jobAlertsFromEmails === 1 ? "" : "s"} scanned · {(jobAlerts ?? []).length} listing{(jobAlerts ?? []).length === 1 ? "" : "s"} scored ≥ 5
                  </p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {jobAlertsLoaded && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = !jobAlertsQualifiedOnly;
                      setJobAlertsQualifiedOnly(next);
                      const all = jobAlertsJob?.result?.items ?? jobAlerts ?? [];
                      setJobAlerts(next ? all.filter((j) => j.qualifies) : all);
                    }}
                    className={`rounded-2xl border px-3 py-1.5 text-sm transition ${
                      jobAlertsQualifiedOnly
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                    }`}
                  >
                    Qualified only
                  </button>
                )}
                <Button
                  variant="outline"
                  className="rounded-2xl"
                  disabled={jobAlertsJob?.status === "queued" || jobAlertsJob?.status === "running"}
                  onClick={() => void startJobAlerts(jobAlertsLoaded)}
                >
                  <RefreshCw className={`mr-2 h-4 w-4 ${jobAlertsJob?.status === "queued" || jobAlertsJob?.status === "running" ? "animate-spin" : ""}`} />
                  {jobAlertsLoaded ? "Re-scan" : "Scan emails"}
                </Button>
              </div>
            </div>

            {/* progress bar */}
            {(jobAlertsJob?.status === "queued" || jobAlertsJob?.status === "running") ? (
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardContent className="pt-6">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-300">
                        {jobAlertsJob.status === "queued" ? "Starting scan…" : `Scanning email ${(jobAlertsJob.processed ?? 0) + 1} of ${jobAlertsJob.total || "?"}`}
                      </span>
                      <span className="text-slate-400">
                        {jobAlertsJob.total ? `${Math.round(((jobAlertsJob.processed ?? 0) / jobAlertsJob.total) * 100)}%` : ""}
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-cyan-400 transition-all duration-500"
                        style={{ width: jobAlertsJob.total ? `${Math.round(((jobAlertsJob.processed ?? 0) / jobAlertsJob.total) * 100)}%` : "5%" }}
                      />
                    </div>
                    {jobAlertsJob.current_subject ? (
                      <p className="truncate text-xs text-slate-400">{jobAlertsJob.current_subject}</p>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            ) : null}

            {/* error */}
            {jobAlertsError ? (
              isGoogleAuthIssue(jobAlertsError) ? (
                <div className="flex flex-col gap-3 rounded-[1.4rem] border border-cyan-300/15 bg-cyan-400/10 p-4 text-sm text-cyan-50 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium text-white">
                      <ShieldCheck className="h-4 w-4 text-cyan-200" />
                      Google connection expired
                    </div>
                    <div className="mt-1 text-xs leading-5 text-cyan-100/85">Re-authorize Google to scan job alerts.</div>
                  </div>
                  <Button asChild variant="outline" className="rounded-2xl border-cyan-200/30 bg-white/5 text-cyan-50 hover:bg-white/10">
                    <a href={`${API_BASE}/google/oauth/start`}>Reconnect</a>
                  </Button>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>{jobAlertsError}</div>
                </div>
              )
            ) : null}

            {/* empty / not yet scanned */}
            {!jobAlertsLoaded && !jobAlertsJob ? (
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardContent className="pt-8 pb-10 text-center">
                  <Briefcase className="mx-auto mb-4 h-10 w-10 text-slate-500" />
                  <p className="text-sm text-slate-400">Hit <span className="text-white font-medium">Scan emails</span> to pull up to 30 of your most recent Job Alerts emails, score every listing with AI, and rank them by fit.</p>
                </CardContent>
              </Card>
            ) : (jobAlerts ?? []).length === 0 && jobAlertsLoaded ? (
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardContent className="pt-8 pb-10 text-center text-sm text-slate-400">
                  No listings scored ≥ 5 found. Make sure your Gmail label is named &ldquo;Job Alerts&rdquo; exactly.
                </CardContent>
              </Card>
            ) : null}

            {/* listings */}
            {(jobAlerts ?? []).length > 0 ? (
              <div className="space-y-3">
                {(jobAlerts ?? []).map((job) => (
                  <div
                    key={job.id}
                    className="rounded-[1.6rem] border border-white/6 bg-[rgba(17,19,34,0.82)] p-5 shadow-[0_8px_24px_rgba(6,7,14,0.24)]"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-base font-semibold text-slate-100">{job.title}</span>
                          {job.is_new && (
                            <span className="rounded-md bg-blue-500/20 px-1.5 py-0.5 text-xs font-semibold text-blue-300">New</span>
                          )}
                        </div>
                        <div className="mt-1 text-sm text-slate-400">
                          {job.company}
                          {job.location ? ` · ${job.location}` : ""}
                        </div>
                        {job.salary_range ? (
                          <div className="mt-1 text-xs text-slate-500">{job.salary_range}</div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <span
                          className={`rounded-xl px-2.5 py-0.5 text-sm font-semibold ${
                            job.relevance_score >= 8
                              ? "bg-emerald-500/20 text-emerald-200"
                              : "bg-amber-500/20 text-amber-200"
                          }`}
                        >
                          {job.relevance_score}/10
                        </span>
                        {job.qualifies ? (
                          <span className="rounded-xl bg-cyan-500/15 px-2 py-0.5 text-xs text-cyan-200">Qualifies</span>
                        ) : (
                          <span className="rounded-xl bg-white/5 px-2 py-0.5 text-xs text-slate-400">May not qualify</span>
                        )}
                      </div>
                    </div>
                    <p className="mt-3 text-sm leading-6 text-slate-300">{job.relevance_reason}</p>
                    {!job.qualifies && job.qualification_note ? (
                      <p className="mt-1.5 text-xs leading-5 text-slate-400">{job.qualification_note}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      <span className="truncate">{job.source_email_subject}</span>
                      {(() => { const ci = jobClosingInfo(job.closes_at); return ci ? <span className={ci.className}>{ci.label}</span> : null; })()}
                      {job.apply_url ? (
                        <a
                          href={job.apply_url}
                          target="_blank"
                          rel="noreferrer"
                          className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-cyan-300/20 bg-cyan-400/10 px-3 py-1.5 text-sm font-medium text-cyan-200 transition hover:bg-cyan-400/20"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Apply
                        </a>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : mode === "assistant" ? (
          <div className="space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Sparkles className="h-5 w-5" />
                      Ask Jarvis
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Ask questions across the data Jarvis already knows about you, including important mail, tasks, calendar, journal notes, health syncs, and movement history.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMode("dashboard")}
                  >
                    Back to dashboard
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <AssistantPanel apiBase={API_BASE} />
              </CardContent>
            </Card>
          </div>
        ) : mode === "health" ? (
          <HealthDetailPanel
            dashboard={dashboard}
            healthEntries={healthEntries}
            selectedHealthDate={selectedHealthDate}
            onSelectedHealthDateChange={setSelectedHealthDate}
            movementEntries={movementEntries}
            workoutEntries={workoutEntries}
            movementLoading={movementLoading}
            loading={loading}
            onBackToDashboard={() => setMode("dashboard")}
            onUseTrailForPlanner={(trail) => {
              setPlanningPrompt(buildTrailPlanningPrompt(trail));
              setScheduleWorkspaceTab("planner");
              setMode("schedule");
            }}
          />
        ) : mode === "news" ? (
          <div className="space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Newspaper className="h-5 w-5" />
                      News sources
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      These are the headlines currently feeding the dashboard&apos;s news summary.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMode("dashboard")}
                  >
                    Back to dashboard
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(56,189,248,0.16),rgba(35,37,58,0.92))] p-5">
                  <div className="text-xs uppercase tracking-[0.22em] text-cyan-100/80">
                    Dashboard news summary
                  </div>
                  <div className="mt-3 text-sm leading-7 text-slate-100">
                    {dashboard?.news_summary || (loading ? "Loading news summary..." : "No news summary yet.")}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Articles used</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 px-2 pr-4">
                  {dashboard?.news_items?.length ? (
                    dashboard.news_items.map((item, index) => (
                      <div
                        key={`${item.title}-${index}`}
                        className="rounded-[1.4rem] border border-white/6 bg-[rgba(35,37,58,0.72)] p-4"
                      >
                        <div className="text-sm font-semibold text-slate-100">{item.title}</div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                          {item.source ? <span>{item.source}</span> : null}
                          {item.published_at ? (
                            <span>{formatScheduleDateTime(item.published_at)}</span>
                          ) : null}
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
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      {loading ? "Loading news..." : "No news items available right now."}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        ) : mode === "settings" ? (
          <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <SlidersHorizontal className="h-5 w-5" />
                      Classification guidance
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Teach Jarvis what should count as important, unimportant, or action-worthy without crowding the main mail workflow.
                    </p>
                  </div>
                  {guidanceDirty ? (
                    <Badge variant="outline" className="rounded-xl">
                      Unsaved
                    </Badge>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <textarea
                  value={classificationGuidance}
                  onChange={(e) => setClassificationGuidance(e.target.value)}
                  placeholder="Example: Treat messages from professors, BYU admin, job opportunities, bills, deadlines, and personal messages as important. Treat newsletters, login alerts, and generic marketing as unimportant."
                  className="min-h-[240px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                />
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                  <span>
                    Saved guidance is included in future AI classification prompts. Cached emails refresh as they are reclassified.
                  </span>
                  <span>
                    {classificationGuidanceUpdatedAt
                      ? `Updated ${new Date(classificationGuidanceUpdatedAt).toLocaleString()}`
                      : "Not customized yet"}
                  </span>
                </div>
                <div className="flex justify-end">
                  <Button
                    className="rounded-2xl"
                    onClick={() => void saveClassificationGuidance()}
                    disabled={guidanceLoading || guidanceSaving || !guidanceDirty}
                  >
                    {guidanceSaving ? "Saving..." : "Save guidance"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <div className="space-y-6">
              {utilitiesPanel}
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Why This Is Separate</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm leading-6 text-slate-300">
                  <p>
                    Mail review stays faster when guidance-writing and inbox-wide maintenance are not competing for attention inside the same pane.
                  </p>
                  <p>
                    This page is meant for configuration and bulk actions. Day-to-day triage can stay focused on reading, handling, and correcting individual conversations.
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : mode === "tasks" ? (
          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <ShieldCheck className="h-5 w-5" />
                  Add task
                </CardTitle>
                <p className="text-sm leading-6 text-slate-300">
                  Create a task or clean up an existing one. Changes persist and also show up on the dashboard.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <Input
                  value={newTaskTitle}
                  onChange={(e) => setNewTaskTitle(e.target.value)}
                  className="rounded-xl"
                  placeholder="Task title"
                />
                <textarea
                  value={newTaskDetail}
                  onChange={(e) => setNewTaskDetail(e.target.value)}
                  className="min-h-[120px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                  placeholder="Details or notes"
                />
                <div className="space-y-2">
                  <div className="grid gap-3 md:grid-cols-[1fr_1fr_150px]">
                    <Input
                      type="datetime-local"
                      value={newTaskDueAt}
                      onChange={(e) => setNewTaskDueAt(e.target.value)}
                      className="rounded-xl"
                    />
                    <Input
                      value={newTaskDueNote}
                      onChange={(e) => setNewTaskDueNote(e.target.value)}
                      className="rounded-xl"
                      placeholder="Or a quick due note"
                    />
                    <select
                      value={newTaskPriority}
                      onChange={(e) => setNewTaskPriority(e.target.value as "high" | "medium" | "low")}
                      className="h-10 w-full rounded-xl border border-white/8 bg-[rgba(20,22,37,0.88)] px-3 text-sm text-slate-100 outline-none"
                    >
                      <option value="high">high priority</option>
                      <option value="medium">medium priority</option>
                      <option value="low">low priority</option>
                    </select>
                  </div>
                  <p className="text-xs text-slate-400">
                    Pick an exact time when you have one, or leave a simple note like &quot;after class&quot;.
                  </p>
                </div>
                <Button
                  className="w-full rounded-2xl"
                  onClick={() => void createTaskItem()}
                  disabled={taskCreateLoading || !newTaskTitle.trim()}
                >
                  {taskCreateLoading ? "Creating..." : "Add task"}
                </Button>
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="flex flex-col gap-4 pb-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ShieldCheck className="h-5 w-5" />
                      Active tasks
                    </CardTitle>
                    <p className="mt-2 text-sm text-slate-400">
                      Undated tasks stay visible in every view so they do not disappear.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={taskWindow === "today" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("today")}
                    >
                      Today
                    </Button>
                    <Button
                      size="sm"
                      variant={taskWindow === "this_week" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("this_week")}
                    >
                      This week
                    </Button>
                    <Button
                      size="sm"
                      variant={taskWindow === "next_week" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setTaskWindow("next_week")}
                    >
                      Next week
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {filteredActiveTasks.length ? (
                      filteredActiveTasks.map((task) => renderTaskCard(task))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        {loading ? "Loading tasks..." : "No active tasks in this window."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg">Completed</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {filteredCompletedTasks.length ? (
                      filteredCompletedTasks.map((task) => renderTaskCard(task, true))
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No completed tasks in this window.
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : mode === "journal" ? (
          <div className="mx-auto w-full max-w-6xl space-y-6">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <BookOpen className="h-5 w-5" />
                      Journal archive
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      Browse recent days or jump into saved entries without rendering your whole history at once.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={!journalSavedOnly ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => void toggleJournalArchiveMode(false)}
                    >
                      Recent timeline
                    </Button>
                    <Button
                      size="sm"
                      variant={journalSavedOnly ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => void toggleJournalArchiveMode(true)}
                    >
                      Journaled days
                    </Button>
                    <Button
                      size="sm"
                      variant={journalHeatmapOpen ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => {
                        setJournalHeatmapOpen((open) => !open);
                        if (!journalHeatmap) void loadJournalHeatmap();
                      }}
                    >
                      <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
                      Heatmap
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {journalHeatmapOpen ? (
                  <div className="rounded-[1.4rem] border border-white/8 bg-[rgba(20,22,37,0.55)] p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                        Journaled days
                      </div>
                      {journalHeatmap ? (
                        <div className="text-xs text-slate-500">
                          {journalHeatmap.length} day{journalHeatmap.length === 1 ? "" : "s"} journaled
                        </div>
                      ) : null}
                    </div>
                    {journalHeatmap === null ? (
                      <div className="text-sm text-slate-500">Loading heatmap…</div>
                    ) : journalHeatmap.length ? (
                      <JournalHeatmap days={journalHeatmap} onSelect={(date) => void jumpToJournalDate(date)} />
                    ) : (
                      <div className="text-sm text-slate-500">No journaled days yet.</div>
                    )}
                  </div>
                ) : null}
                <div className="flex flex-col gap-3 lg:flex-row">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      value={journalSearchInput}
                      onChange={(e) => setJournalSearchInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void applyJournalSearch();
                        }
                      }}
                      className="h-11 rounded-2xl pl-9"
                      placeholder="Search dates, reflections, gratitude, or world events"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      className="rounded-2xl"
                      onClick={() => void applyJournalSearch()}
                    >
                      Search
                    </Button>
                    <Button
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void clearJournalSearch()}
                      disabled={!journalQuery && !journalSearchInput && !journalSavedOnly}
                    >
                      Reset
                    </Button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xs uppercase tracking-wide text-slate-500">Jump to</span>
                  <JournalDatePicker
                    value={journalJumpDate}
                    max={formatLocalDateKey(new Date())}
                    entryDates={journalEntryDateSet}
                    onSelect={(date) => void jumpToJournalDate(date)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => {
                      void loadJournal({ before: null, history: [] });
                      setJournalJumpDate(null);
                    }}
                    disabled={loading}
                  >
                    Today
                  </Button>
                </div>

                <div className="flex flex-col gap-3 text-sm text-slate-300 md:flex-row md:items-center md:justify-between">
                  <div>
                    {journalQuery
                      ? `Showing ${journal?.entries.length || 0} of ${journal?.total_entries || 0} saved entries matching "${journalQuery}".`
                      : journalSavedOnly
                        ? `Showing ${journal?.entries.length || 0} days with journal entries.`
                        : `Showing ${journal?.entries.length || 0} recent days at a time so the journal stays fast to navigate.`}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void loadNewerJournalEntries()}
                      disabled={!journalHistory.length || loading}
                    >
                      Newer
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => void loadOlderJournalEntries()}
                      disabled={!journal?.has_more || loading}
                    >
                      Older
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            {error ? (
              <div className="flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                <AlertCircle className="mt-0.5 h-4 w-4" />
                <div>{error}</div>
              </div>
            ) : null}
            {journal?.entries?.length ? (
              <div className="grid items-start gap-4 lg:grid-cols-2">
              {journal.entries.map((entry) => {
                const draft = journalDrafts[entry.date] || {
                  journal_entry: entry.journal_entry || "",
                  accomplishments: entry.accomplishments || "",
                  gratitude_entry: entry.gratitude_entry || "",
                  scripture_study: entry.scripture_study || "",
                  spiritual_notes: entry.spiritual_notes || "",
                  photo_data_url: entry.photo_data_url || null,
                  calendar_items: entry.calendar_items || [],
                };
                const sectionState = journalSectionState[entry.date] || {
                  dayOpen: false,
                  calendarOpen: false,
                  articlesOpen: false,
                };
                const isEditingJournalEntry = journalEditingDate === entry.date;
                const hasContext = !!(entry.calendar_summary || entry.world_event_title);
                const contextOneLiner = [
                  entry.calendar_summary ? entry.calendar_summary.split(".")[0] : null,
                  entry.world_event_title ?? null,
                ].filter(Boolean).join(" · ");
                // A day is "filled" only when the user authored content (matches the
                // backend _content_clause); auto calendar/news context doesn't count.
                const wordCount = [
                  draft.journal_entry,
                  draft.accomplishments,
                  draft.gratitude_entry,
                  draft.scripture_study,
                  draft.spiritual_notes,
                ].join(" ").trim().split(/\s+/).filter(Boolean).length;
                const hasPhoto = !!draft.photo_data_url;
                const hasEntry = wordCount > 0 || hasPhoto;
                const previewBody =
                  draft.journal_entry.trim() ||
                  draft.gratitude_entry.trim() ||
                  draft.accomplishments.trim() ||
                  draft.spiritual_notes.trim();

                return (
                  <Card
                    key={entry.date}
                    id={`journal-entry-${entry.date}`}
                    className={[
                      "transition",
                      // Filled days get the substantial card; empty days collapse to a
                      // compact single-line row (override the component's default py-4).
                      hasEntry
                        ? "rounded-[2rem] bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl"
                        : "rounded-2xl bg-[rgba(17,19,34,0.4)] py-1",
                      entry.date === journalJumpDate
                        ? "border border-violet-300/45 ring-1 ring-violet-400/40"
                        : hasEntry
                          ? "border border-white/8 hover:border-violet-300/25"
                          : "border border-white/5 hover:border-white/12",
                      // An opened card spans the full width so editing isn't cramped in one column.
                      sectionState.dayOpen ? "lg:col-span-2" : "",
                    ].join(" ")}
                  >
                    {/* Day header — with snippet preview when collapsed */}
                    <CardHeader className={hasEntry ? "pb-3" : "py-0"}>
                      <button
                        type="button"
                        onClick={() => toggleJournalSection(entry.date, "dayOpen")}
                        className={`flex w-full justify-between gap-3 rounded-2xl text-left outline-none transition focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-300/40 ${hasEntry ? "items-start" : "items-center"}`}
                      >
                        <div className="min-w-0 flex-1">
                          <CardTitle
                            className={
                              hasEntry
                                ? "flex items-center gap-2 text-lg"
                                : "flex items-center gap-2 text-sm font-medium text-slate-500"
                            }
                          >
                            <BookOpen className={hasEntry ? "h-5 w-5 shrink-0" : "h-4 w-4 shrink-0 text-slate-600"} />
                            <span>{highlightJournalSearchText(entry.date_label, journalQuery)}</span>
                            {hasEntry ? (
                              <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-violet-300/25 bg-violet-400/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-violet-100">
                                <span className="h-1.5 w-1.5 rounded-full bg-violet-300" />
                                {wordCount > 0 ? `${wordCount} word${wordCount === 1 ? "" : "s"}` : "Photo"}
                              </span>
                            ) : (
                              <span className="ml-1 text-xs font-normal text-slate-600">No entry</span>
                            )}
                          </CardTitle>
                          {!sectionState.dayOpen && hasEntry ? (
                            <div className="mt-2 space-y-1">
                              {draft.scripture_study.trim() ? (
                                <p className="truncate text-xs text-slate-400">
                                  <span className="mr-1.5 text-slate-500">📖</span>
                                  {draft.scripture_study.trim()}
                                </p>
                              ) : null}
                              {previewBody ? (
                                <p className="line-clamp-2 text-xs leading-5 text-slate-500">
                                  {previewBody}
                                </p>
                              ) : null}
                            </div>
                          ) : sectionState.dayOpen && entry.updated_at ? (
                            <p className="mt-1 text-xs text-slate-500">
                              Saved {new Date(entry.updated_at).toLocaleString()}
                            </p>
                          ) : null}
                        </div>
                        {sectionState.dayOpen ? (
                          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                        ) : (
                          <ChevronRight className={`mt-1 h-4 w-4 shrink-0 ${hasEntry ? "text-slate-400" : "text-slate-600"}`} />
                        )}
                      </button>
                    </CardHeader>

                    {sectionState.dayOpen ? (
                      <CardContent className="space-y-5 pt-0">

                        {/* Context strip — calendar + news collapsed by default */}
                        {hasContext ? (
                          <div>
                            <button
                              type="button"
                              onClick={() => toggleJournalSection(entry.date, "calendarOpen")}
                              className="flex w-full items-center gap-2 rounded-[1rem] border border-white/6 bg-[rgba(255,255,255,0.03)] px-3 py-2.5 text-left transition hover:bg-[rgba(255,255,255,0.05)]"
                            >
                              <div className="flex shrink-0 items-center gap-1.5 text-slate-500">
                                {entry.calendar_summary ? <span className="text-xs">📅</span> : null}
                                {entry.world_event_title ? <span className="text-xs">🌍</span> : null}
                              </div>
                              <p className="flex-1 truncate text-xs text-slate-400">{contextOneLiner}</p>
                              {sectionState.calendarOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                              )}
                            </button>

                            {sectionState.calendarOpen ? (
                              <div className="mt-2 space-y-4 rounded-[1.2rem] border border-white/6 bg-[rgba(35,37,58,0.55)] p-4">
                                {/* Calendar items */}
                                {entry.calendar_summary ? (
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                      <div className="text-xs uppercase tracking-wide text-slate-500">Calendar</div>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-7 rounded-xl px-2.5 text-xs"
                                        onClick={() =>
                                          void updateJournalCalendarItems(entry.date, (items) => [
                                            ...items,
                                            { event_id: `custom-${entry.date}-${items.length}`, title: "", start: entry.date, end: null, is_all_day: true, location: null, description: null, html_link: null, removed: false },
                                          ])
                                        }
                                      >
                                        <Plus className="mr-1 h-3 w-3" /> Add
                                      </Button>
                                    </div>
                                    {draft.calendar_items.length ? (
                                      <div className="space-y-2">
                                        {draft.calendar_items.map((item, itemIndex) => (
                                          <div
                                            key={`${item.event_id}-${itemIndex}`}
                                            className={`flex items-center gap-2 rounded-[0.8rem] border px-3 py-2 text-sm ${
                                              item.removed
                                                ? "border-dashed border-white/8 text-slate-500"
                                                : "border-violet-300/15 bg-violet-400/8 text-slate-200"
                                            }`}
                                          >
                                            <Input
                                              value={item.title}
                                              onChange={(e) =>
                                                setJournalDrafts((current) => {
                                                  const d = current[entry.date] || draft;
                                                  return { ...current, [entry.date]: { ...d, calendar_items: d.calendar_items.map((ci, ci2) => ci2 === itemIndex ? { ...ci, title: e.target.value } : ci) } };
                                                })
                                              }
                                              className="h-8 flex-1 rounded-lg border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
                                              placeholder="Event title"
                                            />
                                            <span className="shrink-0 text-xs text-slate-500">{formatScheduleTimeRange(item)}</span>
                                            <Button
                                              size="sm"
                                              variant="ghost"
                                              className="h-7 shrink-0 rounded-lg px-2 text-xs"
                                              onClick={() =>
                                                void updateJournalCalendarItems(entry.date, (items) => items.map((ci, ci2) => ci2 === itemIndex ? { ...ci, removed: !ci.removed } : ci), true)
                                              }
                                            >
                                              {item.removed ? "Restore" : "×"}
                                            </Button>
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <p className="text-xs text-slate-500">No calendar events for this day.</p>
                                    )}
                                  </div>
                                ) : null}

                                {/* World event */}
                                {entry.world_event_title ? (
                                  <div className="space-y-2">
                                    <div className="text-xs uppercase tracking-wide text-slate-500">World event</div>
                                    <p className="text-sm font-medium text-slate-100">
                                      {highlightJournalSearchText(entry.world_event_title, journalQuery)}
                                    </p>
                                    {entry.world_event_source ? (
                                      <p className="text-xs text-violet-300/70">{entry.world_event_source}</p>
                                    ) : null}
                                    {entry.world_event_summary ? (
                                      <p className="text-sm leading-6 text-slate-300">
                                        {highlightJournalSearchText(entry.world_event_summary, journalQuery)}
                                      </p>
                                    ) : null}
                                    {entry.world_event_articles?.length ? (
                                      <div>
                                        <button
                                          type="button"
                                          onClick={() => toggleJournalSection(entry.date, "articlesOpen")}
                                          className="flex items-center gap-1.5 text-xs text-slate-500 transition hover:text-slate-300"
                                        >
                                          {sectionState.articlesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                                          {entry.world_event_articles.length} articles
                                        </button>
                                        {sectionState.articlesOpen ? (
                                          <div className="mt-2 space-y-1.5">
                                            {entry.world_event_articles.map((article, index) =>
                                              article.link ? (
                                                <a key={`${article.title}-${index}`} href={article.link} target="_blank" rel="noreferrer"
                                                  className="block rounded-[0.8rem] border border-white/6 bg-[rgba(20,22,37,0.8)] px-3 py-2 text-xs text-slate-200 transition hover:border-violet-300/25">
                                                  {highlightJournalSearchText(article.title, journalQuery)}
                                                  <span className="ml-2 text-slate-500">{article.source}</span>
                                                </a>
                                              ) : (
                                                <div key={`${article.title}-${index}`}
                                                  className="rounded-[0.8rem] border border-white/6 bg-[rgba(20,22,37,0.8)] px-3 py-2 text-xs text-slate-200">
                                                  {highlightJournalSearchText(article.title, journalQuery)}
                                                </div>
                                              )
                                            )}
                                          </div>
                                        ) : null}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}

                        {/* Scripture study — primary section */}
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                              Scripture study
                            </div>
                            <div className="flex items-center gap-2">
                              {isEditingJournalEntry ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-xl px-2.5 text-xs"
                                  onClick={() => { const d = journalDrafts[entry.date]; if (d) void extractJournalCitations(entry.date, d); }}
                                  disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                                >
                                  {journalExtractingDate === entry.date ? "Extracting..." : "Extract citations"}
                                </Button>
                              ) : null}
                              {!isEditingJournalEntry ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 rounded-xl px-2.5 text-xs"
                                  onClick={() => setJournalEditingDate(entry.date)}
                                >
                                  Edit
                                </Button>
                              ) : null}
                              <Button
                                asChild
                                size="sm"
                                variant="outline"
                                className="h-7 rounded-xl px-2.5 text-xs"
                                disabled={journalScanningDate === entry.date}
                              >
                                <label className="cursor-pointer" title="Scan handwritten notes">
                                  {journalScanningDate === entry.date ? "Scanning…" : "Scan notes"}
                                  <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    className="hidden"
                                    disabled={journalScanningDate === entry.date}
                                    onChange={(e) => void scanJournalFromImage(entry.date, e)}
                                  />
                                </label>
                              </Button>
                            </div>
                          </div>
                          {isEditingJournalEntry ? (
                            <textarea
                              value={draft.scripture_study}
                              onChange={(e) => setJournalDrafts((c) => ({ ...c, [entry.date]: { ...draft, scripture_study: e.target.value } }))}
                              placeholder="What did you study today?"
                              className="min-h-[180px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-violet-300/40"
                            />
                          ) : (
                            <>
                              <JournalPreviewBlock
                                label="Study"
                                value={draft.scripture_study}
                                query={journalQuery}
                                placeholder="No study saved yet."
                                studyLinks={entry.study_links}
                              />
                              {entry.study_links.length ? (
                                <div className="flex flex-wrap gap-2">
                                  {entry.study_links.map((link) => (
                                    <a
                                      key={`${link.label}-${link.url}`}
                                      href={link.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-2 rounded-full border border-violet-300/20 bg-violet-400/10 px-3 py-1 text-xs text-violet-100 transition hover:text-violet-50"
                                    >
                                      {link.label}
                                      <span className="rounded-full border border-white/10 bg-white/8 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-300">
                                        {link.confidence === "exact" ? "Exact" : "Likely"}
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              ) : null}
                              {draft.spiritual_notes.trim() ? (
                                <div className="rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.55)] px-4 py-3 text-sm leading-6 text-slate-200">
                                  <div className="whitespace-pre-wrap break-words">
                                    {highlightJournalTextWithReferences(draft.spiritual_notes, journalQuery, entry.study_links)}
                                  </div>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>

                        {/* Journal entry — primary section */}
                        <div className="space-y-3">
                          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                            Journal
                          </div>
                          {isEditingJournalEntry ? (
                            <textarea
                              value={draft.journal_entry}
                              onChange={(e) => setJournalDrafts((c) => ({ ...c, [entry.date]: { ...draft, journal_entry: e.target.value } }))}
                              placeholder="What's on your mind?"
                              className="min-h-[200px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                            />
                          ) : (
                            <JournalPreviewBlock
                              label="Journal entry"
                              value={draft.journal_entry}
                              query={journalQuery}
                              placeholder="No journal entry saved yet."
                            />
                          )}
                        </div>

                        {/* Photo of the day */}
                        {/* TODO: Replace manual upload with photo database sync */}
                        {draft.photo_data_url ? (
                          <div className="space-y-2">
                            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">Photo of the day</div>
                            <div className="relative overflow-hidden rounded-[1.2rem]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={draft.photo_data_url}
                                alt={`Memory from ${entry.date_label}`}
                                className="w-full object-contain"
                                style={{ maxHeight: "360px" }}
                              />
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 rounded-xl px-2.5 text-xs"
                              onClick={() =>
                                setJournalDrafts((current) => ({
                                  ...current,
                                  [entry.date]: { ...(current[entry.date] || draft), photo_data_url: null },
                                }))
                              }
                            >
                              Remove photo
                            </Button>
                          </div>
                        ) : (
                          <Button asChild size="sm" variant="outline" className="h-7 rounded-xl px-2.5 text-xs">
                            <label className="cursor-pointer">
                              Add photo of the day
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => void handleJournalPhotoChange(entry.date, e)} />
                            </label>
                          </Button>
                        )}

                        {/* Language sessions — compact */}
                        {entry.language_sessions?.length ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs text-slate-500">Language:</span>
                            {Object.entries(
                              entry.language_sessions.reduce<Record<string, number>>((acc, s) => {
                                acc[s.language] = (acc[s.language] || 0) + s.minutes;
                                return acc;
                              }, {})
                            ).map(([lang, mins]) => (
                              <span key={lang} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs capitalize text-slate-300">
                                {lang} · {mins} min
                              </span>
                            ))}
                          </div>
                        ) : null}

                        {/* Save / edit actions */}
                        {isEditingJournalEntry ? (
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              className="rounded-2xl"
                              onClick={() => setJournalEditingDate(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              className="rounded-2xl"
                              onClick={() => void saveJournalEntry(entry.date)}
                              disabled={journalSavingDate === entry.date || journalExtractingDate === entry.date}
                            >
                              {journalSavingDate === entry.date ? "Saving..." : "Save"}
                            </Button>
                          </div>
                        ) : null}
                      </CardContent>
                    ) : null}
                  </Card>
                );
              })}
              </div>
            ) : (
              <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
                <CardContent className="p-6 text-sm text-slate-400">
                  {loading ? "Loading journal..." : "No journal entries available yet."}
                </CardContent>
              </Card>
            )}
          </div>
        ) : isSchedulePlannerMode ? (
          <div className="grid gap-6 lg:grid-cols-[320px_360px_1fr]">
            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={scheduleWorkspaceTab === "agenda" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setScheduleWorkspaceTab("agenda")}
                    >
                      Agenda
                    </Button>
                    <Button
                      size="sm"
                      variant={scheduleWorkspaceTab === "planner" ? "default" : "outline"}
                      className="rounded-2xl"
                      onClick={() => setScheduleWorkspaceTab("planner")}
                    >
                      Planner
                    </Button>
                  </div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Sparkles className="h-5 w-5" />
                    Planning brief
                  </CardTitle>
                </div>
                <p className="text-sm leading-6 text-slate-300">
                  Describe what you want to get done, and Jarvis will draft a realistic schedule around your existing calendar.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="text-xs uppercase tracking-wide text-slate-400">
                    Goals and constraints
                  </div>
                  <textarea
                    value={planningPrompt}
                    onChange={(e) => setPlanningPrompt(e.target.value)}
                    placeholder="Example: Finish the data structures assignment, prepare for Friday's interview, email my professor, grocery shop, and fit in gym time. I want my hardest work in the morning."
                    className="min-h-[240px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-fuchsia-400/50"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min="1"
                    max="14"
                    value={planningDays}
                    onChange={(e) => setPlanningDays(e.target.value)}
                    className="w-28 rounded-2xl"
                    placeholder="Days"
                  />
                  <div className="text-xs text-slate-400">Planning horizon</div>
                </div>
                <Button
                  className="w-full rounded-2xl"
                  onClick={() => void generatePlan()}
                  disabled={planningLoading}
                >
                  <Sparkles className="mr-2 h-4 w-4" />
                  {planningLoading ? "Generating plan..." : "Generate plan"}
                </Button>
                {planningJob && (planningJob.status === "queued" || planningJob.status === "running") ? (
                  <div className="rounded-[1.2rem] border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">
                    Jarvis is building your plan in the background. This can take a little longer now so it can use a stronger model.
                  </div>
                ) : null}
                {planningResult?.priorities?.length ? (
                  <div className="space-y-2">
                    <div className="text-xs uppercase tracking-wide text-slate-400">
                      Priority themes
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {planningResult.priorities.map((priority) => (
                        <Badge key={priority} variant="outline" className="rounded-xl">
                          {priority}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <CalendarDays className="h-5 w-5" />
                  Suggested schedule
                </CardTitle>
                <p className="text-sm leading-6 text-slate-300">
                  A day-by-day plan generated from your goals and current calendar commitments.
                </p>
              </CardHeader>
              <CardContent>
                {error ? (
                  <div className="mb-4 flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                    <AlertCircle className="mt-0.5 h-4 w-4" />
                    <div>{error}</div>
                  </div>
                ) : null}
                <ScrollArea className="h-[65vh] pr-3">
                  {planningResult && planningDayGroups.length > 0 ? (
                    <div className="space-y-4">
                      {planningDayGroups.map((group) => (
                        <div key={group.key} className="space-y-2">
                          <div className="sticky top-0 z-10 rounded-xl border border-white/8 bg-[rgba(20,22,37,0.94)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 backdrop-blur">
                            {group.label}
                          </div>
                          <div className="space-y-2">
                            {group.items.map((item) => (
                              <button
                                key={item.id}
                                type="button"
                                onClick={() => setSelectedId(item.id)}
                                className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
                                  selectedId === item.id
                                    ? "border-fuchsia-400/60 bg-[linear-gradient(135deg,rgba(189,147,249,0.18),rgba(35,37,58,0.96))]"
                                    : "border-white/8 bg-[rgba(29,31,50,0.75)]"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <div className="text-sm font-semibold text-slate-100">
                                      {item.title}
                                    </div>
                                    <div className="mt-1 text-sm text-cyan-100">
                                      {formatScheduleTimeRange(item)}
                                    </div>
                                  </div>
                                  <Badge variant="outline" className="rounded-xl">
                                    {item.priority}
                                  </Badge>
                                </div>
                                <div className="mt-2 text-xs text-slate-400">
                                  {item.kind.replaceAll("_", " ")}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      {planningLoading
                        ? "Planning job is running. Your schedule will appear here when it is ready."
                        : "Write out your goals for the day or week, then generate a plan."}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            <Card className="rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader>
                <CardTitle className="text-lg">Plan detail</CardTitle>
              </CardHeader>
              <CardContent>
                {planningResult ? (
                  <div className="space-y-4">
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="text-xs uppercase tracking-wide text-slate-400">
                        Plan summary
                      </div>
                      <div className="mt-2 text-sm leading-6 text-slate-200">
                        {planningResult.summary}
                      </div>
                      <div className="mt-3 text-sm leading-6 text-slate-300">
                        {planningResult.strategy}
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void createPlanningCalendarEvents(
                              highPriorityPlanningItems,
                              "High-priority blocks"
                            )
                          }
                          disabled={
                            planningBulkCalendarLoading || highPriorityPlanningItems.length === 0
                          }
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          Add high priority
                        </Button>
                        {selectedPlanningDayItems.length > 0 ? (
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void createPlanningCalendarEvents(
                                selectedPlanningDayItems,
                                selectedPlanningItem?.day_label || "Selected day"
                              )
                            }
                            disabled={planningBulkCalendarLoading}
                          >
                            <CalendarDays className="mr-2 h-4 w-4" />
                            Add selected day
                          </Button>
                        ) : null}
                      </div>
                      {planningBulkCalendarMessage ? (
                        <div className="mt-3 text-sm text-cyan-100">
                          {planningBulkCalendarMessage}
                        </div>
                      ) : null}
                    </div>
                    {selectedPlanningItem ? (
                      <div className="space-y-3">
                        <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                          <div className="text-xl font-semibold text-slate-100">
                            {selectedPlanningItem.title}
                          </div>
                          <div className="mt-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100">
                            {formatScheduleTimeRange(selectedPlanningItem)}
                          </div>
                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Starts
                              </div>
                              <div className="mt-1 text-sm text-slate-200">
                                {formatScheduleDateTime(selectedPlanningItem.start)}
                              </div>
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Ends
                              </div>
                              <div className="mt-1 text-sm text-slate-200">
                                {formatScheduleDateTime(selectedPlanningItem.end)}
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Badge variant="outline" className="rounded-xl">
                              {selectedPlanningItem.priority} priority
                            </Badge>
                            <Badge variant="outline" className="rounded-xl">
                              {selectedPlanningItem.kind.replaceAll("_", " ")}
                            </Badge>
                          </div>
                          <div className="mt-4 flex flex-wrap items-center gap-2">
                            <Button
                              className="rounded-2xl"
                              size="sm"
                              onClick={() => void createPlanningCalendarEvent()}
                              disabled={planningCalendarLoading}
                            >
                              <CalendarDays className="mr-2 h-4 w-4" />
                              {planningCalendarLoading ? "Creating..." : "Add to Calendar"}
                            </Button>
                            {planningCalendarLink ? (
                              <a
                                href={planningCalendarLink}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                              >
                                Open event
                              </a>
                            ) : null}
                          </div>
                          <div className="mt-4 text-sm leading-6 text-slate-200">
                            {selectedPlanningItem.rationale}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                        Generate a plan and select a block to inspect it here.
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                    Your generated plan details will appear here.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
        <div
          className={`grid gap-6 ${
            isScheduleAgendaMode
              ? "lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]"
              : mailSidebarOpen
                ? "xl:grid-cols-[240px_minmax(300px,360px)_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]"
                : "lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]"
          }`}
        >
          {!isScheduleWorkspaceMode && mailSidebarOpen ? (
            <div className="flex min-w-0 flex-col gap-4">
            <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <Mail className="h-5 w-5" />
                      Mailboxes
                    </CardTitle>
                    <p className="mt-2 text-sm leading-6 text-slate-300">
                      {isRawMailView
                        ? "Switch folders and labels like Gmail."
                        : isMailInsightsMode
                          ? "See saved AI insights for the selected mailbox without reclassifying everything."
                          : "Pick a folder or label, review AI summaries, then correct any mistakes."}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-2xl"
                    onClick={() => setMailSidebarOpen(false)}
                  >
                    Hide
                  </Button>
                </div>
              </CardHeader>

              <CardContent className="min-w-0 overflow-hidden">
                <ScrollArea className="max-h-[40vh] min-w-0">
                  <div className="space-y-2 pr-3">
                    {visibleMailboxLabels.map((label) => {
                      const active = selectedMailbox === label.name;
                      const count =
                        label.name === ALL_MAILBOX
                          ? undefined
                          : label.messages_unread > 0
                            ? label.messages_unread
                            : label.messages_total;
                      const visibleCount =
                        count !== undefined && count > 0 ? count : undefined;
                      const canRemove = !DEFAULT_VISIBLE_MAILBOXES.has(label.name);

                      return (
                        <div
                          key={label.id}
                          className={`grid min-w-0 items-center gap-2 ${
                            canRemove ? "grid-cols-[minmax(0,1fr)_2rem]" : "grid-cols-1"
                          }`}
                        >
                          <button
                            onClick={() => {
                              setSelectedMailbox(label.name);
                              if (label.name === ALL_MAILBOX) {
                              if (mode === "mail" && mailView === "ai") {
                                setMailView("raw");
                              }
                              if (isMailInsightsMode) {
                                setMailWorkspaceTab("triage");
                                setMode("mail");
                                setMailView("raw");
                              }
                              }
                            }}
                            className={`flex min-w-0 w-full items-center justify-between overflow-hidden rounded-2xl border px-3 py-2 text-left transition ${
                              active
                                ? "border-fuchsia-400/60 bg-[linear-gradient(135deg,rgba(189,147,249,0.22),rgba(40,42,54,0.95))] text-white shadow-[0_10px_28px_rgba(12,12,24,0.36)]"
                                : "border-white/8 bg-[rgba(29,31,50,0.75)] text-slate-200 hover:border-cyan-300/30 hover:bg-[rgba(37,40,63,0.92)]"
                            }`}
                          >
                            <span className="truncate text-sm font-medium">
                              {label.name === JARVIS_REVIEW_MAILBOX
                                ? "Jarvis Review"
                                : label.name === ALL_MAILBOX
                                  ? "All Mail"
                                  : label.name}
                            </span>
                            {visibleCount !== undefined ? (
                              <span
                                className={`ml-3 shrink-0 text-xs ${
                                  active ? "text-fuchsia-100" : "text-slate-400"
                                }`}
                              >
                                {visibleCount}
                              </span>
                            ) : null}
                          </button>

                          {canRemove ? (
                            <Button
                              size="icon"
                              variant="outline"
                              className="h-8 w-8 shrink-0 rounded-xl p-0"
                              onClick={() => {
                                setExtraVisibleMailboxes((current) =>
                                  current.filter((name) => name !== label.name)
                                );
                                if (selectedMailbox === label.name) {
                                  setSelectedMailbox(ALL_MAILBOX);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {hiddenMailboxLabels.length > 0 ? (
                    <div className="mt-4 space-y-2 border-t border-white/8 pt-4 pr-3">
                      <button
                        type="button"
                        onClick={() => setMailboxAddOpen((current) => !current)}
                        className="flex w-full items-center justify-between gap-3 text-left"
                      >
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Add To Sidebar
                        </div>
                        {mailboxAddOpen ? (
                          <ChevronDown className="h-4 w-4 text-slate-400" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-slate-400" />
                        )}
                      </button>
                      {mailboxAddOpen ? (
                        <div className="grid gap-2">
                          {hiddenMailboxLabels.map((label) => (
                            <Button
                              key={label.id}
                              size="sm"
                              variant="outline"
                              className="w-full min-w-0 justify-start overflow-hidden rounded-2xl"
                              onClick={() =>
                                setExtraVisibleMailboxes((current) =>
                                  current.includes(label.name) ? current : [...current, label.name]
                                )
                              }
                            >
                              <Plus className="mr-2 h-4 w-4 shrink-0" />
                              <span className="min-w-0 truncate">
                                {label.name === JARVIS_REVIEW_MAILBOX
                                  ? "Jarvis Review"
                                  : label.name === ALL_MAILBOX
                                    ? "All Mail"
                                    : label.name}
                              </span>
                            </Button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </ScrollArea>
              </CardContent>
            </Card>

            <MailRulesPanel />
            <MailCommandPanel />
            </div>
          ) : null}

          <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      {isScheduleWorkspaceMode ? (
                        <CalendarDays className="h-5 w-5" />
                      ) : (
                        <Mail className="h-5 w-5" />
                      )}
                      {isMailWorkspaceMode
                        ? selectedMailboxLabel?.name === JARVIS_REVIEW_MAILBOX
                          ? "Jarvis Review"
                          : selectedMailboxLabel?.name === ALL_MAILBOX
                            ? "All Mail"
                            : selectedMailboxLabel?.name || "Mailbox"
                        : isScheduleWorkspaceMode
                          ? "Schedule"
                        : classifiedBucket === "important"
                          ? "Important review"
                          : classifiedBucket === "unimportant"
                            ? "Unimportant review"
                            : "AI overview"}
                    </CardTitle>
                    {!isScheduleWorkspaceMode ? (
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        {isMailInsightsMode
                          ? "Saved AI trends and summaries for the selected mailbox."
                          : isRawMailView
                            ? "Browse loaded Gmail threads and adjust conversation state."
                            : "Review conversations on the left, then work the selected item in focused detail."}
                      </p>
                    ) : null}
                  </div>
                  {!isScheduleWorkspaceMode ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => setMailSidebarOpen((current) => !current)}
                    >
                      {mailSidebarOpen ? "Hide mailboxes" : "Show mailboxes"}
                    </Button>
                  ) : null}
                </div>

                {!isScheduleWorkspaceMode ? (
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search subject, sender, category..."
                      className="rounded-2xl pl-9"
                    />
                  </div>
                ) : null}
              </div>

              {isMailWorkspaceMode ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={mailWorkspaceTab === "insights" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => {
                      if (mailWorkspaceTab === "insights") {
                        setMailWorkspaceTab("triage");
                      } else {
                        if (selectedMailbox === ALL_MAILBOX || selectedMailbox === JARVIS_REVIEW_MAILBOX) {
                          setSelectedMailbox(IMPORTANT_LABEL);
                        }
                        setMailWorkspaceTab("insights");
                      }
                    }}
                  >
                    AI Report
                  </Button>
                </div>
              ) : null}

              {isScheduleWorkspaceMode ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={scheduleWorkspaceTab === "agenda" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setScheduleWorkspaceTab("agenda")}
                  >
                    Agenda
                  </Button>
                  <Button
                    size="sm"
                    variant={scheduleWorkspaceTab === "planner" ? "default" : "outline"}
                    className="rounded-2xl"
                    onClick={() => setScheduleWorkspaceTab("planner")}
                  >
                    Planner
                  </Button>
                </div>
              ) : null}

              {isMailWorkspaceMode ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    value={inboxLimit}
                    onChange={(e) => setInboxLimit(e.target.value)}
                    className="w-32 rounded-2xl"
                    placeholder={isRawMailView ? "Page size" : "Summary cap"}
                  />
                  <div className="text-xs text-slate-400">
                    {isRawMailView ? "Threads per page" : "Items to summarize"}
                  </div>
                </div>
              ) : null}

              {isScheduleAgendaMode ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    max="60"
                    value={scheduleDays}
                    onChange={(e) => setScheduleDays(e.target.value)}
                    className="w-28 rounded-2xl"
                    placeholder="Days"
                  />
                  <div className="text-xs text-slate-400">Days ahead</div>
                </div>
              ) : null}

              {isRawMailView ? (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-400">
                    Showing one row per loaded thread on this page.
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => {
                        const history = [...rawPageHistory];
                        const previousToken = history.pop() ?? null;
                        setRawPageHistory(history);
                        void loadEmails("mail", selectedMailbox, previousToken, "raw");
                      }}
                      disabled={loading || !rawHasPreviousPage}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="rounded-2xl"
                      onClick={() => {
                        if (!rawNextPageToken) return;
                        setRawPageHistory((current) => [...current, rawPageToken ?? ""]);
                        void loadEmails("mail", selectedMailbox, rawNextPageToken, "raw");
                      }}
                      disabled={loading || !rawNextPageToken}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </CardHeader>

            <CardContent className="min-w-0 overflow-hidden">
              {error ? (
                <div className="mb-4 flex items-start gap-3 rounded-[1.4rem] border border-rose-400/20 bg-rose-500/10 p-4 text-sm text-rose-200">
                  <AlertCircle className="mt-0.5 h-4 w-4" />
                  <div>{error}</div>
                </div>
              ) : null}

              <ScrollArea className="h-[65vh] w-full min-w-0 overflow-hidden pr-3">
                <div className="w-full min-w-0 max-w-full space-y-3 overflow-x-hidden">
                  {isMailInsightsMode ? (
                    overview ? (
                      <div className="space-y-4">
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Cached emails
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.total_cached}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Needs reply
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.needs_reply}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Action items
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.action_item_count}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Deadlines found
                            </div>
                            <div className="mt-1 text-2xl font-semibold">
                              {overview.deadlines_found}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Categories
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {Object.entries(overview.categories).map(([category, count]) => (
                                <Badge key={category} variant="outline" className="rounded-xl">
                                  {category.replaceAll("_", " ")}: {count}
                                </Badge>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Top senders
                            </div>
                            <div className="mt-3 space-y-2 text-sm text-slate-200">
                              {overview.top_senders.length === 0 ? (
                                <div className="text-slate-400">No cached sender data yet.</div>
                              ) : (
                                overview.top_senders.map((item) => (
                                  <div key={item.sender} className="flex items-center justify-between">
                                    <span className="truncate pr-4">{item.sender}</span>
                                    <span className="text-slate-400">{item.count}</span>
                                  </div>
                                ))
                              )}
                            </div>
                          </CardContent>
                        </Card>
                        <Card className="rounded-2xl shadow-none">
                          <CardContent className="p-4">
                            <div className="text-xs uppercase tracking-wide text-slate-400">
                              Actionable emails
                            </div>
                            <div className="mt-3 space-y-2 text-sm text-slate-200">
                              {overview.top_action_items.length === 0 ? (
                                <div className="text-slate-400">No saved action items yet.</div>
                              ) : (
                                overview.top_action_items.map((item) => (
                                  <button
                                    key={`${item.message_id}-${item.text}`}
                                    type="button"
                                    onClick={() => void openOverviewEmail(item.message_id)}
                                    className="w-full rounded-xl border border-white/6 bg-[rgba(35,37,58,0.78)] px-3 py-2 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(42,45,72,0.92)]"
                                  >
                                    <div className="text-sm text-slate-100">{item.text}</div>
                                    <div className="mt-1 text-xs text-slate-400">
                                      {item.subject} · {item.sender}
                                      {item.count > 1 ? ` · ${item.count} emails` : ""}
                                    </div>
                                  </button>
                                ))
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No cached overview yet. Click AI Report on this mailbox to build it.
                      </div>
                    )
                  ) : null}

                  {isScheduleAgendaMode ? (
                    agenda && agenda.items.length > 0 ? (
                      <div className="space-y-4">
                        {agendaDayGroups.map((group) => (
                          <div key={group.key} className="space-y-2">
                            <div className="sticky top-0 z-10 rounded-xl border border-white/8 bg-[rgba(20,22,37,0.94)] px-3 py-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 backdrop-blur">
                              {group.label}
                            </div>
                            <div className="space-y-2">
                              {group.items.map((item) => (
                                <button
                                  key={item.event_id}
                                  onClick={() => setSelectedId(item.event_id)}
                                  className={`w-full rounded-2xl border p-4 text-left transition hover:shadow-sm ${
                                    selectedId === item.event_id
                                      ? "border-cyan-300/40 bg-[linear-gradient(135deg,rgba(139,233,253,0.18),rgba(35,37,58,0.96))]"
                                      : "border-white/8 bg-[rgba(29,31,50,0.75)]"
                                  }`}
                                >
                                  <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-semibold text-slate-100">
                                        {item.title}
                                      </div>
                                      <div className="mt-1 text-sm text-cyan-100">
                                        {formatScheduleTimeRange(item)}
                                      </div>
                                      {item.location ? (
                                        <div className="mt-1 text-xs text-slate-400">
                                          {item.location}
                                        </div>
                                      ) : null}
                                    </div>
                                    <Badge variant="outline" className="rounded-xl">
                                      {item.is_all_day ? "All day" : "Timed"}
                                    </Badge>
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                        No upcoming events found.
                      </div>
                    )
                  ) : null}

                  {!isMailInsightsMode &&
                  !isScheduleWorkspaceMode &&
                  displayEmails.length === 0 &&
                  !loading &&
                  !cleanupLoading ? (
                    <div className="rounded-[1.6rem] border border-dashed border-white/10 p-6 text-sm text-slate-400">
                      No emails found.
                    </div>
                  ) : null}
                  {!isMailInsightsMode && !isScheduleWorkspaceMode &&
                    displayEmails.map((email) => {
                    const threadCount = threadCountByEmailId.get(email.id) ?? 1;
                    return (
                      <div key={email.id} className="space-y-2">
                        <EmailListItem
                          email={email}
                          selected={selectedEmail?.id === email.id}
                          onClick={() => setSelectedId(email.id)}
                        />
                        {isRawMailView && threadCount > 1 ? (
                          <div className="px-3 text-xs text-zinc-500">
                            {threadCount} messages loaded in this thread
                          </div>
                        ) : null}
                      </div>
                    );
                    })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <Card className="min-w-0 rounded-[2rem] border border-white/8 bg-[rgba(17,19,34,0.82)] shadow-[0_16px_44px_rgba(6,7,14,0.36)] backdrop-blur-xl">
            <CardHeader>
              <CardTitle className="text-lg">
                {isMailInsightsMode
                  ? "Overview detail"
                  : isScheduleAgendaMode
                    ? "Event detail"
                    : "Email detail"}
              </CardTitle>
            </CardHeader>

            <CardContent>
              {isScheduleAgendaMode ? (
                <div className="space-y-4">
                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                    Upcoming events from your primary Google Calendar, organized as a day-by-day agenda.
                  </div>
                  <div className="rounded-[1.6rem] border border-cyan-300/15 bg-[linear-gradient(135deg,rgba(21,27,45,0.92),rgba(34,36,58,0.76))] p-4">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                      <Plus className="h-4 w-4" />
                      Quick add
                    </div>
                    <div className="mt-2 text-sm leading-6 text-slate-300">
                      Describe an event in plain English and add it straight to Google Calendar without a review step.
                    </div>
                    <textarea
                      value={quickCalendarPrompt}
                      onChange={(e) => setQuickCalendarPrompt(e.target.value)}
                      placeholder="Example: Lunch with Sam tomorrow at 12:30 PM at Aubergine Kitchen for 1 hour."
                      className="mt-4 min-h-[112px] w-full rounded-[1.2rem] border border-white/8 bg-[rgba(20,22,37,0.88)] px-4 py-3 text-sm leading-6 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                    />
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <Button
                        className="rounded-2xl"
                        onClick={() => void createQuickCalendarEvent()}
                        disabled={quickCalendarLoading || !quickCalendarPrompt.trim()}
                      >
                        <CalendarDays className="mr-2 h-4 w-4" />
                        {quickCalendarLoading ? "Adding..." : "Add directly to Calendar"}
                      </Button>
                      <div className="text-xs text-slate-400">
                        Best with a clear day and time.
                      </div>
                    </div>
                    {quickCalendarResult ? (
                      <div className="mt-4 rounded-[1.2rem] border border-emerald-300/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
                        <div className="font-medium text-emerald-50">
                          Added {quickCalendarResult.title || "event"} to Google Calendar.
                        </div>
                        <div className="mt-1 text-emerald-100/90">
                          {quickCalendarResult.start
                            ? formatScheduleDateTime(
                                quickCalendarResult.start,
                                quickCalendarResult.is_all_day
                              )
                            : "Scheduled"}
                          {quickCalendarResult.end && !quickCalendarResult.is_all_day
                            ? ` - ${formatScheduleDateTime(quickCalendarResult.end)}`
                            : ""}
                        </div>
                        {quickCalendarResult.html_link ? (
                          <a
                            href={quickCalendarResult.html_link}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-sm text-emerald-50 underline decoration-emerald-200/40 underline-offset-4"
                          >
                            Open event
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  {agenda ? (
                    (() => {
                      if (!selectedAgendaEvent) {
                        return (
                          <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                            No event selected.
                          </div>
                        );
                      }

                      return (
                        <div className="space-y-3">
                          <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                            <div className="text-xl font-semibold text-slate-100">
                              {selectedAgendaEvent.title}
                            </div>
                            <div className="mt-3 inline-flex items-center rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.18em] text-cyan-100">
                              {formatScheduleTimeRange(selectedAgendaEvent)}
                            </div>
                            <div className="mt-4 grid gap-3 md:grid-cols-2">
                              <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">
                                  Starts
                                </div>
                                <div className="mt-1 text-sm text-slate-200">
                                  {formatScheduleDateTime(
                                    selectedAgendaEvent.start,
                                    selectedAgendaEvent.is_all_day
                                  )}
                                </div>
                              </div>
                              <div className="rounded-2xl border border-white/6 bg-[rgba(20,22,37,0.82)] p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">
                                  Ends
                                </div>
                                <div className="mt-1 text-sm text-slate-200">
                                  {selectedAgendaEvent.end
                                    ? formatScheduleDateTime(
                                        selectedAgendaEvent.end,
                                        selectedAgendaEvent.is_all_day
                                      )
                                    : selectedAgendaEvent.is_all_day
                                      ? "End of day"
                                      : "No end time"}
                                </div>
                              </div>
                            </div>
                            <div className="mt-4">
                              <Button
                                size="sm"
                                variant="outline"
                                className="rounded-2xl"
                                onClick={() => void createTaskFromCalendarItem(selectedAgendaEvent)}
                                disabled={calendarTaskLoadingId === selectedAgendaEvent.event_id}
                              >
                                {calendarTaskLoadingId === selectedAgendaEvent.event_id
                                  ? "Adding..."
                                  : "Create task from event"}
                              </Button>
                            </div>
                            {selectedAgendaEvent.location ? (
                              <div className="mt-4 text-sm text-slate-200">
                                <span className="font-medium text-slate-100">Location:</span>{" "}
                                {selectedAgendaEvent.location}
                              </div>
                            ) : null}
                            {selectedAgendaEvent.description ? (
                              <div className="mt-3 text-sm text-slate-200">
                                {selectedAgendaEvent.description}
                              </div>
                            ) : null}
                            {selectedAgendaEvent.html_link ? (
                              <a
                                href={selectedAgendaEvent.html_link}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-3 inline-block text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                              >
                                Open in Google Calendar
                              </a>
                            ) : null}
                          </div>
                        </div>
                      );
                    })()
                  ) : null}
                </div>
              ) : isMailInsightsMode ? (
                <div className="space-y-4">
                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                    Saved AI summaries are reused here so this tab can show trends without
                    rerunning the classifier on every message.
                  </div>
                  {overview ? (
                    <div className="space-y-3">
                      <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Urgency mix
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {Object.entries(overview.urgency).map(([level, count]) => (
                            <Badge key={level} variant="outline" className="rounded-xl">
                              {level}: {count}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                        <div className="text-xs uppercase tracking-wide text-slate-400">
                          Time-sensitive emails
                        </div>
                        <div className="mt-3 space-y-2 text-sm text-slate-200">
                          {overview.deadline_highlights.length === 0 ? (
                            <div className="text-slate-400">No saved deadline hints yet.</div>
                          ) : (
                            overview.deadline_highlights.map((deadline) => (
                              <button
                                key={`${deadline.message_id}-${deadline.text}`}
                                type="button"
                                onClick={() => void openOverviewEmail(deadline.message_id)}
                                className="w-full rounded-xl border border-white/6 bg-[rgba(20,22,37,0.85)] px-3 py-2 text-left transition hover:border-cyan-300/30 hover:bg-[rgba(32,35,57,0.96)]"
                              >
                                <div className="text-sm text-slate-100">{deadline.text}</div>
                                <div className="mt-1 text-xs text-slate-400">
                                  {deadline.subject} · {deadline.sender}
                                </div>
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : !selectedEmail ? (
                <div className="rounded-[1.6rem] border border-dashed border-white/10 p-8 text-sm text-slate-400">
                  Select an email to view details.
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="rounded-[1.8rem] border border-cyan-300/14 bg-[linear-gradient(135deg,rgba(56,189,248,0.12),rgba(35,37,58,0.92))] p-5">
                    <div className="text-xs uppercase tracking-[0.2em] text-cyan-100/80">
                      Message focus
                    </div>
                    <h2 className="mt-3 text-2xl font-semibold leading-tight text-slate-100">
                      {decodeHtmlEntities(selectedEmail.subject) || "(No subject)"}
                    </h2>
                    <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-200">
                        {decodeHtmlEntities(selectedEmail.sender) || "Unknown sender"}
                      </span>
                      {selectedEmail.date ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                          {selectedEmail.date}
                        </span>
                      ) : null}
                      {isByuEmail(selectedEmail) ? (
                        <span className="rounded-full border border-sky-300/25 bg-sky-500/14 px-2.5 py-1 text-sky-100">
                          BYU forwarded mail
                        </span>
                      ) : null}
                      {isRawMailView && selectedThreadCount > 1 ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-300">
                          {selectedThreadCount} messages in loaded thread
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                    <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                      Quick actions
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {canMarkHandled ? (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void markHandled()}
                          disabled={handleLoading}
                        >
                          {handleLoading ? "Marking..." : "Mark handled"}
                        </Button>
                      ) : null}
                      {selectedEmail ? (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void trashEmail()}
                          disabled={emailActionLoading}
                          title="Move to trash"
                        >
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          {emailActionLoading ? "Deleting..." : "Delete"}
                        </Button>
                      ) : null}
                      {isAiMailView ? (
                        <>
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() => void correctClassification("important")}
                            disabled={emailActionLoading || !canMarkImportant}
                          >
                            Mark Jarvis Important
                          </Button>
                          <Button
                            className="rounded-2xl"
                            size="sm"
                            variant="outline"
                            onClick={() => void correctClassification("unimportant")}
                            disabled={emailActionLoading || !canMarkUnimportant}
                          >
                            Mark Jarvis Unimportant
                          </Button>
                        </>
                      ) : null}
                      {!calendarPreview ? (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void loadCalendarPreview(selectedEmail.id)}
                          disabled={calendarLoading}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarLoading ? "Loading..." : "Generate calendar suggestion"}
                        </Button>
                      ) : (
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void createCalendarEvent()}
                          disabled={calendarCreateLoading || !calendarPreview.start}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarCreateLoading ? "Creating..." : "Add to Calendar"}
                        </Button>
                      )}
                    </div>
                    <div className="mt-3 text-xs text-slate-400">
                      {canMarkHandled
                        ? "Handled marks the conversation reviewed and clears Jarvis importance labels."
                        : calendarPreview
                          ? "Quick actions now include calendar follow-through once a suggestion exists."
                          : "Use quick actions to correct the Jarvis bucket or generate a calendar suggestion."}
                    </div>
                  </div>

                  {selectedEmail.classification?.short_summary ||
                  selectedEmail.classification?.why_it_matters ||
                  selectedEmail.classification?.action_items?.length ||
                  selectedEmail.classification?.deadline_hint ||
                  selectedEmail.classification?.suggested_reply ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                        AI reading
                      </div>
                      {selectedEmail.classification?.short_summary ? (
                        <div className="rounded-[1rem] border border-cyan-300/16 bg-cyan-400/8 px-4 py-3 text-sm leading-6 text-slate-100">
                          {selectedEmail.classification.short_summary}
                        </div>
                      ) : null}
                      {selectedEmail.classification?.why_it_matters ? (
                        <div className="mt-3 text-sm leading-6 text-slate-300">
                          {selectedEmail.classification.why_it_matters}
                        </div>
                      ) : null}
                      {selectedEmail.classification?.action_items?.length ? (
                        <div className="mt-4 space-y-2">
                          {selectedEmail.classification.action_items.map((item) => (
                            <div
                              key={item}
                              className="rounded-xl border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-2 text-sm text-slate-200"
                            >
                              {item}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {(selectedEmail.classification?.deadline_hint ||
                        selectedEmail.classification?.suggested_reply) ? (
                        <div className="mt-4 grid gap-3 md:grid-cols-2">
                          {selectedEmail.classification?.deadline_hint ? (
                            <div className="rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-3">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Deadline hint
                              </div>
                              <div className="mt-1 text-sm text-slate-100">
                                {selectedEmail.classification.deadline_hint}
                              </div>
                            </div>
                          ) : null}
                          {selectedEmail.classification?.suggested_reply ? (
                            <div className="rounded-[1rem] border border-white/6 bg-[rgba(20,22,37,0.82)] px-3 py-3">
                              <div className="text-xs uppercase tracking-wide text-slate-400">
                                Suggested reply
                              </div>
                              <div className="mt-1 text-sm text-slate-100">
                                {selectedEmail.classification.suggested_reply}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {isRawMailView ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 text-xs uppercase tracking-wide text-slate-400">
                        Conversation actions
                      </div>
                      <div className="mb-3 text-sm text-slate-300">
                        These actions apply to every loaded message in this Gmail thread.
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void updateSelectedEmail({ archive: isInInbox })}
                          disabled={emailActionLoading}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          {isInInbox ? "Archive" : "Move to inbox"}
                        </Button>
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          variant="outline"
                          onClick={() => void updateSelectedEmail({ unread: !isUnread })}
                          disabled={emailActionLoading}
                        >
                          {isUnread ? "Mark read" : "Mark unread"}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {calendarLoading ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm text-slate-300">
                      Loading calendar suggestion...
                    </div>
                  ) : null}

                  {calendarPreview ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-3 flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                        <CalendarDays className="h-4 w-4" />
                        Calendar suggestion
                      </div>
                      <div className="space-y-2 text-sm text-slate-200">
                        <div>
                          <span className="font-medium text-slate-100">Title:</span>{" "}
                          {calendarPreview.title || "Untitled event"}
                        </div>
                        {calendarPreview.start ? (
                          <div>
                            <span className="font-medium text-slate-100">Start:</span>{" "}
                            {calendarPreview.start}
                          </div>
                        ) : null}
                        {calendarPreview.end ? (
                          <div>
                            <span className="font-medium text-slate-100">End:</span>{" "}
                            {calendarPreview.end}
                          </div>
                        ) : null}
                        {calendarPreview.location ? (
                          <div>
                            <span className="font-medium text-slate-100">Location:</span>{" "}
                            {calendarPreview.location}
                          </div>
                        ) : null}
                        {calendarPreview.notes ? (
                          <div>
                            <span className="font-medium text-slate-100">Notes:</span>{" "}
                            {calendarPreview.notes}
                          </div>
                        ) : null}
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Button
                          className="rounded-2xl"
                          size="sm"
                          onClick={() => void createCalendarEvent()}
                          disabled={calendarCreateLoading || !calendarPreview.start}
                        >
                          <CalendarDays className="mr-2 h-4 w-4" />
                          {calendarCreateLoading ? "Creating..." : "Add to Calendar"}
                        </Button>
                        {calendarCreateLink ? (
                          <a
                            href={calendarCreateLink}
                            target="_blank"
                            rel="noreferrer"
                            className="text-sm text-cyan-200 underline decoration-cyan-300/40 underline-offset-4"
                          >
                            Open event
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ) : null}

                  {isRawMailView ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <button
                        type="button"
                        onClick={() => setLabelSectionOpen((current) => !current)}
                        className="flex w-full items-center justify-between gap-3 text-left"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-slate-400">
                            <Tag className="h-4 w-4" />
                            Labels
                          </div>
                          <div className="mt-1 text-sm text-slate-300">
                            Review or adjust Gmail labels for this conversation.
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-slate-400">
                          <Badge variant="outline" className="rounded-xl">
                            {labelDraft.length}
                          </Badge>
                          {labelSectionOpen ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </div>
                      </button>
                      {labelSectionOpen ? (
                        <div className="mt-4">
                          <div className="mb-4 flex flex-wrap gap-2">
                            {editableLabels.map((label) => {
                              const checked = labelDraft.includes(label.name);
                              return (
                                <label
                                  key={label.id}
                                  className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm ${
                                    checked
                                      ? "border-cyan-300/40 bg-[rgba(56,189,248,0.14)] text-slate-100"
                                      : "border-white/8 bg-[rgba(20,22,37,0.82)] text-slate-300"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4"
                                    checked={checked}
                                    onChange={() => toggleDraftLabel(label.name)}
                                  />
                                  <span>{label.name}</span>
                                </label>
                              );
                            })}
                          </div>

                          <div className="flex flex-col gap-2 sm:flex-row">
                            <Input
                              value={newLabelName}
                              onChange={(e) => setNewLabelName(e.target.value)}
                              placeholder="Create and add a new label"
                              className="rounded-2xl"
                            />
                            <Button
                              className="rounded-2xl"
                              size="sm"
                              onClick={() => void applyLabelDraft()}
                              disabled={emailActionLoading}
                            >
                              <Plus className="mr-2 h-4 w-4" />
                              Apply labels
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {selectedEmail.cleanupDecision ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
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
                      <p className="text-sm text-slate-200">
                        {selectedEmail.cleanupDecision.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.classification ? (
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Category
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.category || "Unknown"}
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Importance
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.importance_score || "—"}/10
                          </div>
                        </CardContent>
                      </Card>

                      <Card className="rounded-2xl border border-white/6 bg-[rgba(35,37,58,0.7)] shadow-none">
                        <CardContent className="p-4">
                          <div className="text-xs uppercase tracking-wide text-slate-400">
                            Suggested action
                          </div>
                          <div className="mt-1 text-base font-medium text-slate-100">
                            {selectedEmail.classification.suggested_action || "—"}
                          </div>
                        </CardContent>
                      </Card>
                    </div>
                  ) : null}

                  {selectedEmail.classification?.reason ? (
                    <div className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="mb-1 text-xs uppercase tracking-wide text-slate-400">
                        Why it was classified this way
                      </div>
                      <p className="text-sm text-slate-200">
                        {selectedEmail.classification.reason}
                      </p>
                    </div>
                  ) : null}

                  {selectedEmail.labels?.length ? (
                    <div>
                      <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
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
                    <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
                      Snippet
                    </div>
                    <p className="rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4 text-sm leading-6 text-slate-200">
                      {decodeHtmlEntities(selectedEmail.snippet) || "No snippet available."}
                    </p>
                  </div>

                  <div>
                    <div className="mb-2 text-xs uppercase tracking-wide text-slate-400">
                      Body preview
                    </div>
                    <div className="max-h-[40vh] overflow-auto rounded-[1.6rem] border border-white/6 bg-[rgba(35,37,58,0.7)] p-4">
                      <div className="whitespace-pre-wrap text-sm leading-6 text-slate-200">
                        {decodeHtmlEntities(selectedEmail.body) || "No body text extracted."}
                      </div>
                      {selectedEmail.links?.length ? (
                        <div className="mt-4 border-t border-white/8 pt-4">
                          <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">
                            Message links
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {selectedEmail.links.map((link, index) => (
                              <Button
                                key={`${link.url}-${index}`}
                                asChild
                                variant={link.kind === "button" ? "default" : "outline"}
                                size="sm"
                                className="rounded-2xl"
                              >
                                <a href={link.url} target="_blank" rel="noreferrer">
                                  <ExternalLink className="mr-2 h-4 w-4" />
                                  {decodeHtmlEntities(link.label) || "Open link"}
                                </a>
                              </Button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="rounded-[1.6rem] border border-dashed border-white/10 bg-[rgba(20,22,37,0.45)] p-4 text-sm text-slate-400">
                    <div className="mb-2 flex items-center gap-2 font-medium text-slate-200">
                      <Trash2 className="h-4 w-4" />
                      Label &amp; archive actions
                    </div>
                    This panel supports folder browsing, archive state, unread state, relabeling, and moving messages to trash via the Delete button above.
                  </div>

                </div>
              )}
            </CardContent>
          </Card>
        </div>
        )}
      </div>
    </div>
  );
}

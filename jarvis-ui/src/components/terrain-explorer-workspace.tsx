"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { TrailExplorer3D } from "@/components/trail-explorer-3d";
import {
  type NearbyTrailItem,
  type PlannedRouteOverlay,
  type TerrainExplorerOption,
} from "@/components/terrain-explorer-session";
import { Button } from "@/components/ui/button";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api";
const MAX_TRAIL_SEARCH_SPAN_DEGREES = 0.35;

type TrailSearchResponse = {
  provider: string;
  count: number;
  items: NearbyTrailItem[];
};

function clampTrailSearchBounds(bounds: {
  min_lat: number;
  min_lon: number;
  max_lat: number;
  max_lon: number;
}) {
  const centerLat = (bounds.min_lat + bounds.max_lat) / 2;
  const centerLon = (bounds.min_lon + bounds.max_lon) / 2;
  const latSpan = Math.min(
    Math.max(bounds.max_lat - bounds.min_lat, 0.0005),
    MAX_TRAIL_SEARCH_SPAN_DEGREES
  );
  const lonSpan = Math.min(
    Math.max(bounds.max_lon - bounds.min_lon, 0.0005),
    MAX_TRAIL_SEARCH_SPAN_DEGREES
  );
  const halfLat = latSpan / 2;
  const halfLon = lonSpan / 2;

  return {
    min_lat: Math.max(-90, centerLat - halfLat),
    min_lon: Math.max(-180, centerLon - halfLon),
    max_lat: Math.min(90, centerLat + halfLat),
    max_lon: Math.min(180, centerLon + halfLon),
  };
}

async function getErrorMessage(response: Response, fallback: string) {
  try {
    const data = (await response.json()) as { detail?: string };
    return data.detail || fallback;
  } catch {
    return fallback;
  }
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

function trailToOverlay(trail: NearbyTrailItem): PlannedRouteOverlay {
  return {
    name: trail.name,
    points: normalizePlannedRoutePoints(trail.points),
  };
}

function formatDistanceMiles(valueKm: number | null | undefined, digits = 1) {
  if (valueKm === null || valueKm === undefined) return "--";
  return `${(valueKm * 0.621371).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} mi`;
}

function formatTrailSourceLabel(trail: NearbyTrailItem) {
  if (trail.source === "usgs") {
    return "USGS official trail";
  }
  if (trail.source === "osm_relation") {
    return "OSM hiking route";
  }
  return "OSM trail segment";
}

export function TerrainExplorerWorkspace({
  terrainExplorerOptions,
  initialSelectedTerrainExplorerId,
  initialPlannedRouteOverlay = null,
  initialNearbyTrails = [],
  initialSelectedNearbyTrailId = null,
}: {
  terrainExplorerOptions: TerrainExplorerOption[];
  initialSelectedTerrainExplorerId?: string | null;
  initialPlannedRouteOverlay?: PlannedRouteOverlay | null;
  initialNearbyTrails?: NearbyTrailItem[];
  initialSelectedNearbyTrailId?: string | null;
}) {
  const [selectedTerrainExplorerId, setSelectedTerrainExplorerId] = useState<string | null>(
    initialSelectedTerrainExplorerId ?? terrainExplorerOptions[0]?.id ?? null
  );
  const [plannedRouteOverlay, setPlannedRouteOverlay] = useState<PlannedRouteOverlay | null>(
    initialPlannedRouteOverlay
  );
  const [plannedRouteError, setPlannedRouteError] = useState("");
  const [terrainViewBounds, setTerrainViewBounds] = useState<{
    min_lat: number;
    min_lon: number;
    max_lat: number;
    max_lon: number;
  } | null>(null);
  const [nearbyTrails, setNearbyTrails] = useState<NearbyTrailItem[]>(initialNearbyTrails);
  const [nearbyTrailsLoading, setNearbyTrailsLoading] = useState(false);
  const [nearbyTrailsError, setNearbyTrailsError] = useState("");
  const [selectedNearbyTrailId, setSelectedNearbyTrailId] = useState<string | null>(
    initialSelectedNearbyTrailId
  );

  const selectedTerrainExplorer =
    terrainExplorerOptions.find((option) => option.id === selectedTerrainExplorerId) ??
    terrainExplorerOptions[0] ??
    null;
  const selectedNearbyTrail = selectedNearbyTrailId
    ? nearbyTrails.find((trail) => trail.id === selectedNearbyTrailId) ?? null
    : null;

  useEffect(() => {
    if (!terrainExplorerOptions.length) {
      setSelectedTerrainExplorerId(null);
      return;
    }

    setSelectedTerrainExplorerId((current) =>
      current && terrainExplorerOptions.some((option) => option.id === current)
        ? current
        : terrainExplorerOptions[0].id
    );
  }, [terrainExplorerOptions]);

  const handleTerrainViewBoundsChange = useEffectEvent(
    (
      bounds: {
        min_lat: number;
        min_lon: number;
        max_lat: number;
        max_lon: number;
      } | null
    ) => {
      setTerrainViewBounds((current) => {
        if (current === bounds) return current;
        if (!current || !bounds) return bounds;
        const isSame =
          Math.abs(current.min_lat - bounds.min_lat) < 0.00001 &&
          Math.abs(current.min_lon - bounds.min_lon) < 0.00001 &&
          Math.abs(current.max_lat - bounds.max_lat) < 0.00001 &&
          Math.abs(current.max_lon - bounds.max_lon) < 0.00001;
        return isSame ? current : bounds;
      });
    }
  );

  const handlePlannedRouteUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.[^.]+$/, "") || "Planned route";
      const lowerName = file.name.toLowerCase();
      const parsedRoute =
        lowerName.endsWith(".gpx")
          ? parseGpxRoute(text, baseName)
          : parseGeoJsonRoute(text, baseName);

      if (!parsedRoute?.points.length) {
        throw new Error("No route points were found in that GPX or GeoJSON file.");
      }

      setPlannedRouteOverlay(parsedRoute);
      setPlannedRouteError("");
    } catch (error) {
      setPlannedRouteOverlay(null);
      setPlannedRouteError(
        error instanceof Error ? error.message : "Unable to import the selected route file."
      );
    } finally {
      event.target.value = "";
    }
  };

  const searchNearbyTrails = async () => {
    if (!terrainViewBounds) {
      setNearbyTrails([]);
      setSelectedNearbyTrailId(null);
      setNearbyTrailsError("Move the map to the area you want to search, then try again.");
      return;
    }

    setNearbyTrailsLoading(true);
    setNearbyTrailsError("");

    try {
      const searchBounds = clampTrailSearchBounds(terrainViewBounds);
      const params = new URLSearchParams({
        min_lat: String(searchBounds.min_lat),
        min_lon: String(searchBounds.min_lon),
        max_lat: String(searchBounds.max_lat),
        max_lon: String(searchBounds.max_lon),
        limit: "12",
      });
      const response = await fetch(`${API_BASE}/trails/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Trail search failed with status ${response.status}`)
        );
      }

      const data = (await response.json()) as TrailSearchResponse;
      setNearbyTrails(data.items || []);
      setSelectedNearbyTrailId(data.items[0]?.id ?? null);
      if (!data.items.length) {
        setNearbyTrailsError("No named hiking trails were returned for this view.");
      }
    } catch (error) {
      setNearbyTrails([]);
      setSelectedNearbyTrailId(null);
      setNearbyTrailsError(
        error instanceof Error ? error.message : "Unable to load nearby trails right now."
      );
    } finally {
      setNearbyTrailsLoading(false);
    }
  };

  const overlayTitle = useMemo(
    () => selectedTerrainExplorer?.label || "Terrain explorer",
    [selectedTerrainExplorer]
  );

  if (!selectedTerrainExplorer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#090c16,#0f121c)] text-slate-300">
        No terrain route data is available for this view.
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[linear-gradient(180deg,#090c16,#0f121c)] text-slate-100">
      <TrailExplorer3D
        entry={selectedTerrainExplorer.entry}
        plannedRoute={plannedRouteOverlay}
        referenceTrail={selectedNearbyTrail ? trailToOverlay(selectedNearbyTrail) : null}
        onViewBoundsChange={handleTerrainViewBoundsChange}
        showOverlayControls={false}
        className="h-screen min-h-screen rounded-none border-0"
      />

      <div className="pointer-events-none absolute inset-0">
        <div className="pointer-events-auto absolute left-3 right-3 top-3 z-20 max-h-[min(42vh,26rem)] overflow-auto rounded-[1.2rem] border border-white/10 bg-[rgba(8,11,18,0.78)] p-4 backdrop-blur md:left-4 md:right-auto md:top-4 md:max-h-[calc(100vh-2rem)] md:w-[min(24rem,calc(100vw-2rem))]">
          <div className="text-[11px] uppercase tracking-[0.18em] text-emerald-100/80">
            Fullscreen terrain
          </div>
          <div className="mt-2 text-lg font-semibold text-white">{overlayTitle}</div>
          {selectedTerrainExplorer.detail ? (
            <div className="mt-1 text-sm text-slate-300">{selectedTerrainExplorer.detail}</div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {terrainExplorerOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setSelectedTerrainExplorerId(option.id)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  selectedTerrainExplorer.id === option.id
                    ? "border-emerald-300/25 bg-emerald-400/12 text-emerald-100"
                    : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>

          <div className="mt-4 rounded-[1rem] border border-white/8 bg-black/10 p-3">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Planned route overlay</div>
            <div className="mt-1 text-xs text-slate-500">
              Import a GPX or GeoJSON route to compare it against the active terrain route.
            </div>
            {plannedRouteOverlay ? (
              <div className="mt-2 text-xs text-emerald-200">
                Loaded {plannedRouteOverlay.name} with {plannedRouteOverlay.points.length} points.
              </div>
            ) : null}
            {plannedRouteError ? (
              <div className="mt-2 text-xs text-rose-200">{plannedRouteError}</div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-200 transition hover:border-white/20">
                Import route
                <input
                  type="file"
                  accept=".gpx,.geojson,.json,application/geo+json,application/json,application/gpx+xml"
                  onChange={handlePlannedRouteUpload}
                  className="hidden"
                />
              </label>
              {plannedRouteOverlay ? (
                <button
                  type="button"
                  onClick={() => {
                    setPlannedRouteOverlay(null);
                    setPlannedRouteError("");
                  }}
                  className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/20"
                >
                  Clear route
                </button>
              ) : null}
            </div>
          </div>
        </div>

        <div className="pointer-events-auto absolute bottom-3 left-3 right-3 z-20 max-h-[min(42vh,26rem)] overflow-auto rounded-[1.2rem] border border-white/10 bg-[rgba(8,11,18,0.78)] p-4 backdrop-blur md:bottom-auto md:left-auto md:right-4 md:top-4 md:max-h-[calc(100vh-2rem)] md:w-[min(26rem,calc(100vw-2rem))]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Trails in view</div>
              <div className="mt-1 text-sm text-slate-300">
                Search the currently visible terrain view and overlay trail results directly on the globe.
              </div>
              <div className="mt-2 text-xs text-slate-400">
                Search area: {terrainViewBounds ? "current map view" : "waiting for map view"}
              </div>
              {nearbyTrails.length ? (
                <div className="mt-1 text-xs text-slate-400">
                  Provider: {nearbyTrails[0]?.source === "usgs" ? "USGS National Map" : "OpenStreetMap fallback"}
                </div>
              ) : null}
              {nearbyTrailsError ? (
                <div className="mt-2 text-xs text-rose-200">{nearbyTrailsError}</div>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-2xl"
              onClick={() => void searchNearbyTrails()}
              disabled={nearbyTrailsLoading}
            >
              {nearbyTrailsLoading ? "Searching..." : "Find trails in view"}
            </Button>
          </div>

          {nearbyTrails.length ? (
            <div className="mt-4 space-y-3">
              {nearbyTrails.map((trail) => {
                const active = selectedNearbyTrail?.id === trail.id;
                return (
                  <div
                    key={trail.id}
                    className={`rounded-[1rem] border p-4 transition ${
                      active
                        ? "border-emerald-300/25 bg-emerald-400/10"
                        : "border-white/8 bg-white/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">{trail.name}</div>
                        <div className="mt-1 text-xs text-slate-400">
                          {formatTrailSourceLabel(trail)}
                          {trail.ref ? ` · ${trail.ref}` : ""}
                          {trail.network ? ` · ${trail.network}` : ""}
                        </div>
                      </div>
                      {trail.osm_url ? (
                        <a
                          href={trail.osm_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-cyan-200 underline decoration-cyan-300/30 underline-offset-4"
                        >
                          OSM
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
                      {trail.length_m ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          {formatDistanceMiles(trail.length_m / 1000, 1)}
                        </span>
                      ) : null}
                      {trail.distance_from_center_m ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                          {Math.round(trail.distance_from_center_m)} m away
                        </span>
                      ) : null}
                      <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1">
                        {trail.points.length} points
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="rounded-2xl"
                        onClick={() => setSelectedNearbyTrailId(active ? null : trail.id)}
                      >
                        {active ? "Overlay active" : "Overlay trail"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

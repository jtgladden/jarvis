"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, GripHorizontal, Search } from "lucide-react";
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

type GeocodeResult = {
  place_id: number | string;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: string[];
};

type PanelPosition = {
  x: number;
  y: number;
};

const PANEL_PADDING_PX = 12;

function clampPanelPosition(
  position: PanelPosition,
  size: { width: number; height: number },
  viewport: { width: number; height: number }
) {
  return {
    x: Math.min(
      Math.max(PANEL_PADDING_PX, position.x),
      Math.max(PANEL_PADDING_PX, viewport.width - size.width - PANEL_PADDING_PX)
    ),
    y: Math.min(
      Math.max(PANEL_PADDING_PX, position.y),
      Math.max(PANEL_PADDING_PX, viewport.height - size.height - PANEL_PADDING_PX)
    ),
  };
}

function getLeftPanelInitialPosition(viewport: { width: number; height: number }) {
  return {
    x: viewport.width >= 768 ? 16 : 12,
    y: viewport.width >= 768 ? 16 : 12,
  };
}

function getRightPanelInitialPosition(viewport: { width: number; height: number }) {
  const estimatedWidth = viewport.width >= 768 ? Math.min(416, viewport.width - 32) : viewport.width - 24;
  const estimatedHeight = Math.min(416, Math.max(220, viewport.height * 0.38));
  return clampPanelPosition(
    viewport.width >= 768
      ? { x: viewport.width - estimatedWidth - 16, y: 16 }
      : { x: 12, y: viewport.height - estimatedHeight - 12 },
    { width: estimatedWidth, height: estimatedHeight },
    viewport
  );
}

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

function DraggableOverlayPanel({
  title,
  collapsedTitle,
  initialPosition,
  className,
  children,
  collapsed,
  onCollapsedChange,
}: {
  title: string;
  collapsedTitle?: string;
  initialPosition: (viewport: { width: number; height: number }) => PanelPosition;
  className: string;
  children: React.ReactNode;
  collapsed?: boolean;
  onCollapsedChange?: ((collapsed: boolean) => void) | null;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const applyInitialOrClampPosition = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const panel = panelRef.current;
      const size = {
        width: panel?.offsetWidth ?? Math.min(384, viewport.width - PANEL_PADDING_PX * 2),
        height: panel?.offsetHeight ?? Math.min(320, viewport.height - PANEL_PADDING_PX * 2),
      };

      setPosition((current) =>
        current
          ? clampPanelPosition(current, size, viewport)
          : clampPanelPosition(initialPosition(viewport), size, viewport)
      );
    };

    applyInitialOrClampPosition();
    window.addEventListener("resize", applyInitialOrClampPosition);
    return () => window.removeEventListener("resize", applyInitialOrClampPosition);
  }, [initialPosition]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (!dragStateRef.current || !panelRef.current) {
        return;
      }

      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = {
        width: panelRef.current.offsetWidth,
        height: panelRef.current.offsetHeight,
      };
      setPosition(
        clampPanelPosition(
          {
            x: event.clientX - dragStateRef.current.offsetX,
            y: event.clientY - dragStateRef.current.offsetY,
          },
          size,
          viewport
        )
      );
    };

    const handlePointerUp = () => {
      dragStateRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className={className}
      style={
        position
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
            }
          : undefined
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          className={`flex min-w-0 flex-1 cursor-grab items-center justify-between rounded-xl border border-white/8 bg-black/10 px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em] text-slate-400 active:cursor-grabbing ${
            collapsed ? "mb-0" : ""
          }`}
          onPointerDown={(event) => {
            if (!panelRef.current) {
              return;
            }
            const rect = panelRef.current.getBoundingClientRect();
            dragStateRef.current = {
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top,
            };
          }}
        >
          <span className="truncate">{collapsed ? (collapsedTitle || title) : title}</span>
          <GripHorizontal className="h-4 w-4 shrink-0 text-slate-500" />
        </button>
        <button
          type="button"
          onClick={() => onCollapsedChange?.(!collapsed)}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/8 bg-black/10 text-slate-300 transition hover:border-white/20"
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
        >
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
      {!collapsed ? children : null}
    </div>
  );
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
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [focusedSearchResult, setFocusedSearchResult] = useState<GeocodeResult | null>(null);
  const [trailsPanelOpen, setTrailsPanelOpen] = useState(true);
  const [imageryMode, setImageryMode] = useState<"satellite" | "topo" | "osm">("satellite");
  const [terrainMode, setTerrainMode] = useState<"local" | "world" | "ellipsoid">("ellipsoid");
  const [lightingEnabled, setLightingEnabled] = useState(true);
  const [terrainPanelCollapsed, setTerrainPanelCollapsed] = useState(false);
  const [trailsPanelCollapsed, setTrailsPanelCollapsed] = useState(false);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const applyPhonePanelDefaults = () => {
      const isPhone = window.innerWidth < 768;
      setTerrainPanelCollapsed(isPhone);
      setTrailsPanelCollapsed(isPhone);
    };

    applyPhonePanelDefaults();
  }, []);

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

  const runLocationSearch = async () => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchError("Enter a place, trailhead, canyon, or mountain to search.");
      return;
    }

    setSearchLoading(true);
    setSearchError("");

    try {
      const params = new URLSearchParams({ q: query, limit: "5" });
      const response = await fetch(`/jarvis-geocode/search?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(
          await getErrorMessage(response, `Location search failed with status ${response.status}`)
        );
      }

      const data = (await response.json()) as { items?: GeocodeResult[] };
      const results = data.items || [];
      setSearchResults(results);
      if (!results.length) {
        setSearchError("No places matched that search.");
        return;
      }

      setFocusedSearchResult(results[0]);
    } catch (error) {
      setSearchResults([]);
      setSearchError(
        error instanceof Error ? error.message : "Unable to search for that place."
      );
    } finally {
      setSearchLoading(false);
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
        focusSearchResult={focusedSearchResult}
        imageryMode={imageryMode}
        onImageryModeChange={setImageryMode}
        terrainMode={terrainMode}
        onTerrainModeChange={setTerrainMode}
        lightingEnabled={lightingEnabled}
        onLightingEnabledChange={setLightingEnabled}
        onViewBoundsChange={handleTerrainViewBoundsChange}
        showOverlayControls={false}
        className="h-screen min-h-screen rounded-none border-0"
      />

      <div className="pointer-events-none absolute inset-0">
        <DraggableOverlayPanel
          title="Move Terrain Panel"
          collapsedTitle="Terrain"
          initialPosition={getLeftPanelInitialPosition}
          className="pointer-events-auto absolute z-20 max-h-[min(42vh,26rem)] w-[min(24rem,calc(100vw-1.5rem))] overflow-auto rounded-[1.2rem] border border-white/10 bg-[rgba(8,11,18,0.78)] p-4 backdrop-blur md:max-h-[calc(100vh-2rem)] md:w-[min(24rem,calc(100vw-2rem))]"
          collapsed={terrainPanelCollapsed}
          onCollapsedChange={setTerrainPanelCollapsed}
        >
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
            <label className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:border-white/20">
              <span className="mr-2 text-slate-400">Imagery</span>
              <select
                value={imageryMode}
                onChange={(event) => setImageryMode(event.target.value as "satellite" | "topo" | "osm")}
                className="bg-transparent text-slate-100 outline-none"
              >
                <option value="satellite">Satellite</option>
                <option value="topo">Topo</option>
                <option value="osm">OSM</option>
              </select>
            </label>
            <label className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition hover:border-white/20">
              <span className="mr-2 text-slate-400">Terrain</span>
              <select
                value={terrainMode}
                onChange={(event) => setTerrainMode(event.target.value as "local" | "world" | "ellipsoid")}
                className="bg-transparent text-slate-100 outline-none"
              >
                <option value="local">Self-hosted</option>
                <option value="world">World</option>
                <option value="ellipsoid">Flat</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setLightingEnabled((current) => !current)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                lightingEnabled
                  ? "border-amber-300/25 bg-amber-400/12 text-amber-100"
                  : "border-white/10 bg-white/5 text-slate-300 hover:border-white/20"
              }`}
            >
              {lightingEnabled ? "Lighting on" : "Lighting off"}
            </button>
          </div>

          <div className="mt-4 rounded-[1rem] border border-white/8 bg-black/10 p-3">
            <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Map search</div>
            <div className="mt-1 text-xs text-slate-500">
              Search trailheads, canyons, peaks, towns, or landmarks and move the camera there.
            </div>
            <div className="mt-3 flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void runLocationSearch();
                    }
                  }}
                  placeholder="Search Provo Canyon, Sundance..."
                  className="h-10 w-full rounded-xl border border-white/10 bg-black/20 pl-9 pr-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/40"
                />
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="rounded-2xl"
                onClick={() => void runLocationSearch()}
                disabled={searchLoading}
              >
                {searchLoading ? "Searching..." : "Search"}
              </Button>
            </div>
            {searchError ? (
              <div className="mt-2 text-xs text-rose-200">{searchError}</div>
            ) : null}
            {searchResults.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {searchResults.slice(0, 4).map((result) => (
                  <button
                    key={String(result.place_id)}
                    type="button"
                    onClick={() => setFocusedSearchResult(result)}
                    className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-left text-xs text-slate-200 transition hover:border-white/20"
                  >
                    {result.display_name}
                  </button>
                ))}
              </div>
            ) : null}
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
        </DraggableOverlayPanel>

        <DraggableOverlayPanel
          title="Move Trails Panel"
          collapsedTitle="Trails"
          initialPosition={getRightPanelInitialPosition}
          className="pointer-events-auto absolute z-20 max-h-[min(42vh,26rem)] w-[min(26rem,calc(100vw-1.5rem))] overflow-auto rounded-[1.2rem] border border-white/10 bg-[rgba(8,11,18,0.78)] p-4 backdrop-blur md:max-h-[calc(100vh-2rem)] md:w-[min(26rem,calc(100vw-2rem))]"
          collapsed={trailsPanelCollapsed}
          onCollapsedChange={setTrailsPanelCollapsed}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Trails in view</div>
              <div className="mt-1 text-sm text-slate-300">
                Search the currently visible terrain view and overlay trail results directly on the globe.
              </div>
            </div>
            <div className="flex items-center gap-2">
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
              <button
                type="button"
                onClick={() => setTrailsPanelOpen((current) => !current)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-slate-200 transition hover:border-white/20"
                aria-label={trailsPanelOpen ? "Collapse trails in view" : "Expand trails in view"}
              >
                {trailsPanelOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
              </button>
            </div>
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

          {trailsPanelOpen && nearbyTrails.length ? (
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
        </DraggableOverlayPanel>
      </div>
    </div>
  );
}

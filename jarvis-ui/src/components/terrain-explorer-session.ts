"use client";

export type TerrainExplorerEntry = {
  route_points: Array<{
    timestamp?: string | null;
    latitude: number;
    longitude: number;
  }>;
  visits: Array<{
    arrival?: string | null;
    departure?: string | null;
    latitude: number;
    longitude: number;
    label?: string | null;
  }>;
};

export type TerrainExplorerOption = {
  id: string;
  label: string;
  detail: string;
  entry: TerrainExplorerEntry;
};

export type PlannedRouteOverlay = {
  name: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

export type NearbyTrailItem = {
  id: string;
  name: string;
  source: "usgs" | "osm_relation" | "osm_way";
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

export type TerrainExplorerSessionPayload = {
  terrainExplorerOptions: TerrainExplorerOption[];
  selectedTerrainExplorerId: string | null;
  plannedRouteOverlay: PlannedRouteOverlay | null;
  nearbyTrails: NearbyTrailItem[];
  selectedNearbyTrailId: string | null;
  sourceContext: "desktop" | "mobile";
};

const STORAGE_PREFIX = "jarvis-terrain-explorer:";
const DEFAULT_TERRAIN_EXPLORER_OPTION: TerrainExplorerOption = {
  id: "terrain-explore",
  label: "Explore terrain",
  detail: "Free-roam 3D terrain view centered on Provo Valley.",
  entry: {
    route_points: [],
    visits: [],
  },
};

export function createDefaultTerrainExplorerSessionPayload(
  sourceContext: TerrainExplorerSessionPayload["sourceContext"] = "desktop"
): TerrainExplorerSessionPayload {
  return {
    terrainExplorerOptions: [DEFAULT_TERRAIN_EXPLORER_OPTION],
    selectedTerrainExplorerId: DEFAULT_TERRAIN_EXPLORER_OPTION.id,
    plannedRouteOverlay: null,
    nearbyTrails: [],
    selectedNearbyTrailId: null,
    sourceContext,
  };
}

export function saveTerrainExplorerSession(
  payload: TerrainExplorerSessionPayload
) {
  if (typeof window === "undefined") {
    return "";
  }

  const sessionId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.sessionStorage.setItem(
    `${STORAGE_PREFIX}${sessionId}`,
    JSON.stringify(payload)
  );
  return sessionId;
}

export function loadTerrainExplorerSession(sessionId: string) {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TerrainExplorerSessionPayload;
  } catch {
    return null;
  }
}

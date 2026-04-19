"use client";

import { useEffect, useMemo, useRef } from "react";
import type { GeoJSONSourceSpecification, LngLatBoundsLike, Map as MapLibreMap, StyleSpecification } from "maplibre-gl";

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

type MovementMapEntry = {
  route_points: MovementRoutePoint[];
  visits: MovementVisit[];
};

type MovementMapProps = {
  entry: MovementMapEntry;
  className?: string;
};

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "\u00a9 OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "background",
      type: "background",
      paint: {
        "background-color": "#09111f",
      },
    },
    {
      id: "osm",
      type: "raster",
      source: "osm",
      paint: {
        "raster-opacity": 0.28,
        "raster-saturation": -0.75,
        "raster-contrast": -0.08,
        "raster-brightness-min": 0.06,
        "raster-brightness-max": 0.72,
        "raster-fade-duration": 0,
      },
    },
  ],
};

function cn(...values: Array<string | undefined | false | null>) {
  return values.filter(Boolean).join(" ");
}

function buildMovementMapData(entry: MovementMapEntry) {
  const routeCoordinates = (entry.route_points.length ? entry.route_points : entry.visits).map((point) => [
    point.longitude,
    point.latitude,
  ] as [number, number]);

  if (!routeCoordinates.length) {
    return null;
  }

  const visitFeatures = entry.visits.slice(0, 12).map((visit, index) => ({
    type: "Feature" as const,
    geometry: {
      type: "Point" as const,
      coordinates: [visit.longitude, visit.latitude] as [number, number],
    },
    properties: {
      id: `${visit.latitude}-${visit.longitude}-${index}`,
      label: visit.label || `Stop ${index + 1}`,
    },
  }));

  const start = routeCoordinates[0];
  const end = routeCoordinates[routeCoordinates.length - 1];

  const longitudes = routeCoordinates.map((point) => point[0]);
  const latitudes = routeCoordinates.map((point) => point[1]);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const lonPadding = Math.max((maxLon - minLon) * 0.18, 0.006);
  const latPadding = Math.max((maxLat - minLat) * 0.18, 0.006);

  return {
    bounds: [
      [minLon - lonPadding, minLat - latPadding],
      [maxLon + lonPadding, maxLat + latPadding],
    ] as LngLatBoundsLike,
    routeGeoJson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: routeCoordinates,
          },
          properties: {},
        },
      ],
    },
    visitsGeoJson: {
      type: "FeatureCollection" as const,
      features: visitFeatures,
    },
    endpointsGeoJson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: start,
          },
          properties: {
            kind: "start",
          },
        },
        {
          type: "Feature" as const,
          geometry: {
            type: "Point" as const,
            coordinates: end,
          },
          properties: {
            kind: "end",
          },
        },
      ],
    },
  };
}

function upsertGeoJsonSource(
  map: MapLibreMap,
  id: string,
  data: GeoJSONSourceSpecification["data"]
) {
  const existing = map.getSource(id) as { setData?: (value: GeoJSONSourceSpecification["data"]) => void } | undefined;
  if (existing?.setData) {
    existing.setData(data);
    return;
  }

  map.addSource(id, {
    type: "geojson",
    data,
  });
}

function ensureMovementLayers(map: MapLibreMap) {
  if (!map.getLayer("movement-route-glow")) {
    map.addLayer({
      id: "movement-route-glow",
      type: "line",
      source: "movement-route",
      paint: {
        "line-color": "rgba(248,250,252,0.26)",
        "line-width": 10,
        "line-blur": 2,
      },
    });
  }

  if (!map.getLayer("movement-route")) {
    map.addLayer({
      id: "movement-route",
      type: "line",
      source: "movement-route",
      paint: {
        "line-color": "#4ade80",
        "line-width": 4,
        "line-opacity": 0.9,
      },
      layout: {
        "line-cap": "round",
        "line-join": "round",
      },
    });
  }

  if (!map.getLayer("movement-visits")) {
    map.addLayer({
      id: "movement-visits",
      type: "circle",
      source: "movement-visits",
      paint: {
        "circle-radius": 4,
        "circle-color": "#f8fafc",
        "circle-opacity": 0.74,
        "circle-stroke-width": 1,
        "circle-stroke-color": "rgba(15,23,42,0.9)",
      },
    });
  }

  if (!map.getLayer("movement-endpoints")) {
    map.addLayer({
      id: "movement-endpoints",
      type: "circle",
      source: "movement-endpoints",
      paint: {
        "circle-radius": [
          "match",
          ["get", "kind"],
          "start",
          7,
          "end",
          7,
          6,
        ],
        "circle-color": [
          "match",
          ["get", "kind"],
          "start",
          "#4ade80",
          "end",
          "#22d3ee",
          "#e2e8f0",
        ],
        "circle-opacity": 0.94,
        "circle-stroke-width": 2,
        "circle-stroke-color": "rgba(15,23,42,0.88)",
      },
    });
  }
}

function fitMovementBounds(map: MapLibreMap, bounds: LngLatBoundsLike) {
  const container = map.getContainer();
  const compactPadding = Math.max(Math.min(container.clientWidth * 0.08, 32), 20);
  const verticalPadding = Math.max(Math.min(container.clientHeight * 0.12, 40), 24);

  map.fitBounds(bounds, {
    padding: {
      top: verticalPadding,
      right: compactPadding,
      bottom: verticalPadding,
      left: compactPadding,
    },
    duration: 0,
    maxZoom: 18,
  });
}

function syncMovementMap(map: MapLibreMap, entry: MovementMapEntry) {
  const data = buildMovementMapData(entry);
  if (!data) return null;

  upsertGeoJsonSource(map, "movement-route", data.routeGeoJson);
  upsertGeoJsonSource(map, "movement-visits", data.visitsGeoJson);
  upsertGeoJsonSource(map, "movement-endpoints", data.endpointsGeoJson);
  ensureMovementLayers(map);
  fitMovementBounds(map, data.bounds);

  return data;
}

export function MovementMap({ entry, className }: MovementMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const latestEntryRef = useRef(entry);
  const entryKey = useMemo(
    () =>
      JSON.stringify({
        route_points: entry.route_points.map((point) => [point.longitude, point.latitude, point.timestamp]),
        visits: entry.visits.map((visit) => [visit.longitude, visit.latitude, visit.label || ""]),
      }),
    [entry]
  );

  useEffect(() => {
    latestEntryRef.current = entry;
  }, [entry, entryKey]);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current || mapRef.current) return;

      const maplibregl = (await import("maplibre-gl")).default;
      if (cancelled || !containerRef.current) return;

      const configuredStyle = process.env.NEXT_PUBLIC_MOVEMENT_MAP_STYLE_URL;
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: configuredStyle || FALLBACK_STYLE,
        attributionControl: false,
        interactive: true,
        dragPan: true,
        scrollZoom: true,
        boxZoom: false,
        dragRotate: false,
        doubleClickZoom: true,
        touchZoomRotate: true,
        cooperativeGestures: false,
        pitchWithRotate: false,
        keyboard: true,
        maxZoom: 19,
      });

      mapRef.current = map;

      map.on("load", () => {
        if (cancelled) return;
        syncMovementMap(map, latestEntryRef.current);
      });
    }

    mount();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (map.isStyleLoaded()) {
      syncMovementMap(map, entry);
      return;
    }

    const handleLoad = () => syncMovementMap(map, entry);
    map.once("load", handleLoad);
    return () => {
      map.off("load", handleLoad);
    };
  }, [entry, entryKey]);

  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container || typeof ResizeObserver === "undefined") return;

    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        map.resize();
        const data = buildMovementMapData(latestEntryRef.current);
        if (data) {
          fitMovementBounds(map, data.bounds);
        }
      });
    });

    observer.observe(container);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={cn("relative w-full overflow-hidden", className || "h-[220px] min-h-[220px]")}>
      <div
        ref={containerRef}
        className="absolute inset-0 [filter:saturate(0.65)_brightness(0.82)_contrast(0.94)]"
        aria-label="Movement route map"
        role="img"
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_30%),linear-gradient(180deg,rgba(7,10,18,0.12),rgba(7,10,18,0.32))]" />
      <div className="pointer-events-none absolute bottom-2 right-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.72)] px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300/85">
        OpenStreetMap
      </div>
    </div>
  );
}

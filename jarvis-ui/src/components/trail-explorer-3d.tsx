"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type RouteVisit = {
  latitude: number;
  longitude: number;
  label?: string | null;
};

type RoutePoint = {
  timestamp?: string | null;
  latitude: number;
  longitude: number;
};

type TrailExplorerEntry = {
  route_points: RoutePoint[];
  visits: RouteVisit[];
};

type PlannedRouteOverlay = {
  name?: string;
  points: Array<{
    latitude: number;
    longitude: number;
  }>;
};

type TrailExplorer3DProps = {
  entry: TrailExplorerEntry;
  plannedRoute?: PlannedRouteOverlay | null;
  className?: string;
};

type ImageryMode = "satellite" | "topo" | "osm";
type TerrainMode = "local" | "world" | "ellipsoid";

declare global {
  interface Window {
    Cesium?: any;
  }
}

const CESIUM_JS_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/Cesium.js";
const CESIUM_CSS_URL =
  "https://cesium.com/downloads/cesiumjs/releases/1.113/Build/Cesium/Widgets/widgets.css";

let cesiumLoadPromise: Promise<any> | null = null;

function cn(...values: Array<string | undefined | false | null>) {
  return values.filter(Boolean).join(" ");
}

function loadCesium() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Cesium can only be loaded in the browser."));
  }

  if (window.Cesium) {
    return Promise.resolve(window.Cesium);
  }

  if (cesiumLoadPromise) {
    return cesiumLoadPromise;
  }

  cesiumLoadPromise = new Promise((resolve, reject) => {
    const existingStyle = document.querySelector(
      `link[data-jarvis-cesium="true"]`
    ) as HTMLLinkElement | null;
    if (!existingStyle) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = CESIUM_CSS_URL;
      link.dataset.jarvisCesium = "true";
      document.head.appendChild(link);
    }

    const existingScript = document.querySelector(
      `script[data-jarvis-cesium="true"]`
    ) as HTMLScriptElement | null;

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(window.Cesium), {
        once: true,
      });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("Failed to load Cesium.")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = CESIUM_JS_URL;
    script.async = true;
    script.dataset.jarvisCesium = "true";
    script.onload = () => resolve(window.Cesium);
    script.onerror = () => reject(new Error("Failed to load Cesium."));
    document.head.appendChild(script);
  });

  return cesiumLoadPromise;
}

function getRouteCoordinates(entry: TrailExplorerEntry) {
  const source = entry.route_points.length ? entry.route_points : entry.visits;
  return source
    .map((point) => [point.longitude, point.latitude] as const)
    .filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
    );
}

function createImageryProvider(Cesium: any, mode: ImageryMode) {
  switch (mode) {
    case "topo":
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
        credit: "Esri, HERE, Garmin, FAO, USGS",
      });
    case "osm":
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        subdomains: ["a", "b", "c"],
        credit: "\u00a9 OpenStreetMap contributors",
      });
    case "satellite":
    default:
      return new Cesium.UrlTemplateImageryProvider({
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        credit: "Esri, Maxar, Earthstar Geographics",
      });
  }
}

async function createTerrainProvider(
  Cesium: any,
  mode: TerrainMode,
  terrainUrl: string,
  ionToken: string
) {
  if (mode === "local" && terrainUrl) {
    return Cesium.CesiumTerrainProvider.fromUrl(terrainUrl, {
      requestVertexNormals: true,
    });
  }

  if (mode === "world" && ionToken) {
    return Cesium.createWorldTerrainAsync({
      requestVertexNormals: true,
      requestWaterMask: true,
    });
  }

  return new Cesium.EllipsoidTerrainProvider();
}

function syncTrailEntities(
  Cesium: any,
  viewer: any,
  entry: TrailExplorerEntry,
  plannedRoute: PlannedRouteOverlay | null | undefined,
  onStatus: (value: string) => void
) {
  const coordinates = getRouteCoordinates(entry);
  const plannedCoordinates = (plannedRoute?.points || [])
    .map((point) => [point.longitude, point.latitude] as const)
    .filter(
      (point) => Number.isFinite(point[0]) && Number.isFinite(point[1])
    );
  viewer.entities.removeAll();

  if (!coordinates.length && !plannedCoordinates.length) {
    onStatus("waiting for route data");
    return;
  }

  if (coordinates.length) {
    const positions = coordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude, 24)
    );

    viewer.entities.add({
      id: "jarvis-trail-line",
      polyline: {
        positions,
        width: 5,
        clampToGround: true,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.2,
          color: Cesium.Color.fromCssColorString("#4ade80"),
        }),
      },
    });

    const [startLongitude, startLatitude] = coordinates[0];
    const [endLongitude, endLatitude] = coordinates[coordinates.length - 1];

    viewer.entities.add({
      id: "jarvis-trail-start",
      position: Cesium.Cartesian3.fromDegrees(startLongitude, startLatitude, 32),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#4ade80"),
        outlineColor: Cesium.Color.fromCssColorString("#08111b"),
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    viewer.entities.add({
      id: "jarvis-trail-end",
      position: Cesium.Cartesian3.fromDegrees(endLongitude, endLatitude, 32),
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString("#22d3ee"),
        outlineColor: Cesium.Color.fromCssColorString("#08111b"),
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  if (plannedCoordinates.length) {
    const plannedPositions = plannedCoordinates.map(([longitude, latitude]) =>
      Cesium.Cartesian3.fromDegrees(longitude, latitude, 30)
    );

    viewer.entities.add({
      id: "jarvis-planned-trail-line",
      polyline: {
        positions: plannedPositions,
        width: 4,
        clampToGround: true,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString("#f59e0b"),
          dashLength: 18,
        }),
      },
    });
  }

  viewer.flyTo(viewer.entities, {
    duration: 0.9,
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-35),
      Math.max(1800, coordinates.length * 18)
    ),
  });
  onStatus(
    plannedCoordinates.length
      ? `actual ${coordinates.length || 0} pts, planned ${plannedCoordinates.length} pts`
      : `rendering ${coordinates.length} route points`
  );
}

export function TrailExplorer3D({
  entry,
  plannedRoute,
  className,
}: TrailExplorer3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any | null>(null);
  const cesiumRef = useRef<any | null>(null);
  const latestEntryRef = useRef(entry);
  const [isReady, setIsReady] = useState(false);
  const [status, setStatus] = useState("loading Cesium");
  const [imageryMode, setImageryMode] = useState<ImageryMode>("satellite");
  const [terrainMode, setTerrainMode] = useState<TerrainMode>("ellipsoid");
  const terrainUrl = process.env.NEXT_PUBLIC_CESIUM_TERRAIN_URL?.trim() || "";
  const ionToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN?.trim() || "";

  const entryKey = useMemo(
    () =>
      JSON.stringify({
        route_points: entry.route_points.map((point) => [
          point.longitude,
          point.latitude,
          point.timestamp || "",
        ]),
        visits: entry.visits.map((visit) => [
          visit.longitude,
          visit.latitude,
          visit.label || "",
        ]),
      }),
    [entry]
  );
  const plannedRouteKey = useMemo(
    () =>
      JSON.stringify(
        (plannedRoute?.points || []).map((point) => [
          point.longitude,
          point.latitude,
        ])
      ),
    [plannedRoute]
  );

  useEffect(() => {
    latestEntryRef.current = entry;
  }, [entry, entryKey]);

  useEffect(() => {
    if (terrainUrl) {
      setTerrainMode("local");
    } else if (ionToken) {
      setTerrainMode("world");
    }
  }, [terrainUrl, ionToken]);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      if (!containerRef.current || viewerRef.current) {
        return;
      }

      try {
        const Cesium = await loadCesium();
        if (cancelled || !containerRef.current) {
          return;
        }

        cesiumRef.current = Cesium;

        if (ionToken) {
          Cesium.Ion.defaultAccessToken = ionToken;
        }

        const viewer = new Cesium.Viewer(containerRef.current, {
          terrainProvider: new Cesium.EllipsoidTerrainProvider(),
          baseLayer: false,
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          sceneModePicker: false,
          navigationHelpButton: false,
          infoBox: false,
          scene3DOnly: true,
          selectionIndicator: false,
        });

        viewer.scene.globe.enableLighting = true;
        viewer.scene.globe.depthTestAgainstTerrain = true;
        viewer.scene.globe.maximumScreenSpaceError = 2;
        viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
          "2024-07-04T20:00:00Z"
        );

        viewerRef.current = viewer;
        setIsReady(true);
        setStatus("viewer ready");
      } catch (error) {
        if (!cancelled) {
          setStatus(
            error instanceof Error ? error.message : "Failed to load 3D explorer"
          );
        }
      }
    }

    void mount();

    return () => {
      cancelled = true;
      if (viewerRef.current && !viewerRef.current.isDestroyed?.()) {
        viewerRef.current.destroy();
      }
      viewerRef.current = null;
      cesiumRef.current = null;
      setIsReady(false);
    };
  }, [ionToken]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    viewer.imageryLayers.removeAll();
    viewer.imageryLayers.addImageryProvider(
      createImageryProvider(Cesium, imageryMode)
    );
  }, [imageryMode, isReady]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    let cancelled = false;

    async function applyTerrain() {
      try {
        if (terrainMode === "local" && !terrainUrl) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("local terrain not configured");
          return;
        }

        if (terrainMode === "world" && !ionToken) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("Cesium Ion token not configured");
          return;
        }

        setStatus(
          terrainMode === "ellipsoid"
            ? "flat globe"
            : terrainMode === "local"
            ? "loading self-hosted terrain"
            : "loading Cesium World Terrain"
        );
        viewer.terrainProvider = await createTerrainProvider(
          Cesium,
          terrainMode,
          terrainUrl,
          ionToken
        );
        if (!cancelled) {
          syncTrailEntities(
            Cesium,
            viewer,
            latestEntryRef.current,
            plannedRoute,
            setStatus
          );
        }
      } catch {
        if (!cancelled) {
          viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();
          setStatus("terrain unavailable, using flat globe");
          syncTrailEntities(
            Cesium,
            viewer,
            latestEntryRef.current,
            plannedRoute,
            setStatus
          );
        }
      }
    }

    void applyTerrain();

    return () => {
      cancelled = true;
    };
  }, [terrainMode, terrainUrl, ionToken, isReady, plannedRoute, plannedRouteKey]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium) {
      return;
    }

    syncTrailEntities(Cesium, viewer, entry, plannedRoute, setStatus);
  }, [entry, entryKey, plannedRoute, plannedRouteKey, isReady]);

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-[1.2rem] border border-white/8 bg-[linear-gradient(180deg,rgba(9,12,22,0.96),rgba(15,18,28,0.96))]",
        className || "h-[420px]"
      )}
    >
      <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
        <label className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-200">
          <span className="mr-2 text-slate-400">Imagery</span>
          <select
            value={imageryMode}
            onChange={(event) =>
              setImageryMode(event.target.value as ImageryMode)
            }
            className="bg-transparent text-slate-100 outline-none"
          >
            <option value="satellite">Satellite</option>
            <option value="topo">Topo</option>
            <option value="osm">OSM</option>
          </select>
        </label>
        <label className="rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-slate-200">
          <span className="mr-2 text-slate-400">Terrain</span>
          <select
            value={terrainMode}
            onChange={(event) =>
              setTerrainMode(event.target.value as TerrainMode)
            }
            className="bg-transparent text-slate-100 outline-none"
          >
            <option value="local">Self-hosted</option>
            <option value="world">World</option>
            <option value="ellipsoid">Flat</option>
          </select>
        </label>
      </div>

      <div
        ref={containerRef}
        className="absolute inset-0"
        aria-label="3D terrain route explorer"
        role="img"
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_30%),linear-gradient(180deg,rgba(7,10,18,0.08),rgba(7,10,18,0.26))]" />
      <div className="pointer-events-none absolute bottom-3 left-3 rounded-full border border-white/10 bg-[rgba(8,11,18,0.78)] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-slate-300/85">
        {status}
      </div>
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-full border border-emerald-300/18 bg-emerald-400/10 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-emerald-100/90">
        Trail Explorer 3D
      </div>
    </div>
  );
}

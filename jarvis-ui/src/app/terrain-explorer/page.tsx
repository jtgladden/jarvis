"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { TerrainExplorerWorkspace } from "@/components/terrain-explorer-workspace";
import {
  createDefaultTerrainExplorerSessionPayload,
  loadTerrainExplorerSession,
} from "@/components/terrain-explorer-session";

function TerrainExplorerPageInner() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("session");
  const payload = useMemo(
    () =>
      (sessionId ? loadTerrainExplorerSession(sessionId) : null) ??
      createDefaultTerrainExplorerSessionPayload(),
    [sessionId]
  );

  return (
    <TerrainExplorerWorkspace
      terrainExplorerOptions={payload.terrainExplorerOptions}
      initialSelectedTerrainExplorerId={payload.selectedTerrainExplorerId}
      initialPlannedRouteOverlay={payload.plannedRouteOverlay}
      initialNearbyTrails={payload.nearbyTrails}
      initialSelectedNearbyTrailId={payload.selectedNearbyTrailId}
    />
  );
}

export default function TerrainExplorerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#090c16,#0f121c)] px-6 text-center text-slate-300">
          Loading terrain explorer...
        </div>
      }
    >
      <TerrainExplorerPageInner />
    </Suspense>
  );
}

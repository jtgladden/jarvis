# Archived Features

These features were removed from the active app but kept here for reference.

## 3D Terrain Explorer & Route Mapping

Removed: May 2026

### Files

**Frontend components**
- `jarvis-ui/src/components/terrain-explorer-workspace.tsx` — main terrain explorer UI
- `jarvis-ui/src/components/trail-explorer-3d.tsx` — 3D trail visualization
- `jarvis-ui/src/components/terrain-explorer-session.ts` — session state passed between pages
- `jarvis-ui/src/components/trail-planner-map.tsx` — interactive route planning map

**Frontend pages**
- `jarvis-ui/src/app/terrain-explorer/page.tsx` — fullscreen 3D terrain explorer
- `jarvis-ui/src/app/terrain-planner/page.tsx` — route planning page

**Backend**
- `app/trails.py` — trail search via USGS, NPS, and OpenStreetMap (Overpass API)

### What was removed from active files
- `app/main.py` — `GET /api/trails/search` endpoint and `search_openstreetmap_trails` import
- `jarvis-ui/src/app/page.tsx` — terrain explorer button, session state, `saveTerrainExplorerSession` import
- `jarvis-ui/src/app/mobile/page.tsx` — same

### What was kept
- `movement-map.tsx` — simple route map embedded in the health section (not the same feature)
- `app/movement.py`, `app/movement_store.py` — movement data sync and storage
- `GET /api/movement` and `POST /api/movement/daily` endpoints

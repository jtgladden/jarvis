# jarvis

Personal Gmail triage assistant with a FastAPI backend and a Next.js dashboard.

## iOS companion app

There is now a starter Apple Health companion app scaffold in [ios/README.md](/Users/jt_gladden/Dev/jarvis/ios/README.md).

This is a SwiftUI + HealthKit starting point for requesting Apple Health permissions on-device before sending approved health summaries to the backend.

The backend also supports daily health sync records through `POST /api/health/daily` and includes health summary data in the dashboard response.

## Docker deployment

This repo is now packaged to run as two containers:

- `api`: FastAPI + Gmail/OpenAI logic on port `8000`
- `web`: Next.js dashboard on port `3000`

The dashboard now talks to the backend through same-origin `/api` requests. In Docker, the Next.js app rewrites `/api/*` to the internal `api` service automatically.

### Files

- [docker-compose.yml](/Users/jt_gladden/Dev/jarvis/docker-compose.yml)
- [Dockerfile](/Users/jt_gladden/Dev/jarvis/Dockerfile)
- [jarvis-ui/Dockerfile](/Users/jt_gladden/Dev/jarvis/jarvis-ui/Dockerfile)
- [.env.example](/Users/jt_gladden/Dev/jarvis/.env.example)

### For Dockge

1. Create a stack from this repo or paste in `docker-compose.yml`.
2. Copy `.env.example` to `.env` and fill in `OPENAI_API_KEY`, `API_IMAGE`, and `WEB_IMAGE`.
3. Create a local `data/` folder beside the compose file.
4. Put your Gmail OAuth client file at `data/credentials.json`.
5. Start the stack.

Example image values:

- `API_IMAGE=ghcr.io/<your-user-or-org>/<repo>-api:latest`
- `WEB_IMAGE=ghcr.io/<your-user-or-org>/<repo>-web:latest`

The backend stores its persistent local state in the mounted `data/` folder, including:

- `data/token.json`
- `data/journal_entries.db`
- `data/tasks.db`
- `data/health.db`
- `data/movement.db`
- `data/workouts.db`
- `data/assistant_chat.db`
- `data/classification_cache.db`
- `data/classification_guidance.json`

That means Gmail auth, journal entries, task edits/completions, health history, movement history, workout history, assistant chat history, saved classification cache, and guidance survive container restarts as long as the `data/` folder is preserved.

### 3D trail explorer

Jarvis now includes a desktop-only 3D route explorer in the Health Atlas view, adapted from the `trailforkd` Cesium approach.
You can switch between recorded movement/workout routes and import a planned `GPX` or `GeoJSON` track to preview a future hike or excursion.

Optional environment variables:

- `NEXT_PUBLIC_CESIUM_ION_TOKEN` for Cesium World Terrain
- `NEXT_PUBLIC_CESIUM_TERRAIN_URL` for a self-hosted Cesium terrain server

Without those, the explorer still works in flat-globe mode and can render your synced movement/workout routes in 3D with imagery layers.

### Google auth in Docker

You do not need to pre-generate `token.json` anymore.

1. Put your Google OAuth client file at `data/credentials.json`.
2. Start the stack.
3. Open `http://localhost:8000/api/google/oauth/start` in your browser.
4. Sign in to Google and approve access.
5. Jarvis will save the token into the mounted `data/token.json` file automatically.

If your API is running behind a proxy or on a real domain, set `GOOGLE_OAUTH_BASE_URL` in `.env` so Jarvis builds the callback URL correctly.

Notes:

- The OAuth client in `data/credentials.json` still needs to allow the redirect URI you use.
- For local Docker usage, `http://localhost:8000/api/google/oauth/callback` is the simplest callback target.
- The same Google token is shared for Gmail and Calendar scopes.

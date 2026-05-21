# Jarvis PWA — Setup, Usage & Troubleshooting

## What this does

Jarvis is a Progressive Web App (PWA). When installed to your phone's home
screen it opens full-screen (no browser chrome), and the last-loaded data
is available even when you're offline.

### What works offline
- Dashboard overview (last fetched state)
- Email list and individual emails
- Health and movement data
- Journal entries, tasks, agenda

### What requires a connection
- Fetching new emails / running the AI classifier
- Executing email commands (trash, archive, label)
- Syncing health data from the iPhone companion app
- Any write operation — these fail gracefully with an error message

---

## Installing to your iPhone

1. Open Safari and navigate to your Jarvis URL (must be HTTPS).
2. Tap the Share button (box with arrow pointing up).
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **"Add"** in the top-right corner.
5. The Jarvis icon appears on your home screen. Tap it to open in full-screen mode.

> **Why Safari?** iOS only allows PWA install via Safari. Chrome/Firefox on
> iOS cannot trigger the "Add to Home Screen" flow.

---

## How the service worker works

```
npm run build   ← compiles src/app/sw.ts → public/sw.js
                  (uses --webpack, not Turbopack)
npm start       ← serves the app; SW activates on first visit
```

The SW is **not active in `npm run dev`** — Serwist disables itself in
development mode so hot-reloading isn't broken by cache. To test offline
behaviour you must run the production build.

### Cache storage layout

| Cache name         | Contents                          | Max age  |
|--------------------|-----------------------------------|----------|
| serwist-precache-* | All Next.js build assets (JS/CSS) | Until next deploy |
| jarvis-api-cache   | GET /api/* responses              | 24 hours |

---

## Updating the app

When you deploy a new build:
1. The service worker detects the new precache manifest on the next
   page load and downloads changed assets in the background.
2. On the *following* page load the new SW takes control (because
   `skipWaiting: true` is set).
3. Users see the new version after one full page close + reopen.

To **force an immediate update** without waiting:
- Chrome/Android: DevTools → Application → Service Workers → **Update**
- iOS Safari: Settings → Safari → Advanced → Website Data → delete Jarvis,
  then re-add to home screen.

---

## Replacing the app icons

The default icons use a green "J" on a dark background. To use your own:

1. Create a square image at 512×512 px.
2. Export as:
   - `public/icons/icon-192.png` (192×192)
   - `public/icons/icon-512.png` (512×512)
   - `public/icons/icon-maskable-512.png` (512×512, with ~10% safe-zone
     padding for Android adaptive icons)
3. Optionally update `public/icons/icon.svg` for SVG-capable browsers.
4. Run `npm run build` — the new icons are bundled into the precache.

With ImageMagick installed you can generate PNGs from the SVG:
```bash
cd jarvis-ui/public/icons
magick -background "#070a12" -density 300 icon.svg -resize 192x192 icon-192.png
magick -background "#070a12" -density 300 icon.svg -resize 512x512 icon-512.png
magick -background "#070a12" -density 300 icon.svg -resize 512x512 icon-maskable-512.png
```

---

## Troubleshooting

### "Add to Home Screen" prompt never appears

- Must be on **HTTPS** (or `localhost`). Plain HTTP disables PWAs.
- Open DevTools → Application → Manifest. If there are red errors the
  browser won't offer install.
- Common manifest errors:
  - Icon files missing from `public/icons/` — check the paths in `manifest.json`.
  - `_comment` field: some strict parsers reject JSON comments. Remove
    the `_comment` line from `manifest.json` if this causes an issue.

### App opens in browser instead of full-screen

The user must complete the "Add to Home Screen" flow at least once.
After that, tapping the home screen icon opens standalone.

### Stale / wrong data showing offline

The service worker caches GET API responses for up to 24 hours.
To clear the cache manually:

- **Chrome/Android**: DevTools → Application → Cache Storage →
  right-click `jarvis-api-cache` → Delete
- **iOS Safari**: Settings → Safari → Advanced → Website Data →
  find Jarvis → swipe to delete

### Service worker not updating after a deploy

1. Hard-reload the page: **Cmd+Shift+R** (macOS) / **Ctrl+Shift+R** (Windows).
2. Or: DevTools → Application → Service Workers → **Update** button.
3. If still stuck, unregister the SW: DevTools → Application →
   Service Workers → **Unregister**, then reload.

### SW not activating at all

- Confirm `npm run build` completed without errors (the SW is only
  compiled during build, not during `npm run dev`).
- Confirm `public/sw.js` exists after the build.
- Check the browser console for SW registration errors.

### Build error: "Cannot resolve @serwist/next"

```bash
cd jarvis-ui && npm install
```

### Build error in next.config.ts (withSerwist type error)

The `withSerwist` wrapper accepts a config object and returns a function
that wraps the NextConfig. The pattern is:

```typescript
export default withSerwist({ swSrc: "...", swDest: "..." })(nextConfig);
```

If TypeScript complains, check that `@serwist/next` and `serwist` are
both installed at the same version (see package.json).

---

## Key files

| File | Purpose |
|------|---------|
| `src/app/sw.ts` | Service worker source — edit caching rules here |
| `next.config.ts` | Wraps Next.js config with the Serwist build plugin |
| `public/manifest.json` | PWA identity: name, icons, start URL, theme colour |
| `public/icons/` | App icons (PNG + SVG) |
| `src/components/offline-banner.tsx` | Offline status indicator component |
| `src/app/layout.tsx` | Wires up manifest link + offline banner |
| `public/sw.js` | **Build artifact** — generated by `npm run build`, gitignored |

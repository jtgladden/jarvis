/**
 * Jarvis Service Worker
 * ---------------------
 * Compiled by @serwist/next during `npm run build` into public/sw.js.
 * This file is NOT executed directly — Serwist injects the precache
 * manifest (list of all Next.js build assets) via __SW_MANIFEST at
 * build time, then registers event listeners for install / activate /
 * fetch automatically via serwist.addEventListeners().
 *
 * Caching strategies used:
 *   - Precache (build assets): CacheFirst, permanent until next deploy
 *   - Jarvis API routes (/api/*): NetworkFirst with a 10-second timeout.
 *     If the network responds within 10 s the response is cached and
 *     served fresh. If offline (or server unreachable) the last cached
 *     response is returned instead. Entries expire after 24 hours.
 *   - Next.js navigation (page HTML): NetworkFirst so the page shell
 *     always reflects the latest build when online.
 *
 * NOT cached (always requires network):
 *   - POST/PATCH/DELETE requests (email commands, rule changes, etc.)
 *     These will fail gracefully when offline — the UI shows an error.
 *
 * Debugging in Chrome DevTools:
 *   Application → Service Workers → check "Offline" to simulate
 *   Application → Cache Storage → "jarvis-api-cache" to inspect entries
 *   Application → Service Workers → "Update on reload" to force refresh
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

// Required augmentation so TypeScript recognises the manifest injected
// at build time by the Serwist webpack plugin.
declare global {
  interface ServiceWorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  // __SW_MANIFEST is replaced at build time with an array of every
  // hashed static asset (JS chunks, CSS, fonts, images). These are
  // cached on install so the app shell loads instantly offline.
  precacheEntries: self.__SW_MANIFEST,

  // skipWaiting: the new SW takes control immediately on update rather
  // than waiting for all tabs to close. Combined with clientsClaim this
  // means users get the latest version on next page load.
  skipWaiting: true,
  clientsClaim: true,

  // navigationPreload lets the browser start the network fetch for a
  // navigation request in parallel with starting the SW, reducing
  // latency when online.
  navigationPreload: true,

  runtimeCaching: [
    // --- Jarvis API routes ---
    // All GET requests to /api/* use a custom NetworkFirst-style handler.
    //
    // WHY NOT THE BUILT-IN NetworkFirst:
    // Serwist's NetworkFirst only falls back to cache on *network errors*
    // (DNS failure, connection refused, AbortError). If the backend is
    // reachable but itself offline (e.g. can't reach Google APIs), it
    // returns a real HTTP 500. NetworkFirst treats that as a "successful"
    // network response and passes it straight through — the cache is never
    // consulted. This handler also falls back to cache on non-ok responses.
    {
      matcher: ({ url, request }) =>
        url.pathname.startsWith("/api/") && request.method === "GET",
      handler: async ({ request }) => {
        const CACHE_NAME = "jarvis-api-cache"; // Must match SW_API_CACHE_NAME in src/lib/sw-cache.ts
        const NETWORK_TIMEOUT_MS = 10_000;

        let networkResponse: Response | undefined;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
          try {
            networkResponse = await fetch(request.clone(), { signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
        } catch {
          // Network failure or timeout — fall through to cache lookup below.
        }

        if (networkResponse?.ok) {
          // Successful response: refresh the cache and return it.
          const cache = await caches.open(CACHE_NAME);
          void cache.put(request.clone(), networkResponse.clone());
          return networkResponse;
        }

        // Non-ok (e.g. 500 from a backend that can't reach Google) or
        // network error: serve the last cached response if available.
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(request);
        if (cached) return cached;

        // Nothing in cache: return the server error response, or synthesize
        // a 503 if the network was completely unreachable.
        return (
          networkResponse ??
          new Response(
            JSON.stringify({ error: "offline", message: "No cached response available." }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          )
        );
      },
    },

    // --- Default Next.js cache rules ---
    // Provided by @serwist/next: handles Next.js image optimisation,
    // Google Fonts, and static file caching with sensible defaults.
    ...defaultCache,
  ],
});

serwist.addEventListeners();

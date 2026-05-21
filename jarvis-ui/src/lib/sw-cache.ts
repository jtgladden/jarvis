/**
 * sw-cache.ts
 * -----------
 * Utilities for manually warming the service worker's runtime cache
 * from page code.
 *
 * WHY THIS EXISTS
 * ---------------
 * On a user's very first visit, the service worker installs and activates
 * asynchronously AFTER the page's JavaScript has already run and fired its
 * fetch calls. Those fetches bypass the SW entirely, so nothing ends up in
 * the cache. The second visit is when caching actually starts working.
 *
 * To close that gap we write successful fetch responses directly into the
 * Cache API from the page. The SW reads from the same cache store, so on
 * the next offline visit it finds the entries immediately.
 *
 * IMPORTANT: The cache name here must exactly match `cacheName` in sw.ts.
 * If you rename one, rename the other.
 */

export const SW_API_CACHE_NAME = "jarvis-api-cache";

/**
 * Store a fetch response in the SW's API cache.
 *
 * Call this right after a successful API fetch, passing the response
 * BEFORE you call .json() on it (or pass a .clone() if you've already
 * consumed the body).
 *
 * Safe to call unconditionally — it no-ops if:
 *   - Running on the server (no `window`)
 *   - The browser doesn't support the Cache API
 *   - The response is not OK (e.g. 4xx/5xx — we don't cache errors)
 *   - Any unexpected error occurs (it never throws)
 */
export async function warmApiCache(url: string, response: Response): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window) || !response.ok) {
    return;
  }
  // Clone synchronously before the first await. The caller will call
  // .json() on the original response immediately after this function
  // returns control; cloning after an await would find the body already
  // consumed and throw a TypeError (silently swallowed by our catch).
  const cloned = response.clone();
  try {
    const cache = await caches.open(SW_API_CACHE_NAME);
    // Resolve to an absolute URL so the cache key matches what the SW
    // stores when it intercepts the same request.
    const absoluteUrl = new URL(url, window.location.href).href;
    await cache.put(absoluteUrl, cloned);
  } catch {
    // Cache writes are best-effort and must never surface as errors.
  }
}

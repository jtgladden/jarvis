/**
 * next.config.ts
 * --------------
 * The withSerwist wrapper does two things at build time:
 *   1. Compiles src/app/sw.ts → public/sw.js using the Webpack
 *      InjectManifest plugin (this is why `npm run build` uses --webpack).
 *   2. Injects the hashed precache manifest into the compiled SW so it
 *      knows exactly which build assets to cache on install.
 *
 * The SW is NOT active in `npm run dev` (Turbopack mode) — the `disable`
 * flag disables Serwist entirely outside of production so it doesn't
 * inject its webpack plugin and conflict with Turbopack.
 * Run `npm run build && npm start` to test PWA / offline behaviour.
 *
 * If you need to disable the SW entirely (e.g. for debugging), set:
 *   NEXT_PUBLIC_SW_DISABLED=true
 * in your .env.local and add `disable: true` to the withSerwist config.
 *
 * Troubleshooting build errors:
 *   - "Cannot find module '@serwist/next'" → run `npm install`
 *   - SW not updating → hard-reload the page (Cmd+Shift+R) or open
 *     DevTools → Application → Service Workers → click "Update"
 *   - Old cache serving stale data → DevTools → Application →
 *     Cache Storage → delete "jarvis-api-cache" entries manually
 */

import withSerwist from "@serwist/next";
import type { NextConfig } from "next";

const apiProxyTarget = process.env.API_PROXY_TARGET || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxyTarget}/api/:path*`,
      },
    ];
  },
  // Empty turbopack config tells Next.js 16 that Turbopack is intentional
  // for `npm run dev`. Without this, Next.js warns about a webpack config
  // (injected by Serwist) existing alongside Turbopack with no turbopack
  // config. The `disable` flag below prevents Serwist from injecting its
  // webpack config in dev mode entirely, but this field silences the
  // startup check regardless.
  turbopack: {},
};

export default withSerwist({
  // Source: the TypeScript service worker we authored.
  // Serwist compiles this with Webpack (not Turbopack) during build.
  swSrc: "src/app/sw.ts",

  // Destination: must be at the web root so the SW has scope over the
  // whole app. Placing it in /public/ makes it available at /sw.js.
  swDest: "public/sw.js",

  reloadOnOnline: true,

  // Only active during production builds (`npm run build --webpack`).
  // In dev mode (`npm run dev`, which uses Turbopack) Serwist is a no-op
  // so it doesn't inject its webpack plugin and doesn't conflict with
  // Turbopack. The service worker is not needed in dev anyway — HMR
  // would fight with SW caching and make debugging painful.
  disable: process.env.NODE_ENV !== "production",
})(nextConfig);

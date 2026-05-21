/**
 * Root layout
 * -----------
 * PWA additions made here:
 *   1. metadata.manifest — points the browser to manifest.json so
 *      Safari/Chrome show the "Add to Home Screen" prompt.
 *   2. viewport.themeColor — tints the browser UI and the status bar
 *      on iOS when running in standalone mode.
 *   3. metadata.appleWebApp — enables full-screen standalone mode on
 *      iOS (Safari ignores "display: standalone" in the manifest for
 *      historical reasons, so these meta tags are required).
 *   4. <link rel="apple-touch-icon"> — the icon Safari uses for the
 *      home screen bookmark (separate from the manifest icons).
 *   5. <OfflineBanner> — slim top banner shown when navigator.onLine
 *      is false.
 *
 * The service worker is registered automatically by @serwist/next via
 * a script it injects at build time — no manual SW registration needed.
 *
 * Troubleshooting:
 *   - "Add to Home Screen" not appearing? The page must be served over
 *     HTTPS (or localhost). Check DevTools → Application → Manifest for
 *     any manifest parse errors.
 *   - App opens in browser instead of standalone? The user must go
 *     through Share → "Add to Home Screen" at least once. After that it
 *     opens standalone automatically.
 *   - Status bar colour is wrong? Update viewport.themeColor here AND
 *     background_color / theme_color in public/manifest.json.
 *   - Offline banner not showing? Confirm <OfflineBanner /> is rendered
 *     and that your browser is actually offline (not just slow).
 */

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { OfflineBanner } from "@/components/offline-banner";

export const metadata: Metadata = {
  title: "Jarvis",
  description: "Personal AI dashboard — mail, health, journal, and schedule",
  // Tells the browser where to find the PWA manifest.
  manifest: "/manifest.json",
  // iOS-specific: enables standalone (full-screen) mode when launched
  // from the home screen icon.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Jarvis",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Must match theme_color in manifest.json and the app background colour.
  themeColor: "#070a12",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <head>
        {/* iOS home screen icon — Safari uses this rather than the manifest icons. */}
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Shown automatically whenever navigator.onLine flips to false. */}
        <OfflineBanner />
        {children}
      </body>
    </html>
  );
}

"use client";

/**
 * OfflineBanner
 * -------------
 * Listens to the browser's online/offline events and shows a slim banner
 * at the top of the page when the connection is lost.
 *
 * The banner disappears automatically when the connection is restored.
 * No state is persisted — it reflects real-time network status only.
 *
 * Implementation notes:
 *   - navigator.onLine is checked on mount to handle the case where the
 *     page is loaded while already offline (e.g. opening the PWA in
 *     airplane mode from the home screen).
 *   - The banner is purely presentational; it does not block interaction.
 *   - If you want to suppress the banner on a specific page, simply don't
 *     render <OfflineBanner /> in that page's layout.
 *
 * Troubleshooting:
 *   - Banner not appearing when offline? Check that this component is
 *     rendered in layout.tsx (or the relevant page).
 *   - Banner showing when online? navigator.onLine can return false on
 *     some corporate proxies even when there is connectivity. This is a
 *     browser/OS limitation, not a bug in this component.
 */

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    // Sync with actual status on first render — the user may have opened
    // the PWA while already offline.
    setIsOnline(navigator.onLine);

    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);

    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-amber-500/90 px-4 py-2 text-center text-sm font-medium text-amber-950 backdrop-blur-sm"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>You&apos;re offline — showing cached data. Changes won&apos;t sync until reconnected.</span>
    </div>
  );
}

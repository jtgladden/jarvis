/**
 * kill-stale-postcss.mjs
 * ----------------------
 * Next.js 16 / Turbopack runs the PostCSS (Tailwind v4) pipeline in Node
 * subprocesses: `node .next/dev/build/postcss.js <port>`. On Windows these
 * workers are frequently orphaned when the dev server is stopped (Ctrl-C /
 * closing the terminal), so each `npm run dev` leaks another batch until
 * dozens of them pin the machine's RAM.
 *
 * This script runs as a `predev` hook and kills any leftover postcss workers
 * before a new dev server starts. It is best-effort and never fails the build.
 */
import { execSync } from "node:child_process";

try {
  if (process.platform === "win32") {
    // Match the postcss worker command line and force-kill each PID.
    const ps = [
      "Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\"",
      "| Where-Object { $_.CommandLine -like '*\\.next\\dev\\build\\postcss.js*' }",
      "| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    ].join(" ");
    execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: "ignore" });
  } else {
    // macOS / Linux: pkill matches the full command line with -f.
    execSync("pkill -f '.next/dev/build/postcss.js' || true", { stdio: "ignore" });
  }
} catch {
  // No stale workers to kill, or the platform tool isn't available — ignore.
}

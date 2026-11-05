// Browser-wide "is it playing audio?" from macOS power assertions. Process-level only: Chrome
// exposes no per-tab audible flag to AppleScript.
import { execFile } from "node:child_process";

// Pure: true if `pmset -g assertions` shows a "Playing audio" assertion held by the browser's
// main process. Helper processes are named "<browser> Helper…", so the closing paren anchors it.
export function hasAudioAssertion(pmsetOutput: string, browser: string): boolean {
  const esc = browser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`pid \\d+\\(${esc}\\):.*"Playing audio"`).test(pmsetOutput);
}

// null = could not tell (non-macOS, pmset missing/failed); callers omit the line.
export function isBrowserPlayingAudio(browser: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("pmset", ["-g", "assertions"], { timeout: 5_000 }, (err, stdout) =>
      resolve(err ? null : hasAudioAssertion(stdout, browser)),
    );
  });
}

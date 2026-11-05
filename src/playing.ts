// Per-tab "is it making sound?" best effort. Chrome has no audible flag over AppleScript, so we
// probe <video>/<audio> elements in likely tabs. Must degrade, not fail, when Apple Events
// JavaScript is disabled: then we return the URL-based candidates as unverified.
import type { ChromeTab } from "./applescript.ts";
import { isJsDisabledError } from "./applescript.ts";

export const MAX_PROBES = 100;

// Sites that usually play media or calls. Only a hint for narrowing the probe.
const CANDIDATE_URL =
  /youtube\.com|youtu\.be|music\.|spotify|soundcloud|twitch|netflix|hulu|primevideo|disneyplus|max\.com|vimeo|bandcamp|deezer|tidal|pandora|podcast|meet\.google|zoom\.us|teams\.(microsoft|live)|\.(mp3|mp4|m4a|webm|ogg|wav)(\?|$)/i;

export const isCandidate = (t: ChromeTab) => CANDIDATE_URL.test(t.url);

// Runs in the page. Counts only audible-looking media: playing, unmuted, volume > 0.
export const PROBE_JS =
  "JSON.stringify([...document.querySelectorAll('video,audio')].some(m=>!m.paused&&!m.ended&&!m.muted&&m.volume>0&&m.readyState>2))";

export interface PlayingResult {
  playing: ChromeTab[]; // probe says media is playing
  silent: ChromeTab[]; // probed, nothing playing
  unverified: ChromeTab[]; // candidates we could not probe
  unknown: ChromeTab[]; // probe errored for this tab (chrome://, closed, …)
  jsDisabled: boolean;
  truncated: number; // candidates beyond MAX_PROBES that were not examined
}

// `probe` returns the page's JSON result string, or throws. Injected so this is testable.
export async function findPlaying(
  tabs: ChromeTab[],
  probe: (tabId: string) => Promise<string>,
  all = false,
): Promise<PlayingResult> {
  const candidates = all ? tabs : tabs.filter(isCandidate);
  const batch = candidates.slice(0, MAX_PROBES);
  const r: PlayingResult = {
    playing: [],
    silent: [],
    unverified: [],
    unknown: [],
    jsDisabled: false,
    truncated: candidates.length - batch.length,
  };
  for (const [i, tab] of batch.entries()) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: stop at the first JS-disabled error
      (JSON.parse(await probe(tab.id)) === true ? r.playing : r.silent).push(tab);
    } catch (error) {
      if (isJsDisabledError(error instanceof Error ? error.message : String(error))) {
        // Setting is global per profile: every remaining probe would fail the same way.
        r.jsDisabled = true;
        r.unverified = batch.slice(i);
        break;
      }
      r.unknown.push(tab);
    }
  }
  return r;
}

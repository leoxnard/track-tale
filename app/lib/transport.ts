/**
 * Legs that were *travelled* rather than ridden: a train, a ferry, a bus.
 *
 * A tour is not always continuous under its own power — a stretch gets skipped
 * by rail, an island is reached by boat. Those kilometres belong on the map,
 * because the line would otherwise jump, but they do not belong in what was
 * ridden: counting a two-hour train ride as distance covered inflates the
 * day's stats and the progress bar alike.
 *
 * The mode lives in the segment's existing `sport` column — it is the same
 * kind of fact ("how was this moved through") that Komoot fills in there, and
 * it needs no migration.
 */

export const TRANSIT_MODES = ["train", "ferry", "bus"] as const;
export type TransitMode = (typeof TRANSIT_MODES)[number];

/** Umlauts folded rather than stripped: `fähre` must not become `fahre`. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ");
}

/**
 * Whole words only, so a hike along `Bahnhofstrasse` stays a hike. German
 * compounds are spelled out because that is how a track ends up named in a
 * chat: "Zugfahrt Aberdeen – Forres".
 */
const PATTERNS: [TransitMode, RegExp][] = [
  ["train", /\b(train|rail|railway|zug|zugfahrt|bahn|bahnfahrt|eisenbahn|sbahn|ubahn)\b/],
  ["ferry", /\b(ferry|faehre|faehrfahrt|schiff|boat)\b/],
  ["bus", /\b(bus|busfahrt|coach|autobus|reisebus)\b/],
];

/**
 * The mode named by any of `texts` — a GPX `<type>`, a track name — or null
 * when none of them says one. The first text that classifies wins, so callers
 * pass the most authoritative field first.
 */
export function classifyTransit(...texts: (string | null | undefined)[]): TransitMode | null {
  for (const text of texts) {
    if (!text) continue;
    const haystack = normalize(text);
    for (const [mode, pattern] of PATTERNS) {
      if (pattern.test(haystack)) return mode;
    }
  }
  return null;
}

/** The stored `sport` read back as a transit mode, or null for anything ridden. */
export function transitMode(sport: string | null | undefined): TransitMode | null {
  return (TRANSIT_MODES as readonly string[]).includes(sport ?? "")
    ? (sport as TransitMode)
    : null;
}

export function isTransit(sport: string | null | undefined): boolean {
  return transitMode(sport) !== null;
}

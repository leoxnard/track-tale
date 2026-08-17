/**
 * A trip's own logo, derived from its name.
 *
 * It exists for one place only: the icon a phone puts on its home screen when
 * somebody adds the family page there. Several trips added side by side would
 * otherwise be several identical tiles, and the point of the link is that it is
 * *this* journey — so the tile has to say which one without a caption, because
 * home screens crop captions to nothing.
 *
 * Nothing is stored and nothing is generated at trip creation: the name *is*
 * the seed, so the same name always draws the same tile, and a renamed trip
 * simply has a different one from that moment on. The alternative — an image
 * rendered when the trip is made and kept in a bucket behind a new column —
 * buys nothing here (there is no randomness to preserve) and costs a schema
 * change, an upload, and a stale tile after every `/renametrip`.
 *
 * Pure on purpose: the rasteriser lives in `trip-logo.server.ts`, so the shape
 * of the thing can be tested without a font file or a native module.
 */

/** The sizes a browser may ask for. An allowlist — the size is in a public URL. */
export const ICON_SIZES = [180, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

/** The size iOS takes for `apple-touch-icon`; the others are the manifest's. */
export const APPLE_ICON_SIZE: IconSize = 180;

/**
 * Deep, unsaturated grounds — a home screen sits behind a photograph, and a
 * bright tile shouts at everything around it. Each is a pair because the tile
 * is a gradient: flat colour at 180 px reads as a placeholder.
 */
const GROUNDS: readonly (readonly [string, string])[] = [
  ["#1e3a2f", "#2f5a45"], // pine, the page's own green
  ["#1d3557", "#31597f"], // deep sea
  ["#4a2545", "#6d3a62"], // plum
  ["#5c2f1b", "#8a4a2a"], // rust
  ["#2c3a47", "#4a5c6b"], // slate
  ["#33421c", "#55692f"], // moss
  ["#3b2a4d", "#5a4173"], // heather
  ["#123f43", "#1f6a6f"], // teal
  ["#4d1f2e", "#7a3348"], // claret
  ["#2b2f1a", "#4c5330"], // olive
];

/** The mark and the line sit in the page's paper, on every ground. */
const PAPER = "#fbfaf7";

/**
 * FNV-1a. Small, stable across runtimes, and — unlike anything built in — the
 * same number next month, which is the only property that matters: the tile's
 * URL carries this hash so a phone can cache the icon forever and still notice
 * a rename.
 */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Stray spacing is not part of a trip's identity, but **case is**: a capital in
 * the middle of a word is where "HighlandKinder" says its second word starts,
 * and lowercasing here would leave the tile reading HI.
 */
function normalise(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** mulberry32 — a handful of numbers from one seed, deterministically. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tile's version, and the whole of it: everything drawn comes out of this
 * number, so two names share an icon exactly when they share this string.
 */
export function logoVersion(name: string): string {
  return hash32(normalise(name)).toString(36);
}

/**
 * The words of a name, as a reader sees them rather than as the spaces have it.
 *
 * A space is one way to write two words and a capital letter is another:
 * "HighlandKinder" is two, and treating it as one gives a tile reading HI. So
 * anything that is not a letter or a digit separates, and inside what is left a
 * capital following a lower-case letter starts the next word.
 *
 * The three alternatives are, in order: a word with at most one capital at the
 * front ("Highland"), a run of capitals not followed by a lower-case letter
 * ("GPX", and the "AC" of "ACRoute"), and a run of digits. Anything the fonts
 * have no glyph for — punctuation, emoji — is separator and never a letter.
 */
function wordsOf(name: string): string[] {
  return normalise(name)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap((w) => w.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+/gu) ?? []);
}

/**
 * Up to two letters: the initials of the first two words, or the first two
 * letters of a single word.
 *
 * `Array.from` because a name may open with a character outside the BMP; a
 * `slice(0, 2)` there would cut a surrogate pair in half.
 */
export function logoInitials(name: string): string {
  const words = wordsOf(name);
  if (words.length === 0) return "TT";
  if (words.length === 1) return Array.from(words[0]).slice(0, 2).join("").toUpperCase();
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

/**
 * A route across the tile, in the shape of the thing the page is about.
 *
 * Deliberately behind the letters and deliberately faint: at 60 px on a home
 * screen it is texture, not a map, and anything more legible fights the two
 * characters that actually name the trip. Drawn in a 100×100 box and scaled by
 * the renderer, so one path serves every size.
 */
function routePath(seed: number): string {
  const next = rng(seed);
  const steps = 5;
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const x = -8 + ((116 / steps) * i);
    // Kept off the middle band, where the letters are, and away from the two
    // corners a rounded mask eats.
    const y = 22 + next() * 56;
    pts.push([x, y]);
  }

  // Quadratic smoothing through midpoints: the corner between two segments
  // becomes a bend, which is what a road looks like and a polyline never does.
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [cx, cy] = pts[i];
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` T ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/**
 * The tile as SVG, at `size` pixels square.
 *
 * Full-bleed, with no rounded corners of its own: iOS rounds the icon itself
 * and Android may crop it to a circle, so the ground has to reach every edge
 * and the mark has to stay inside the middle. That is why the letters sit dead
 * centre and the route line runs out past both sides — nothing that carries
 * meaning is within a mask's reach.
 */
export function tripLogoSvg(name: string, size: number): string {
  const seed = hash32(normalise(name));
  const [from, to] = GROUNDS[seed % GROUNDS.length];
  const initials = escapeXml(logoInitials(name));
  // Two letters at 44 fill the safe circle; one would sit small in the middle
  // of it, so a single letter is drawn larger rather than lonely.
  const fontSize = Array.from(initials).length > 1 ? 42 : 56;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="${to}"/>
      <stop offset="1" stop-color="${from}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#g)"/>
  <path d="${routePath(seed)}" fill="none" stroke="${PAPER}" stroke-opacity="0.24"
        stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="50" y="${(50 + fontSize * 0.35).toFixed(1)}" text-anchor="middle"
        font-family="Atkinson Hyperlegible" font-weight="700" font-size="${fontSize}"
        fill="${PAPER}">${initials}</text>
</svg>`;
}

/** The name in the icon URL. Inverse of `parseIconFile`. */
export function iconFileName(size: IconSize): string {
  return `icon-${size}.png`;
}

/**
 * Read a size back off the URL, or null if it is not one of ours. An allowlist
 * rather than a number: the URL is public, and `icon-8000.png` would otherwise
 * be a rasteriser anybody can point at.
 */
export function parseIconFile(file: string): IconSize | null {
  const m = /^icon-(\d+)\.png$/.exec(file);
  if (!m) return null;
  const size = Number(m[1]);
  return (ICON_SIZES as readonly number[]).includes(size) ? (size as IconSize) : null;
}

/** Where the icon of a given size lives, version-stamped so a rename shows. */
export function iconHref(slug: string, size: IconSize, name: string): string {
  return `/t/${slug}/icon/${iconFileName(size)}?v=${logoVersion(name)}`;
}

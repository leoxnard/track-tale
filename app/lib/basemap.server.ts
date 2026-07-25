import { env } from "./env.server";
import type { MercatorLayout } from "./geo-project";

/**
 * Raster map tiles for the share card.
 *
 * The interactive map uses OpenFreeMap, but that is vector-only and needs a
 * browser to draw. The card is rendered to PNG on the server by resvg, so it
 * needs ready-made raster tiles — hence a second, keyed provider.
 *
 * Every failure here is non-fatal: the caller falls back to the plain card
 * rather than leaving a trip without a preview image.
 */

/**
 * MapTiler's styles are natively 512 px per tile, not the classic 256. The
 * world-pixel grid has to use the same number or labels come out half-size, and
 * at 512 the tile lands 1:1 in the 1200 px card with no resampling at all.
 */
export const BASEMAP_TILE_PX = 512;
const FETCH_TIMEOUT_MS = 4000;
/**
 * A 1200x630 card needs at most 4x3 tiles at 512 px. The cap is a runaway
 * guard with headroom — sitting it exactly on the maximum would silently drop
 * the basemap the first time the card geometry changed.
 */
const MAX_TILES = 24;

function tileUrl(z: number, x: number, y: number, key: string): string {
  // No @2x: the card is rendered at its native 1200 px, so a 512 px tile in a
  // 512 px slot is already pixel-exact, and @2x would triple the bytes fetched
  // on every single track upload for nothing.
  return `https://api.maptiler.com/maps/${env.maptilerStyle}/${z}/${x}/${y}.png?key=${key}`;
}

/**
 * Fetch the tiles covering `layout`'s box and return them as SVG <image>
 * elements, positioned so the projected route lands on the right roads.
 * Returns "" when no key is configured or anything at all goes wrong.
 */
export async function basemapSvg(layout: MercatorLayout): Promise<string> {
  const key = env.maptilerKey;
  if (!key) return "";

  const { zoom, left, top, box } = layout;
  const span = 2 ** zoom;
  const x0 = Math.floor(left / BASEMAP_TILE_PX);
  const x1 = Math.floor((left + box.w) / BASEMAP_TILE_PX);
  const y0 = Math.floor(top / BASEMAP_TILE_PX);
  const y1 = Math.floor((top + box.h) / BASEMAP_TILE_PX);

  // Each tile carries the slot it must be drawn in, so wrapping at the
  // antimeridian or skipping a row past the pole cannot shift the rest.
  const wanted: { x: number; y: number; px: number; py: number }[] = [];
  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= span) continue; // nothing exists above the pole
    for (let tx = x0; tx <= x1; tx++) {
      wanted.push({
        x: ((tx % span) + span) % span,
        y: ty,
        px: box.x + tx * BASEMAP_TILE_PX - left,
        py: box.y + ty * BASEMAP_TILE_PX - top,
      });
    }
  }
  if (wanted.length === 0 || wanted.length > MAX_TILES) return "";

  try {
    const images = await Promise.all(
      wanted.map(async (t) => {
        const res = await fetch(tileUrl(zoom, t.x, t.y, key), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "TrackTale private trip journal" },
        });
        if (!res.ok) throw new Error(`tile ${zoom}/${t.x}/${t.y} → ${res.status}`);
        const b64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        return `<image x="${t.px.toFixed(1)}" y="${t.py.toFixed(1)}" width="${BASEMAP_TILE_PX}" height="${BASEMAP_TILE_PX}" href="data:image/png;base64,${b64}"/>`;
      }),
    );
    return images.join("");
  } catch (err) {
    console.error("share card basemap unavailable, falling back to plain card", err);
    return "";
  }
}

/** MapTiler's terms require this on every rendered map. */
export const BASEMAP_ATTRIBUTION = "© MapTiler © OpenStreetMap contributors";

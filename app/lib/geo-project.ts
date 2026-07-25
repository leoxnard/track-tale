import type { TrackPoint } from "./track";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Projection {
  project(p: TrackPoint): [number, number];
}

/**
 * Equirectangular projection with a cosine correction, fitted to a box.
 * Accurate enough at trip scale and needs no mapping library — which matters
 * for the share card and for archives that must render without a network.
 */
export function makeProjection(points: TrackPoint[], box: Box): Projection {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);

  const xs = lngs.map((l) => l * k);
  const ys = lats.map((l) => -l);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;
  const scale = Math.min(box.w / spanX, box.h / spanY);
  const offX = box.x + (box.w - spanX * scale) / 2;
  const offY = box.y + (box.h - spanY * scale) / 2;

  return {
    project(p) {
      return [offX + (p.lng * k - minX) * scale, offY + (-p.lat - minY) * scale];
    },
  };
}

/** Fractional tile coordinates at a given zoom — the Web Mercator convention. */
export function lngToTileX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * 2 ** zoom;
}

export function latToTileY(lat: number, zoom: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** zoom;
}

export interface MercatorLayout extends Projection {
  /** Integer zoom whose native tiles fill the box without upscaling. */
  zoom: number;
  /** World-pixel coordinate of the box's left/top edge at that zoom. */
  left: number;
  top: number;
  tileSize: number;
  box: Box;
}

/**
 * Web Mercator layout fitted to a box, chosen so a whole number of map tiles
 * covers it. Unlike {@link makeProjection} this has to match what tile servers
 * do exactly, or the drawn route slides off the roads underneath it.
 *
 * The zoom is the largest whose native pixels still fit the track in the box,
 * so tiles are drawn at or below 1:1 and never blown up.
 */
export function makeMercatorLayout(
  points: TrackPoint[],
  box: Box,
  { tileSize = 256, maxZoom = 16 }: { tileSize?: number; maxZoom?: number } = {},
): MercatorLayout {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  // Span at zoom 0, where the whole world is one tile.
  const spanX = lngToTileX(Math.max(...lngs), 0) - lngToTileX(Math.min(...lngs), 0);
  const spanY = latToTileY(Math.min(...lats), 0) - latToTileY(Math.max(...lats), 0);

  const fitX = spanX > 0 ? box.w / (spanX * tileSize) : Infinity;
  const fitY = spanY > 0 ? box.h / (spanY * tileSize) : Infinity;
  const fit = Math.min(fitX, fitY);
  const zoom = Number.isFinite(fit)
    ? Math.max(0, Math.min(maxZoom, Math.floor(Math.log2(fit))))
    : maxZoom;

  const scale = tileSize * 2 ** zoom;
  const cx = ((lngToTileX(Math.min(...lngs), 0) + lngToTileX(Math.max(...lngs), 0)) / 2) * scale;
  const cy = ((latToTileY(Math.min(...lats), 0) + latToTileY(Math.max(...lats), 0)) / 2) * scale;
  const left = cx - box.w / 2;
  const top = cy - box.h / 2;

  return {
    zoom,
    left,
    top,
    tileSize,
    box,
    project(p) {
      return [
        box.x + lngToTileX(p.lng, zoom) * tileSize - left,
        box.y + latToTileY(p.lat, zoom) * tileSize - top,
      ];
    },
  };
}

export function polylinePoints(points: TrackPoint[], proj: Projection): string {
  return points.map((p) => proj.project(p).map((n) => n.toFixed(1)).join(",")).join(" ");
}

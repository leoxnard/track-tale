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

export function polylinePoints(points: TrackPoint[], proj: Projection): string {
  return points.map((p) => proj.project(p).map((n) => n.toFixed(1)).join(",")).join(" ");
}

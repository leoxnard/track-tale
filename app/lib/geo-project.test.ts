import { describe, expect, it } from "vitest";
import {
  latToTileY,
  lngToTileX,
  makeMercatorLayout,
  makeProjection,
  polylinePoints,
  type Box,
} from "./geo-project";
import type { TrackPoint } from "./track";

const box: Box = { x: 0, y: 0, w: 200, h: 100 };
// Taller than it is wide once the cosine correction is applied, so the height
// is the constraining axis.
const track: TrackPoint[] = [
  { lat: 48.1, lng: 11.5 },
  { lat: 48.2, lng: 11.7 },
  { lat: 48.15, lng: 11.6 },
];

describe("makeProjection", () => {
  it("keeps every point inside the box", () => {
    const proj = makeProjection(track, box);
    for (const p of track) {
      const [x, y] = proj.project(p);
      expect(x).toBeGreaterThanOrEqual(box.x - 1e-6);
      expect(x).toBeLessThanOrEqual(box.x + box.w + 1e-6);
      expect(y).toBeGreaterThanOrEqual(box.y - 1e-6);
      expect(y).toBeLessThanOrEqual(box.y + box.h + 1e-6);
    }
  });

  it("fills the constraining axis exactly and centres the other", () => {
    const proj = makeProjection(track, box);
    const xs = track.map((p) => proj.project(p)[0]);
    const ys = track.map((p) => proj.project(p)[1]);

    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(box.h, 6);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(box.w);
    // Equal slack left and right — the track sits in the middle.
    expect(Math.min(...xs) - box.x).toBeCloseTo(box.x + box.w - Math.max(...xs), 6);
  });

  it("puts north at the top", () => {
    const proj = makeProjection(track, box);
    const northernmost = proj.project({ lat: 48.2, lng: 11.7 })[1];
    const southernmost = proj.project({ lat: 48.1, lng: 11.5 })[1];
    expect(northernmost).toBeLessThan(southernmost);
  });

  it("honours the box origin", () => {
    const offset = makeProjection(track, { x: 30, y: 10, w: 200, h: 100 });
    const ys = track.map((p) => offset.project(p)[1]);
    expect(Math.min(...ys)).toBeCloseTo(10, 6);
  });

  it("survives a track with no extent", () => {
    const proj = makeProjection([{ lat: 48, lng: 11 }], box);
    const [x, y] = proj.project({ lat: 48, lng: 11 });
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });
});

describe("makeMercatorLayout", () => {
  const card: Box = { x: 48, y: 48, w: 1104, h: 390 };

  it("agrees with the tile grid it will be drawn over", () => {
    // The whole point of this projection: a point's position must be exactly
    // where the tile covering it puts it, or the route misses the roads.
    const layout = makeMercatorLayout(track, card);
    for (const p of track) {
      const [x, y] = layout.project(p);
      const expectedX =
        card.x + lngToTileX(p.lng, layout.zoom) * layout.tileSize - layout.left;
      const expectedY =
        card.y + latToTileY(p.lat, layout.zoom) * layout.tileSize - layout.top;
      expect(x).toBeCloseTo(expectedX, 9);
      expect(y).toBeCloseTo(expectedY, 9);
    }
  });

  it("picks a zoom whose native tiles still fit the track in the box", () => {
    const layout = makeMercatorLayout(track, card);
    const xs = track.map((p) => layout.project(p)[0]);
    const ys = track.map((p) => layout.project(p)[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(card.w);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(card.h);

    // ...and it is the largest such zoom: each step doubles the span, so one
    // level further in would overflow. Otherwise we are throwing away detail.
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    expect(spanX * 2 > card.w || spanY * 2 > card.h).toBe(true);
  });

  it("centres the track in the box", () => {
    const layout = makeMercatorLayout(track, card);
    const xs = track.map((p) => layout.project(p)[0]);
    expect(Math.min(...xs) - card.x).toBeCloseTo(card.x + card.w - Math.max(...xs), 6);
  });

  it("puts north at the top", () => {
    const layout = makeMercatorLayout(track, card);
    expect(layout.project({ lat: 48.2, lng: 11.7 })[1]).toBeLessThan(
      layout.project({ lat: 48.1, lng: 11.5 })[1],
    );
  });

  it("clamps to the zoom cap for a track with no extent", () => {
    const layout = makeMercatorLayout([{ lat: 48, lng: 11 }], card, { maxZoom: 12 });
    const [x, y] = layout.project({ lat: 48, lng: 11 });
    expect(layout.zoom).toBe(12);
    expect(x).toBeCloseTo(card.x + card.w / 2, 6);
    expect(y).toBeCloseTo(card.y + card.h / 2, 6);
  });

  it("keeps latitudes past the Mercator limit finite", () => {
    const layout = makeMercatorLayout([{ lat: 89.9, lng: 0 }, { lat: 60, lng: 10 }], card);
    expect(Number.isFinite(layout.project({ lat: 89.9, lng: 0 })[1])).toBe(true);
  });
});

describe("polylinePoints", () => {
  it("formats one x,y pair per point", () => {
    const proj = makeProjection(track, box);
    const svg = polylinePoints(track, proj);
    expect(svg.split(" ")).toHaveLength(track.length);
    expect(svg).toMatch(/^-?\d+\.\d,-?\d+\.\d( -?\d+\.\d,-?\d+\.\d)*$/);
  });
});

import { describe, expect, it } from "vitest";
import { makeProjection, polylinePoints, type Box } from "./geo-project";
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

describe("polylinePoints", () => {
  it("formats one x,y pair per point", () => {
    const proj = makeProjection(track, box);
    const svg = polylinePoints(track, proj);
    expect(svg.split(" ")).toHaveLength(track.length);
    expect(svg).toMatch(/^-?\d+\.\d,-?\d+\.\d( -?\d+\.\d,-?\d+\.\d)*$/);
  });
});

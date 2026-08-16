import { describe, expect, it } from "vitest";
import { haversineM, type TrackPoint } from "./track";
import { clampTargetKm, cutPlan, MAX_TARGET_KM, MIN_TARGET_KM } from "./route-cut";

/**
 * A straight plan due east along the equator-ish 50th parallel, one vertex
 * every ~1 km, 200 km long. Straight and evenly spaced so every expectation
 * below can be worked out on paper.
 */
const STEP_DEG = 0.0139; // ≈ 1 km of longitude at 50° N
const plan: TrackPoint[] = Array.from({ length: 201 }, (_, i) => ({
  lat: 50,
  lng: 8 + i * STEP_DEG,
  alt: 100 + i,
}));

function length(points: TrackPoint[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineM(points[i - 1], points[i]);
  return sum;
}

// Summed segment by segment, as the cut measures it: a line of constant
// latitude is not a great circle, so the distance straight from end to end is
// eleven metres shorter over these two hundred kilometres.
const planLength = length(plan);

describe("cutPlan", () => {
  it("returns null without a plan", () => {
    expect(cutPlan([], { lat: 50, lng: 8 }, 130_000)).toBeNull();
  });

  it("cuts the target length from where the position joins the plan", () => {
    const cut = cutPlan(plan, { lat: 50, lng: plan[20].lng }, 50_000)!;

    expect(cut.cutM).toBeCloseTo(50_000, 0);
    expect(cut.startM).toBeCloseTo(length(plan.slice(0, 21)), 0);
    expect(cut.remainingM).toBeCloseTo(planLength - cut.startM - 50_000, 0);
    expect(cut.reachedEnd).toBe(false);
  });

  it("starts at the position and joins the plan from off it", () => {
    // Two kilometres north of the line, level with vertex 20.
    const from = { lat: 50.018, lng: plan[20].lng };
    const cut = cutPlan(plan, from, 30_000)!;

    expect(cut.points[0]).toEqual({ lat: from.lat, lng: from.lng });
    expect(cut.joinM).toBeGreaterThan(1900);
    expect(cut.joinM).toBeLessThan(2100);
    // The join point is on the line, at the position's own longitude.
    expect(cut.points[1].lat).toBeCloseTo(50, 5);
    expect(cut.points[1].lng).toBeCloseTo(from.lng, 5);
    // The join leg is extra: the day is still the full 30 km of plan.
    expect(cut.cutM).toBeCloseTo(30_000, 0);
    expect(length(cut.points)).toBeCloseTo(30_000 + cut.joinM, 0);
  });

  it("ends exactly on the target rather than at the next vertex", () => {
    // Vertices are a kilometre apart, so a target between two of them would
    // overshoot by up to that much if the cut stopped at a vertex.
    const cut = cutPlan(plan, { lat: 50, lng: plan[0].lng }, 10_500)!;
    expect(cut.cutM).toBeCloseTo(10_500, 0);
    expect(length(cut.points)).toBeCloseTo(10_500, 0);
  });

  it("interpolates elevation onto the cut ends", () => {
    const cut = cutPlan(plan, { lat: 50, lng: plan[10].lng }, 5_500)!;
    const last = cut.points[cut.points.length - 1];
    // 100 m at vertex 0, a metre per kilometre: 15.5 km in is about 115.5 m.
    expect(last.alt).toBeCloseTo(115.5, 0);
  });

  it("stops at the end of the plan and says so", () => {
    const cut = cutPlan(plan, { lat: 50, lng: plan[180].lng }, 130_000)!;

    expect(cut.reachedEnd).toBe(true);
    expect(cut.remainingM).toBeCloseTo(0, 0);
    expect(cut.cutM).toBeCloseTo(planLength - cut.startM, 0);
    expect(cut.points[cut.points.length - 1].lng).toBeCloseTo(plan[200].lng, 5);
  });

  it("carries no timestamps into the file", () => {
    const timed = plan.map((p, i) => ({ ...p, time: 1_700_000_000_000 + i * 60_000 }));
    const cut = cutPlan(timed, { lat: 50, lng: timed[0].lng }, 20_000)!;
    expect(cut.points.every((p) => p.time === undefined)).toBe(true);
  });

  it("does not repeat the position as the join point when it is on the line", () => {
    const cut = cutPlan(plan, { lat: 50, lng: plan[5].lng }, 10_000)!;
    expect(cut.joinM).toBeLessThan(5);
    expect(haversineM(cut.points[0], cut.points[1])).toBeGreaterThan(5);
  });

  it("copies a dense plan out vertex for vertex", () => {
    // A route fetched at full resolution has points a few metres apart through
    // a bend. Thinning them here would undo the reason for fetching it: the
    // file has to describe the road closely enough for an importer to match it.
    const dense: TrackPoint[] = Array.from({ length: 400 }, (_, i) => ({
      lat: 50 + Math.sin(i / 20) * 0.00005,
      lng: 8 + i * 0.00004, // ≈ 3 m apart
    }));
    const cut = cutPlan(dense, { lat: dense[0].lat, lng: dense[0].lng }, 100_000)!;

    expect(cut.reachedEnd).toBe(true);
    // Every vertex, plus nothing: the position coincides with the first one.
    expect(cut.points).toHaveLength(dense.length);
    expect(cut.points[200].lat).toBeCloseTo(dense[200].lat, 9);
  });

  it("handles a one-point plan without inventing a ride", () => {
    const cut = cutPlan([{ lat: 50, lng: 8 }], { lat: 50.01, lng: 8 }, 130_000)!;
    expect(cut.cutM).toBe(0);
    expect(cut.reachedEnd).toBe(true);
    expect(cut.joinM).toBeGreaterThan(1000);
  });

  it("picks the nearest pass of a route that doubles back on itself", () => {
    // Out along the parallel and back a kilometre to the north: a position
    // beside the return leg must cut the return leg, not the outward one.
    const out: TrackPoint[] = Array.from({ length: 51 }, (_, i) => ({
      lat: 50,
      lng: 8 + i * STEP_DEG,
    }));
    const back: TrackPoint[] = Array.from({ length: 51 }, (_, i) => ({
      lat: 50.009,
      lng: 8 + (50 - i) * STEP_DEG,
    }));
    const loop = [...out, ...back];

    const cut = cutPlan(loop, { lat: 50.0085, lng: 8 + 25 * STEP_DEG }, 10_000)!;
    // Heading west on the return leg, so the far end is west of the start.
    expect(cut.points[cut.points.length - 1].lng).toBeLessThan(cut.points[0].lng);
    expect(cut.points[cut.points.length - 1].lat).toBeCloseTo(50.009, 4);
  });
});

describe("clampTargetKm", () => {
  it("holds a length inside what a day can be", () => {
    expect(clampTargetKm(130)).toBe(130);
    expect(clampTargetKm(0)).toBe(MIN_TARGET_KM);
    expect(clampTargetKm(9999)).toBe(MAX_TARGET_KM);
    expect(clampTargetKm(132.4)).toBe(132);
  });
});

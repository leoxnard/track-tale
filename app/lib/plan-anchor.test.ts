import { describe, expect, it } from "vitest";
import { buildPlanIndex, median } from "./plan-anchor";
import { haversineM, type TrackPoint } from "./track";

/** A due-east line at a fixed latitude, `vertices` points spanning `spanDeg`. */
function eastLine(vertices: number, spanDeg = 1): TrackPoint[] {
  return Array.from({ length: vertices }, (_, i) => ({
    lat: 47,
    lng: 11 + (i * spanDeg) / (vertices - 1),
  }));
}

describe("buildPlanIndex", () => {
  it("measures distance along the route", () => {
    const plan = eastLine(101);
    const index = buildPlanIndex(plan);
    const wholeLine = haversineM(plan[0], plan[plan.length - 1]);

    expect(index.totalM).toBeCloseTo(wholeLine, -1);
    expect(index.anchor(plan[0])!.d).toBeCloseTo(0, 5);
    expect(index.anchor(plan[50])!.d).toBeCloseTo(wholeLine / 2, -1);
    expect(index.anchor(plan[100])!.d).toBeCloseTo(wholeLine, -1);
  });

  it("is as accurate on a coarse plan as on a dense one", () => {
    // The bug this exists for. A planned GPX can carry a handful of waypoints
    // over a whole day; matching to the nearest *vertex* quantises every answer
    // to that spacing, which is what made a day ridden exactly on the plan
    // appear to overlap the day before it. Projecting onto the segment does not
    // care how many points the plan was drawn with.
    const dense = buildPlanIndex(eastLine(1001));
    const coarse = buildPlanIndex(eastLine(3));
    const somewhere = { lat: 47, lng: 11.35 };

    const expected = dense.anchor(somewhere)!.d;
    expect(coarse.anchor(somewhere)!.d).toBeCloseTo(expected, -1);

    // Spelled out: the nearest vertex of the coarse plan is tens of kilometres
    // from the true position, and that whole error used to land on the chart.
    const nearestVertex = 0.5 * dense.totalM;
    expect(Math.abs(nearestVertex - expected)).toBeGreaterThan(10_000);
  });

  it("reports how far off the route a coordinate was", () => {
    const index = buildPlanIndex(eastLine(11));
    expect(index.anchor({ lat: 47, lng: 11.5 })!.gap).toBeLessThan(1);
    // A kilometre north of the line, halfway along it.
    const off = index.anchor({ lat: 47.009, lng: 11.5 })!;
    expect(off.gap).toBeGreaterThan(900);
    expect(off.gap).toBeLessThan(1100);
    expect(off.d).toBeCloseTo(index.totalM / 2, -2);
  });

  it("puts anchors on the authoritative planned distance", () => {
    // The chart's axis is the distance the plan was imported with, not the one
    // measured off the thinned coordinates it draws.
    const index = buildPlanIndex(eastLine(101), 200_000);
    expect(index.totalM).toBeCloseTo(200_000, 5);
    expect(index.anchor({ lat: 47, lng: 11.5 })!.d).toBeCloseTo(100_000, -2);
  });

  it("needs no elevation to match against", () => {
    // A plan exported without elevation still has a shape, and anchoring is
    // purely about shape — the grey line is what needs the altitudes.
    const index = buildPlanIndex(eastLine(11));
    expect(index.anchor({ lat: 47, lng: 11.25 })!.d).toBeCloseTo(index.totalM / 4, -2);
  });

  it("clamps to the ends rather than running off them", () => {
    const index = buildPlanIndex(eastLine(11));
    expect(index.anchor({ lat: 47, lng: 9 })!.d).toBeCloseTo(0, 5);
    expect(index.anchor({ lat: 47, lng: 14 })!.d).toBeCloseTo(index.totalM, 5);
  });

  it("survives plans it cannot work with", () => {
    expect(buildPlanIndex([]).anchor({ lat: 47, lng: 11 })).toBeNull();
    expect(buildPlanIndex([]).totalM).toBe(0);

    const single = buildPlanIndex([{ lat: 47, lng: 11 }]);
    expect(single.anchor({ lat: 47, lng: 11 })).toEqual({ d: 0, gap: 0 });

    // A plan that never moves has no length to divide by.
    const still = buildPlanIndex([
      { lat: 47, lng: 11 },
      { lat: 47, lng: 11 },
    ]);
    expect(still.anchor({ lat: 47, lng: 11 })!.d).toBe(0);
  });
});

describe("median", () => {
  it("ignores an anchor that matched the wrong part of the route", () => {
    // A route that passes near itself produces the occasional wild match; the
    // median only moves once half of them are wrong.
    expect(median([100, 102, 104, 106, 90_000])).toBe(104);
  });

  it("averages the middle pair when there is no single middle", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

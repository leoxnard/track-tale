import { describe, expect, it } from "vitest";
import { layDays, type TourDayInput } from "./tour-layout";
import { buildProfile, haversineM, type TrackPoint } from "./track";

/**
 * A due-east route at a fixed latitude, drawn with `vertices` waypoints and a
 * climb along it so `buildProfile` has something to work with.
 */
function route(vertices: number, fromDeg: number, toDeg: number): TrackPoint[] {
  return Array.from({ length: vertices }, (_, i) => {
    const t = i / (vertices - 1);
    return { lat: 47, lng: fromDeg + t * (toDeg - fromDeg), alt: 500 + 200 * Math.sin(t * Math.PI) };
  });
}

function day(dayNumber: number, points: TrackPoint[], distanceM: number): TourDayInput {
  return { dayNumber, color: "#000", distanceM, profile: buildProfile(points) };
}

/** Push a route off its own line and back, so it rides further than it advances. */
function wobble(points: TrackPoint[], amplitudeDeg: number): TrackPoint[] {
  return points.map((p, i) => ({ ...p, lat: p.lat + amplitudeDeg * Math.sin(i / 2) }));
}

function measure(points: TrackPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1], points[i]);
  return total;
}

/** Metres per degree of longitude at latitude 47. */
const M_PER_DEG_LNG = (Math.PI / 180) * 6371000 * Math.cos((47 * Math.PI) / 180);

describe("layDays", () => {
  // Three days riding one plan, each covering the next third of it exactly.
  const thirds = [
    [11.0, 11.2],
    [11.2, 11.4],
    [11.4, 11.6],
  ] as const;
  const dayLengthM = 0.2 * M_PER_DEG_LNG;
  const planLengthM = 0.6 * M_PER_DEG_LNG;
  const days = thirds.map(([a, b], i) => day(i + 1, route(300, a, b), dayLengthM));

  it("lays days end to end when they rode the plan exactly", () => {
    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, days);

    expect(laid).toHaveLength(3);
    for (const [i, d] of laid.entries()) {
      expect(d.startM).toBeCloseTo(i * dayLengthM, -2);
      expect(d.endM).toBeCloseTo((i + 1) * dayLengthM, -2);
    }
  });

  it("does not invent an overlap when the plan has few waypoints", () => {
    // The reported bug. The same three days, against a plan drawn with four
    // waypoints instead of two thousand — which is what a hand-drawn or
    // heavily-thinned planned GPX looks like. Matching to the nearest waypoint
    // used to quantise each day's position to the waypoint spacing, and a day
    // pulled backwards by that much lands on top of the day before it.
    const coarse = layDays(route(4, 11.0, 11.6), planLengthM, days);
    const dense = layDays(route(2000, 11.0, 11.6), planLengthM, days);

    for (const [i, d] of coarse.laid.entries()) {
      expect(d.startM).toBeCloseTo(dense.laid[i].startM, -2);
    }
    // No day starts before the one before it ended: no overlap at all.
    for (let i = 1; i < coarse.laid.length; i++) {
      expect(coarse.laid[i].startM).toBeGreaterThanOrEqual(coarse.laid[i - 1].endM - 100);
    }
  });

  it("gives a day the plan it covered, not the distance it rode", () => {
    // The reported bug, in its real shape. A day rides further than the route
    // advances — detours, wrong turns, a loop round a lake — so drawing it at
    // its ridden width made it overhang the stretch it covered at both ends,
    // and the front end landed on top of the day before it. Here day two
    // wanders its way along the same third of the plan, 10% further.
    const wandering = wobble(route(400, 11.2, 11.4), 0.002);
    const ridden = measure(wandering);
    expect(ridden).toBeGreaterThan(dayLengthM * 1.08);

    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, [
      days[0],
      day(2, wandering, ridden),
      days[2],
    ]);

    // It occupies exactly its third of the plan, seamlessly between the others.
    expect(laid[1].startM).toBeCloseTo(dayLengthM, -2);
    expect(laid[1].endM).toBeCloseTo(2 * dayLengthM, -2);
    expect(laid[1].startM).toBeGreaterThanOrEqual(laid[0].endM - 100);
    expect(laid[2].startM).toBeGreaterThanOrEqual(laid[1].endM - 100);
  });

  it("ignores a stated distance that disagrees with the profile", () => {
    // A day's authoritative distance comes from the full track and its profile
    // from a thinned, altitude-only subset, so the two always disagree a
    // little. Neither of them decides where the day goes any more.
    const stretched: TourDayInput = { ...days[1], distanceM: dayLengthM * 1.4 };
    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, [days[0], stretched, days[2]]);

    expect(laid[1].startM).toBeCloseTo(dayLengthM, -2);
    expect(laid[1].endM).toBeCloseTo(2 * dayLengthM, -2);
  });

  it("keeps a day it cannot squash to nothing at its ridden width", () => {
    // An out-and-back covers no route at all: it ends where it started, so the
    // fit says zero plan metres per ridden metre. Drawing that would collapse
    // the day to a line, which says less than leaving it its own length.
    const outAndBack = [...route(200, 11.0, 11.1), ...route(200, 11.1, 11.0)];
    const ridden = measure(outAndBack);
    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, [day(1, outAndBack, ridden)]);

    expect(laid[0].endM - laid[0].startM).toBeCloseTo(ridden, -2);
  });

  it("shows a real overlap as an overlap", () => {
    // Anchoring exists to make this visible: a day that re-rode the stretch the
    // day before covered must not be pushed along to sit after it.
    const repeat = [days[0], day(2, route(300, 11.1, 11.3), dayLengthM)];
    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, repeat);

    expect(laid[1].startM).toBeLessThan(laid[0].endM);
    expect(laid[1].startM).toBeCloseTo(0.1 * M_PER_DEG_LNG, -2);
  });

  it("anchors against a plan with no elevation on it", () => {
    // The grey line needs altitudes; matching only needs shape.
    const flat = route(2000, 11.0, 11.6).map(({ lat, lng }) => ({ lat, lng }));
    const { laid } = layDays(flat, planLengthM, days);
    expect(laid[2].startM).toBeCloseTo(2 * dayLengthM, -2);
  });

  it("stacks days that never came near the plan", () => {
    // Far enough away that no anchor is credible; the old end-to-end behaviour
    // is the only honest thing left.
    const elsewhere = thirds.map(([a, b], i) =>
      day(i + 1, route(300, a, b).map((p) => ({ ...p, lat: 40 })), dayLengthM),
    );
    const { laid } = layDays(route(2000, 11.0, 11.6), planLengthM, elsewhere);

    for (const [i, d] of laid.entries()) expect(d.startM).toBeCloseTo(i * dayLengthM, 5);
  });

  it("reports what was ridden apart from what was reached", () => {
    const repeat = [days[0], day(2, route(300, 11.1, 11.3), dayLengthM)];
    const { riddenM, reachedM } = layDays(route(2000, 11.0, 11.6), planLengthM, repeat);

    expect(riddenM).toBeCloseTo(2 * dayLengthM, -2);
    // Two days ridden, but only a day and a half of plan covered.
    expect(reachedM).toBeCloseTo(1.5 * dayLengthM, -2);
  });

  it("carries on without a plan at all", () => {
    const { laid, reachedM } = layDays([], 0, days);
    for (const [i, d] of laid.entries()) expect(d.startM).toBeCloseTo(i * dayLengthM, 5);
    expect(reachedM).toBeCloseTo(3 * dayLengthM, 5);
  });

  it("skips a day with nothing to draw without losing its distance", () => {
    const empty: TourDayInput = { dayNumber: 9, color: "#000", distanceM: 5000, profile: [] };
    const { laid, riddenM } = layDays([], 0, [empty, days[0]]);

    expect(laid).toHaveLength(1);
    expect(laid[0].startM).toBeCloseTo(5000, 5);
    expect(riddenM).toBeCloseTo(5000 + dayLengthM, -2);
  });
});

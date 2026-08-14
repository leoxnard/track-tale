import { describe, expect, it } from "vitest";
import {
  CARRIAGE_PX,
  COUPLING_PX,
  LOCO_PX,
  MAX_CARRIAGES,
  TRAIN_PAD_PX,
  carriagesFor,
  dashRuns,
  fitVehicle,
  trainCentre,
  trainWidth,
  visibleGap,
} from "./train-fit";

/** The width a train of `n` carriages needs, padding included. */
const needs = (n: number) => trainWidth(n) + 2 * TRAIN_PAD_PX;

describe("carriagesFor", () => {
  it("says no train at all when the locomotive alone will not fit", () => {
    expect(carriagesFor(needs(0) - 1)).toBeNull();
    expect(carriagesFor(0)).toBeNull();
    expect(carriagesFor(-40)).toBeNull();
  });

  it("runs a locomotive on its own in the narrowest gap that takes one", () => {
    expect(carriagesFor(needs(0))).toBe(0);
  });

  it("adds a carriage exactly when there is room for a whole one", () => {
    expect(carriagesFor(needs(1) - 1)).toBe(0);
    expect(carriagesFor(needs(1))).toBe(1);
    expect(carriagesFor(needs(5))).toBe(5);
    // Never half a carriage hanging out of the gap.
    expect(carriagesFor(needs(5) + CARRIAGE_PX / 2)).toBe(5);
  });

  it("keeps the train inside the gap it was measured for", () => {
    for (const gap of [40, 63, 120, 400, 961]) {
      const carriages = carriagesFor(gap);
      if (carriages === null) continue;
      expect(needs(carriages)).toBeLessThanOrEqual(gap);
    }
  });

  it("stops lengthening the train long before the DOM notices", () => {
    expect(carriagesFor(100_000)).toBe(MAX_CARRIAGES);
  });

  it("survives a gap it cannot measure", () => {
    expect(carriagesFor(Number.NaN)).toBeNull();
  });
});

describe("trainWidth", () => {
  it("is the locomotive plus a coupling and a carriage for each one pulled", () => {
    expect(trainWidth(0)).toBe(LOCO_PX);
    expect(trainWidth(3)).toBe(LOCO_PX + 3 * (CARRIAGE_PX + COUPLING_PX));
  });
});

describe("dashRuns", () => {
  it("dashes both sides of what stands in the gap", () => {
    expect(dashRuns(0, 100, 40)).toEqual([
      [0, 30],
      [70, 100],
    ]);
  });

  it("dashes the whole gap when nothing stands in it", () => {
    expect(dashRuns(0, 100, 0)).toEqual([[0, 100]]);
  });

  it("drops a run too short to read as a line", () => {
    // A train all but filling its gap leaves slivers at both ends; two dashes
    // wedged against a locomotive are dirt, not information.
    expect(dashRuns(0, 100, 96)).toEqual([]);
    expect(dashRuns(0, 100, 90)).toEqual([
      [0, 5],
      [95, 100],
    ]);
  });

  it("has nothing to draw for a gap with no width", () => {
    expect(dashRuns(50, 50, 0)).toEqual([]);
    expect(dashRuns(50, 50, 20)).toEqual([]);
  });

  it("keeps both runs the same length, wherever the gap sits", () => {
    const [before, after] = dashRuns(220, 480, 60);
    expect(before[1] - before[0]).toBeCloseTo(after[1] - after[0], 10);
    expect(before[0]).toBe(220);
    expect(after[1]).toBe(480);
  });

  it("follows a train that slid off centre to stay on screen", () => {
    // Shunted towards the left-hand end: the long dash is now on the right.
    expect(dashRuns(0, 200, 40, 60)).toEqual([
      [0, 40],
      [80, 200],
    ]);
  });

  it("drops the run on the side a train was shunted right up against", () => {
    expect(dashRuns(0, 200, 40, 20)).toEqual([[40, 200]]);
  });
});

describe("visibleGap", () => {
  it("is the whole gap while the whole gap is on screen", () => {
    expect(visibleGap(100, 300, 0, 960)).toBe(200);
  });

  it("is only the part inside the window once the window cuts it", () => {
    expect(visibleGap(-500, 300, 0, 960)).toBe(300);
    expect(visibleGap(700, 5000, 0, 960)).toBe(260);
    expect(visibleGap(-500, 5000, 0, 960)).toBe(960);
  });

  it("is nothing for a gap the window has left behind", () => {
    expect(visibleGap(-500, -100, 0, 960)).toBe(0);
    expect(visibleGap(2000, 3000, 0, 960)).toBe(0);
  });
});

describe("trainCentre", () => {
  it("stands in the middle of a gap that is wholly on screen", () => {
    expect(trainCentre(100, 300, 0, 960, 60)).toBe(200);
  });

  it("does not budge for a gap merely clipped at one end", () => {
    // Half the gap is off to the left, but its middle is still on screen, so
    // the train stays exactly where an unzoomed chart would have put it.
    expect(trainCentre(-500, 900, 0, 960, 60)).toBe(200);
  });

  it("slides along its gap far enough to come back into view", () => {
    // A crossing whose middle is off to the left: the train follows the gap
    // into the window rather than staying at a midpoint nobody can see.
    const centre = trainCentre(-5000, 400, 0, 960, 60);
    expect(centre).toBe(30);
    // And it never leaves the stretch it stands for.
    expect(centre!).toBeLessThan(400);
  });

  it("slides the other way just the same", () => {
    expect(trainCentre(600, 9000, 0, 960, 60)).toBe(930);
  });

  it("centres on what can be seen when the sliver is narrower than the train", () => {
    expect(trainCentre(940, 9000, 0, 960, 600)).toBe(950);
  });

  it("has nowhere to stand when the gap is off screen entirely", () => {
    expect(trainCentre(-500, -20, 0, 960, 60)).toBeNull();
    expect(trainCentre(1200, 3000, 0, 960, 60)).toBeNull();
    expect(trainCentre(400, 400, 0, 960, 60)).toBeNull();
  });
});

describe("fitVehicle", () => {
  // The tour profile's own numbers: a 960-unit viewBox stretched across a
  // phone-ish 480 px of screen, so one CSS pixel is two viewBox units.
  const W = 960;
  const unitsPerPx = W / 480;

  /** Where a hop's two ends land in viewBox units for a given zoom window. */
  const at = (metres: number, from: number, to: number) => ((metres - from) / (to - from)) * W;

  /** A 200 km train crossing in the middle of a 1000 km tour. */
  const hop = (from: number, to: number) =>
    fitVehicle(at(300_000, from, to), at(500_000, from, to), 0, W, unitsPerPx, true);

  it("draws the train with the whole tour on screen", () => {
    const { carriages, centre } = hop(0, 1_000_000);
    expect(carriages).not.toBeNull();
    expect(centre).toBeCloseTo(W * 0.4, 6); // the middle of the crossing
  });

  it("still draws it zoomed past the point where the crossing's middle is off screen", () => {
    // The reported bug: a window over the first tenth of the crossing. Its
    // midpoint is miles off to the right, and the train used to vanish.
    const { carriages, centre } = hop(300_000, 320_000);
    expect(carriages).not.toBeNull();
    expect(centre).not.toBeNull();
    expect(centre!).toBeGreaterThanOrEqual(0);
    expect(centre!).toBeLessThanOrEqual(W);
  });

  it("still draws it zoomed into the far end of the crossing", () => {
    const { carriages, centre } = hop(480_000, 500_000);
    expect(carriages).not.toBeNull();
    expect(centre!).toBeGreaterThanOrEqual(0);
    expect(centre!).toBeLessThanOrEqual(W);
  });

  it("draws it wherever a window sits inside the crossing", () => {
    for (let start = 300_000; start < 500_000; start += 5_000) {
      const { carriages, centre } = hop(start, Math.min(start + 20_000, 500_000));
      expect(carriages, `window from ${start} m`).not.toBeNull();
      expect(centre, `window from ${start} m`).not.toBeNull();
    }
  });

  it("draws nothing for a crossing the window has left behind", () => {
    // A window over the last stretch of the tour, long past the train.
    expect(hop(900_000, 1_000_000)).toEqual({ carriages: null, centre: null, occupied: 0 });
  });

  it("keeps the train inside the chart it was measured against", () => {
    const { centre, occupied } = hop(300_000, 340_000);
    expect(centre! - occupied / 2).toBeGreaterThanOrEqual(-0.000001);
    expect(centre! + occupied / 2).toBeLessThanOrEqual(W + 0.000001);
  });

  it("sizes the train in screen pixels, not in stretched viewBox units", () => {
    // The same gap on a narrow screen has room for fewer carriages than on a
    // wide one, however identical the two look in viewBox coordinates.
    const narrow = fitVehicle(0, W, 0, W, W / 320, true);
    const wide = fitVehicle(0, W, 0, W, W / 1200, true);
    expect(narrow.carriages!).toBeLessThan(wide.carriages!);
  });

  it("has no train at all until the chart has been measured", () => {
    expect(fitVehicle(0, W, 0, W, 0, true)).toEqual({
      carriages: null,
      centre: null,
      occupied: 0,
    });
  });

  it("gives a ferry one shape or none, never a string of them", () => {
    expect(fitVehicle(0, W, 0, W, unitsPerPx, false).carriages).toBe(0);
    expect(fitVehicle(0, 20, 0, W, unitsPerPx, false).carriages).toBeNull();
  });
});

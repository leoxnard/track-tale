import { describe, expect, it } from "vitest";
import {
  CARRIAGE_PX,
  COUPLING_PX,
  LOCO_PX,
  MAX_CARRIAGES,
  TRAIN_PAD_PX,
  carriagesFor,
  dashRuns,
  trainWidth,
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

  it("puts the train where it is asked to stand", () => {
    // Zoomed in far enough, the visible part of a gap is off to one side of
    // it, and the dash runs either side of the train are lopsided.
    expect(dashRuns(-500, 100, 40, 20)).toEqual([
      [-500, 0],
      [40, 100],
    ]);
  });

  it("keeps both runs the same length, wherever the gap sits", () => {
    const [before, after] = dashRuns(220, 480, 60);
    expect(before[1] - before[0]).toBeCloseTo(after[1] - after[0], 10);
    expect(before[0]).toBe(220);
    expect(after[1]).toBe(480);
  });
});

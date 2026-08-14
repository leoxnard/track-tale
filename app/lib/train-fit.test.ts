import { describe, expect, it } from "vitest";
import {
  CARRIAGE_PX,
  COUPLING_PX,
  LOCO_PX,
  MAX_CARRIAGES,
  TRAIN_PAD_PX,
  carriagesFor,
  dashRuns,
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

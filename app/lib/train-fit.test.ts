import { describe, expect, it } from "vitest";
import {
  CARRIAGE_PX,
  COUPLING_PX,
  DASH_CLEARANCE_PX,
  LOCO_PX,
  MAX_PARTS,
  TRAIN_PAD_PX,
  VEHICLE_PX,
  carriagesFor,
  dashRuns,
  layTrain,
  trainLength,
} from "./train-fit";

const PITCH = CARRIAGE_PX + COUPLING_PX;

describe("carriagesFor", () => {
  it("says no train at all when the locomotive alone will not fit", () => {
    expect(carriagesFor(trainLength(0) - 1)).toBeNull();
    expect(carriagesFor(0)).toBeNull();
    expect(carriagesFor(-40)).toBeNull();
  });

  it("runs a locomotive on its own in the narrowest gap that takes one", () => {
    expect(carriagesFor(trainLength(0))).toBe(0);
  });

  it("adds a carriage exactly when there is room for a whole one", () => {
    expect(carriagesFor(trainLength(1) - 1)).toBe(0);
    expect(carriagesFor(trainLength(1))).toBe(1);
    expect(carriagesFor(trainLength(5))).toBe(5);
    // Never half a carriage hanging out of the gap.
    expect(carriagesFor(trainLength(5) + CARRIAGE_PX / 2)).toBe(5);
  });

  it("keeps the train inside the gap it was measured for", () => {
    for (const gap of [40, 63, 120, 400, 961, 12_000]) {
      const carriages = carriagesFor(gap);
      if (carriages === null) continue;
      expect(trainLength(carriages)).toBeLessThanOrEqual(gap);
    }
  });

  it("survives a gap it cannot measure", () => {
    expect(carriagesFor(Number.NaN)).toBeNull();
  });
});

describe("trainLength", () => {
  it("is the nose padding, the locomotive, and a coupled carriage for each one pulled", () => {
    expect(trainLength(0)).toBe(TRAIN_PAD_PX + LOCO_PX);
    expect(trainLength(3)).toBe(TRAIN_PAD_PX + LOCO_PX + 3 * PITCH);
  });
});

describe("layTrain", () => {
  // The tour profile's own numbers: a 960-unit viewBox stretched across a
  // phone-ish 480 px of screen, so one CSS pixel is two viewBox units.
  const W = 960;
  const unitsPerPx = W / 480;
  const chartPx = 480;

  /** A gap given in screen pixels from the left edge of the chart. */
  const lay = (fromPx: number, toPx: number, pulls = true) =>
    layTrain(fromPx * unitsPerPx, toPx * unitsPerPx, W, unitsPerPx, pulls);

  it("pins the locomotive's nose where the riding starts again", () => {
    const { parts } = lay(0, 400);
    const engine = parts.find((p) => p.kind === "engine")!;
    expect(engine.x + LOCO_PX + TRAIN_PAD_PX).toBeCloseTo(400, 6);
  });

  it("tails the carriages back from the engine, evenly spaced", () => {
    const { parts } = lay(0, 400);
    const engine = parts.find((p) => p.kind === "engine")!;
    const carriages = parts.filter((p) => p.kind === "carriage");
    expect(carriages.length).toBeGreaterThan(2);
    // The first carriage couples on behind the locomotive.
    expect(carriages[0].x + CARRIAGE_PX + COUPLING_PX).toBeCloseTo(engine.x, 6);
    for (let i = 1; i < carriages.length; i++) {
      expect(carriages[i - 1].x - carriages[i].x).toBeCloseTo(PITCH, 6);
    }
  });

  it("never lets a carriage stick out of the gap it stands in", () => {
    for (let width = 36; width < 400; width += 1) {
      const { parts } = lay(0, width);
      for (const part of parts) expect(part.x, `gap ${width} px`).toBeGreaterThanOrEqual(0);
    }
  });

  it("leaves the engine exactly where it was when the gap grows behind it", () => {
    // Zooming lengthens the gap. The nose must not shift by so much as a pixel
    // — that shifting is what read as juddering.
    const engineAt = (fromPx: number) => lay(fromPx, 400).parts.find((p) => p.kind === "engine")!.x;
    const fixed = engineAt(300);
    for (const from of [280, 200, 100, 0, -500, -20_000]) {
      expect(engineAt(from), `gap starting at ${from} px`).toBeCloseTo(fixed, 6);
    }
  });

  it("only ever adds carriages at the back as the gap grows", () => {
    // Every vehicle drawn at one width is still drawn, at the same place, at
    // every greater width: the train grows away from its anchor, never around.
    let previous = lay(340, 400).parts;
    for (let from = 330; from >= -400; from -= 10) {
      const parts = lay(from, 400).parts;
      const byIndex = new Map(parts.map((p) => [p.index, p.x]));
      for (const was of previous) {
        expect(byIndex.get(was.index), `carriage ${was.index} at ${from} px`).toBeCloseTo(was.x, 6);
      }
      expect(parts.length).toBeGreaterThanOrEqual(previous.length);
      previous = parts;
    }
  });

  it("keeps drawing the train zoomed past the point where the gap's middle is off screen", () => {
    // The bug this all started with: a window over one end of a long crossing.
    // Every window along it must still show rolling stock.
    for (let from = -20_000; from <= 400; from += 137) {
      const { parts } = lay(from, 400);
      expect(parts.length, `gap starting at ${from} px`).toBeGreaterThan(0);
    }
  });

  it("shows the middle of a crossing whose both ends are off screen", () => {
    // Nose far off to the right, tail far off to the left: what is on screen is
    // carriages and nothing else, cut by both edges.
    const { parts } = lay(-20_000, 20_000);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.kind === "carriage")).toBe(true);
    expect(parts.some((p) => p.x < chartPx && p.x + CARRIAGE_PX > 0)).toBe(true);
  });

  it("builds only the vehicles the window can see", () => {
    const { parts } = lay(-100_000, 100_000);
    expect(parts.length).toBeLessThanOrEqual(MAX_PARTS);
    // Nothing wholly off either edge got built.
    for (const part of parts) {
      expect(part.x).toBeLessThan(chartPx);
      expect(part.x + CARRIAGE_PX).toBeGreaterThan(0);
    }
  });

  it("draws nothing for a crossing the window has left behind", () => {
    expect(lay(-9000, -500).parts).toEqual([]);
    expect(lay(2000, 9000).parts).toEqual([]);
  });

  it("draws nothing until the chart has been measured", () => {
    expect(layTrain(0, W, W, 0, true)).toEqual({ parts: [], stands: null });
  });

  it("sizes the train in screen pixels, not in stretched viewBox units", () => {
    // The same gap on a narrow screen holds fewer carriages than on a wide one,
    // however identical the two look in viewBox coordinates.
    const narrow = layTrain(0, W, W, W / 320, true).parts.length;
    const wide = layTrain(0, W, W, W / 1200, true).parts.length;
    expect(narrow).toBeLessThan(wide);
  });

  it("gives a ferry one shape or none, never a string of them", () => {
    const { parts } = lay(0, 400, false);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe("engine");
    expect(parts[0].x + VEHICLE_PX + TRAIN_PAD_PX).toBeCloseTo(400, 6);
    expect(lay(0, VEHICLE_PX, false).parts).toEqual([]);
  });

  it("reports what the whole train stands on, off-screen carriages included", () => {
    const { stands } = lay(0, 400);
    const carriages = carriagesFor(400)!;
    expect(stands![1]).toBeCloseTo(400 * unitsPerPx, 6);
    expect(stands![0]).toBeCloseTo(
      (400 - trainLength(carriages) - DASH_CLEARANCE_PX) * unitsPerPx,
      6,
    );
  });
});

describe("dashRuns", () => {
  it("trails a dash off the back of the train and none off its nose", () => {
    expect(dashRuns(0, 100, [70, 100])).toEqual([[0, 70]]);
  });

  it("dashes the whole gap when nothing stands in it", () => {
    expect(dashRuns(0, 100, null)).toEqual([[0, 100]]);
  });

  it("drops a run too short to read as a line", () => {
    // A train all but filling its gap leaves a sliver behind it; two dashes
    // wedged against a locomotive are dirt, not information.
    expect(dashRuns(0, 100, [2, 100])).toEqual([]);
    expect(dashRuns(0, 100, [5, 100])).toEqual([[0, 5]]);
  });

  it("has nothing to draw for a gap with no width", () => {
    expect(dashRuns(50, 50, null)).toEqual([]);
    expect(dashRuns(50, 50, [50, 50])).toEqual([]);
  });

  it("dashes both sides of something standing clear of either end", () => {
    expect(dashRuns(0, 200, [80, 120])).toEqual([
      [0, 80],
      [120, 200],
    ]);
  });
});

describe("layTrain, skipping to the window", () => {
  const W = 960;

  it("draws the same train whether or not the nose is off screen", () => {
    // The jump-ahead is an optimisation and must not change the picture: a
    // window deep inside a crossing has to hold the same carriages, at the same
    // pixels, as the identical window of a crossing whose nose is just in view.
    const unitsPerPx = W / 480;
    const near = layTrain(-400 * unitsPerPx, 400 * unitsPerPx, W, unitsPerPx, true);
    const far = layTrain(-40_000 * unitsPerPx, 400 * unitsPerPx, W, unitsPerPx, true);
    expect(far.parts.map((p) => p.x)).toEqual(near.parts.map((p) => p.x));
    expect(far.parts.map((p) => p.kind)).toEqual(near.parts.map((p) => p.kind));
  });

  it("costs the same however far off screen the nose is", () => {
    // Guards the jump-ahead itself: without it this is thousands of couplings.
    const unitsPerPx = W / 480;
    for (const nosePx of [1_000, 100_000, 10_000_000]) {
      const { parts } = layTrain(-1e9, nosePx * unitsPerPx, W, unitsPerPx, true);
      expect(parts.length, `nose at ${nosePx} px`).toBeGreaterThan(0);
      expect(parts.length).toBeLessThanOrEqual(MAX_PARTS);
    }
  });
});

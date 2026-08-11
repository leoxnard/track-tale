import { describe, expect, it } from "vitest";
import {
  CARRIAGE_PX,
  COUPLING_PX,
  LOCO_PX,
  MAP_CARRIAGES,
  MAX_CARRIAGES,
  TRAIN_PAD_PX,
  carriagesFor,
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

describe("MAP_CARRIAGES", () => {
  it("keeps the map's train short enough to read on a leg seen from far out", () => {
    // The map repeats one image rather than fitting a gap, so this is a choice
    // and not a measurement — but a train longer than a few carriages would
    // swamp a short leg at low zoom.
    expect(MAP_CARRIAGES).toBeGreaterThan(0);
    expect(MAP_CARRIAGES).toBeLessThanOrEqual(3);
  });
});

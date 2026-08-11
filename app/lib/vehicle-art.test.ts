import { describe, expect, it } from "vitest";
import { CARRIAGE_PX, LOCO_PX, VEHICLE_PX } from "./train-fit";
import {
  CARRIAGE,
  CARRIAGE_ART,
  RAIL_Y,
  VEHICLE_H,
  vehicleArt,
  type Shape,
} from "./vehicle-art";

/** The topmost pixel any of these shapes reaches. */
function roofOf(shapes: Shape[]): number {
  return Math.min(...shapes.filter((s) => s.kind === "rect").map((s) => s.y));
}

describe("vehicleArt", () => {
  it("gives each mode the width it is drawn to", () => {
    expect(vehicleArt("train").width).toBe(LOCO_PX);
    expect(vehicleArt("ferry").width).toBe(VEHICLE_PX);
    expect(vehicleArt("bus").width).toBe(VEHICLE_PX);
    expect(CARRIAGE_ART.width).toBe(CARRIAGE_PX);
  });

  it.each([
    ["locomotive", vehicleArt("train")],
    ["ferry", vehicleArt("ferry")],
    ["bus", vehicleArt("bus")],
    ["carriage", CARRIAGE_ART],
  ])("keeps every part of the %s inside its own box", (_name, art) => {
    // Both renderers take these coordinates as they are — a shape reaching
    // outside is clipped on the map and overlaps its neighbour in the chart.
    for (const shape of art.shapes) {
      if (shape.kind === "rect") {
        expect(shape.x).toBeGreaterThanOrEqual(0);
        expect(shape.x + shape.w).toBeLessThanOrEqual(art.width);
        expect(shape.y).toBeGreaterThanOrEqual(0);
        expect(shape.y + shape.h).toBeLessThanOrEqual(VEHICLE_H);
      }
      if (shape.kind === "wheel") {
        expect(shape.x - shape.r).toBeGreaterThanOrEqual(0);
        expect(shape.x + shape.r).toBeLessThanOrEqual(art.width);
        // Wheels are placed by where they touch the rail, so the only way one
        // leaves the box is by being too big to stand on it.
        expect(RAIL_Y - 2 * shape.r).toBeGreaterThanOrEqual(0);
        expect(RAIL_Y).toBeLessThanOrEqual(VEHICLE_H);
      }
    }
  });

  it("stands the engine well above the carriages it pulls", () => {
    // The reported problem: carriages drawn as tall as the engine read as
    // crates being pushed along. The cab has to be the tallest thing in the
    // train, and by enough to see.
    expect(roofOf(CARRIAGE)).toBeGreaterThan(roofOf(vehicleArt("train").shapes) + 3);
  });

  it("runs everything on one rail", () => {
    const wheels = [...vehicleArt("train").shapes, ...CARRIAGE, ...vehicleArt("bus").shapes].filter(
      (s) => s.kind === "wheel",
    );
    // Sizes differ — a driving wheel, a bogie, a bus tyre — and that is the
    // reason wheels are positioned by their contact point rather than centred.
    expect(new Set(wheels.map((w) => w.kind === "wheel" && w.r)).size).toBeGreaterThan(2);
  });

  it("gives a ferry no wheels at all", () => {
    expect(vehicleArt("ferry").shapes.some((s) => s.kind === "wheel")).toBe(false);
  });
});

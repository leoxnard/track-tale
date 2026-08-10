import { describe, expect, it } from "vitest";
import { classifyTransit, isTransit, transitMode } from "./transport";
import { parseGpx } from "./gpx";

describe("classifyTransit", () => {
  it("reads the mode off a GPX type", () => {
    expect(classifyTransit("train")).toBe("train");
    expect(classifyTransit("ferry")).toBe("ferry");
    expect(classifyTransit("bus")).toBe("bus");
  });

  it("reads it off a track name, in either language", () => {
    expect(classifyTransit(null, "Zugfahrt Aberdeen – Forres")).toBe("train");
    expect(classifyTransit(null, "Train Aberdeen to Forres")).toBe("train");
    expect(classifyTransit(null, "Fähre nach Mull")).toBe("ferry");
    expect(classifyTransit(null, "S-Bahn zum Start")).toBe("train");
  });

  it("takes the first text that says something", () => {
    // The `<type>` is the deliberate statement; the name is the fallback.
    expect(classifyTransit("train", "Fähre nach Mull")).toBe("train");
    expect(classifyTransit(undefined, "Fähre nach Mull")).toBe("ferry");
  });

  it("leaves a ride that merely mentions a station alone", () => {
    expect(classifyTransit(null, "Bahnhofstrasse hoch und wieder runter")).toBeNull();
    expect(classifyTransit("cycling", "Morning ride")).toBeNull();
    expect(classifyTransit(null, null)).toBeNull();
  });
});

describe("transitMode", () => {
  it("recognises only the modes it stores", () => {
    expect(transitMode("train")).toBe("train");
    expect(transitMode("touringbicycle")).toBeNull();
    expect(transitMode(null)).toBeNull();
    expect(isTransit("ferry")).toBe(true);
    expect(isTransit("hike")).toBe(false);
  });
});

const gpx = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    ${inner}
    <trkseg>
      <trkpt lat="57.1436" lon="-2.0966"><ele>10</ele></trkpt>
      <trkpt lat="57.2062" lon="-2.1946"><ele>60</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe("parseGpx", () => {
  it("marks a train leg as one, from the type", () => {
    const track = parseGpx(gpx("<name>Aberdeen – Forres</name><type>train</type>"));
    expect(track.sport).toBe("train");
    expect(track.name).toBe("Aberdeen – Forres");
    expect(track.points).toHaveLength(2);
  });

  it("falls back to the name when there is no type", () => {
    expect(parseGpx(gpx("<name>Zug nach Forres</name>")).sport).toBe("train");
  });

  it("leaves a ridden GPX without a sport", () => {
    expect(parseGpx(gpx("<name>Cairngorms day</name>")).sport).toBeUndefined();
  });
});

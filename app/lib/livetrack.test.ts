import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLiveTrackHtml } from "./livetrack";

// A real session page, trimmed to four points with the location, name and
// tokens scrubbed. Kept verbatim otherwise: the escaping of the embedded
// payload is exactly the thing that would break, so a synthetic fixture would
// not catch it.
const html = readFileSync(join(__dirname, "../fixtures/livetrack-session.html"), "utf8");

describe("parseLiveTrackHtml", () => {
  it("reads the session out of a real page", () => {
    const session = parseLiveTrackHtml(html);
    expect(session).not.toBeNull();
    expect(session!.name).toBe("Fixture Ride");
    expect(session!.activityType).toBe("CYCLING");
    expect(session!.points).toHaveLength(4);
  });

  it("maps Garmin's point shape onto a TrackPoint", () => {
    const p = parseLiveTrackHtml(html)!.points[0];
    expect(p.lat).toBeCloseTo(47.5, 6);
    // Garmin says `lon`, the rest of the app says `lng`.
    expect(p.lng).toBeCloseTo(11.0, 6);
    expect(typeof p.alt).toBe("number");
    expect(typeof p.time).toBe("number");
  });

  it("reports the newest point as the current position", () => {
    const session = parseLiveTrackHtml(html)!;
    expect(session.current).toEqual(session.points[session.points.length - 1]);
    expect(session.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries distance and duration through", () => {
    const session = parseLiveTrackHtml(html)!;
    expect(session.distanceM).toBeGreaterThan(0);
    expect(session.durationS).toBeGreaterThan(0);
  });

  it("treats STATIONARY points as not moving", () => {
    // The fixture was captured before the ride got going.
    expect(parseLiveTrackHtml(html)!.points.every((p) => p.moving === false)).toBe(true);
  });

  it("returns null rather than throwing on pages it cannot read", () => {
    expect(parseLiveTrackHtml("")).toBeNull();
    expect(parseLiveTrackHtml("<html><body>Session not found</body></html>")).toBeNull();
    // Shape present but payload truncated mid-array.
    expect(
      parseLiveTrackHtml(`<script>self.__next_f.push([1,"{\\"trackPoints\\":[{\\"position\\""])</script>`),
    ).toBeNull();
    // Valid envelope, no usable coordinates.
    expect(
      parseLiveTrackHtml(`<script>self.__next_f.push([1,"{\\"trackPoints\\":[{\\"altitude\\":5}]}"])</script>`),
    ).toBeNull();
  });

  it("is not fooled by a bracket inside a string value", () => {
    const payload = JSON.stringify(
      '{"sessionName":"Ride [with] brackets","trackPoints":[{"position":{"lat":1,"lon":2},"totalDistanceMeters":3}]}',
    );
    const session = parseLiveTrackHtml(`<script>self.__next_f.push([1,${payload}])</script>`);
    expect(session!.points).toHaveLength(1);
    expect(session!.name).toBe("Ride [with] brackets");
  });
});

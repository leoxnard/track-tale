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

  describe("session completion", () => {
    // Garmin's `end` tracks the present while a ride is live and freezes when
    // it finishes, so its staleness is what tells us the session is over. The
    // fixture's own end is the reference point.
    const endMs = Date.parse(parseLiveTrackHtml(html)!.endedAt!);

    it("reads a session whose end is still current as live", () => {
      expect(parseLiveTrackHtml(html, endMs + 30_000)!.complete).toBe(false);
    });

    it("reads a session whose end has gone stale as complete", () => {
      // Garmin's own banner had flipped by 105s; agreeing with it is the point.
      expect(parseLiveTrackHtml(html, endMs + 150_000)!.complete).toBe(true);
    });

    it("tolerates a gap of a few reporting intervals", () => {
      // A live session reports about every ten seconds, so one missed handful
      // of points must not read as finished.
      expect(parseLiveTrackHtml(html, endMs + 60_000)!.complete).toBe(false);
    });

    it("gives up on a session that never produced a point", () => {
      // Garmin opens sessions that die seconds later; one of them lasted 15s.
      const stub = (nowMs: number) =>
        parseLiveTrackHtml(
          `<script>self.__next_f.push([1,"{\\"start\\":\\"2026-07-25T18:24:16.000Z\\",\\"end\\":\\"2026-07-25T18:24:31.000Z\\",\\"trackPoints\\":[]}"])</script>`,
          nowMs,
        );
      const end = Date.parse("2026-07-25T18:24:31.000Z");
      // Just opened: still worth showing, the first point may be seconds away.
      expect(stub(end + 30_000)!.complete).toBe(false);
      // Gone quiet without ever reporting a position: finished, not starting.
      expect(stub(end + 3 * 60_000)!.complete).toBe(true);
    });

    it("never claims complete when there is no end to judge by", () => {
      const noEnd = parseLiveTrackHtml(
        `<script>self.__next_f.push([1,"{\\"trackPoints\\":[{\\"position\\":{\\"lat\\":1,\\"lon\\":2}}]}"])</script>`,
      );
      expect(noEnd!.endedAt).toBeNull();
      expect(noEnd!.complete).toBe(false);
    });
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
  });

  it("reads a session that has not produced points yet as empty, not broken", () => {
    // Garmin opens the session when LiveTrack starts; points arrive later. The
    // caller has to be able to tell this apart from a page it could not read.
    const empty = parseLiveTrackHtml(
      `<script>self.__next_f.push([1,"{\\"sessionName\\":\\"Not started\\",\\"trackPoints\\":[]}"])</script>`,
    );
    expect(empty).not.toBeNull();
    expect(empty!.points).toEqual([]);
    expect(empty!.current).toBeNull();
    expect(empty!.distanceM).toBe(0);

    // Points present but none carrying coordinates is likewise empty, not null.
    const noCoords = parseLiveTrackHtml(
      `<script>self.__next_f.push([1,"{\\"trackPoints\\":[{\\"altitude\\":5}]}"])</script>`,
    );
    expect(noCoords!.points).toEqual([]);
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isSettled, keepsStoredSession, parseLiveTrackHtml, type LiveSession } from "./livetrack";

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

    it("waits much longer to call a session settled than to hide the banner", () => {
      // Hiding the banner is reversible on the next page load; dropping the
      // stored link is not, so a long tunnel must not trigger it.
      const session = parseLiveTrackHtml(html, endMs + 5 * 60_000)!;
      expect(session.complete).toBe(true);
      expect(isSettled(session, endMs + 5 * 60_000)).toBe(false);
      expect(isSettled(session, endMs + 25 * 60_000)).toBe(false);
      expect(isSettled(session, endMs + 31 * 60_000)).toBe(true);
    });

    it("never settles a session with no end to judge by", () => {
      const noEnd = parseLiveTrackHtml(
        `<script>self.__next_f.push([1,"{\\"trackPoints\\":[{\\"position\\":{\\"lat\\":1,\\"lon\\":2}}]}"])</script>`,
      )!;
      expect(isSettled(noEnd, Date.now())).toBe(false);
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

  describe("paginated track points", () => {
    // Garmin loads the track as a react-query *infinite* query, so the payload
    // is {"pages":[{"trackPoints":[…]},…]} — one array per page. Reading only
    // the first showed a long ride as its opening few minutes and no more.
    const page = (points: string) => `{\\"trackPoints\\":[${points}]}`;
    const pt = (iso: string, lat: number, dist: number) =>
      `{\\"dateTime\\":\\"${iso}\\",\\"position\\":{\\"lat\\":${lat},\\"lon\\":11},` +
      `\\"totalDistanceMeters\\":${dist},\\"totalDurationSecs\\":${dist}}`;
    const html = (pages: string[]) =>
      `<script>self.__next_f.push([1,"{\\"pages\\":[${pages.join(",")}],\\"pageParams\\":[\\"\\"]}"])</script>`;

    it("reads every page, not just the first", () => {
      const session = parseLiveTrackHtml(
        html([
          page([pt("2026-07-25T10:00:00.000Z", 47.0, 0), pt("2026-07-25T10:00:10.000Z", 47.1, 100)].join(",")),
          page([pt("2026-07-25T10:00:20.000Z", 47.2, 200), pt("2026-07-25T10:00:30.000Z", 47.3, 300)].join(",")),
        ]),
      )!;
      expect(session.points).toHaveLength(4);
      expect(session.distanceM).toBe(300);
      expect(session.durationS).toBe(300);
      expect(session.current!.lat).toBeCloseTo(47.3, 6);
    });

    it("puts pages back in time order and drops the overlap between them", () => {
      // Nothing promises the pages arrive oldest-first, and a page boundary
      // that repeats a point would draw the route doubling back on itself.
      const session = parseLiveTrackHtml(
        html([
          page([pt("2026-07-25T10:00:20.000Z", 47.2, 200), pt("2026-07-25T10:00:30.000Z", 47.3, 300)].join(",")),
          page([pt("2026-07-25T10:00:00.000Z", 47.0, 0), pt("2026-07-25T10:00:20.000Z", 47.2, 200)].join(",")),
        ]),
      )!;
      expect(session.points.map((p) => p.lat)).toEqual([47.0, 47.2, 47.3]);
      expect(session.updatedAt).toBe("2026-07-25T10:00:30.000Z");
    });

    it("keeps the pages it could read when a later one is truncated", () => {
      const session = parseLiveTrackHtml(
        html([page(pt("2026-07-25T10:00:00.000Z", 47.0, 0)), '{\\"trackPoints\\":[{\\"position\\":]}'],
        ),
      );
      expect(session!.points).toHaveLength(1);
    });
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

describe("keepsStoredSession", () => {
  const session = (o: Partial<LiveSession>): LiveSession => ({
    name: null, activityType: null, startedAt: null, endedAt: null, complete: false,
    points: [], distanceM: 0, durationS: 0, current: null, updatedAt: null, ...o,
  });
  const pt = { lat: 1, lng: 2, distanceM: 0, moving: true };
  const recording = session({ points: [pt] });
  const finished = session({ points: [pt], complete: true });
  const empty = session({ points: [] });

  it("protects a ride that is genuinely in progress from an empty stub", () => {
    expect(keepsStoredSession(recording, empty)).toBe(true);
  });

  it("lets a session that has points of its own take over", () => {
    expect(keepsStoredSession(recording, recording)).toBe(false);
  });

  it("does not let a finished ride block the next one", () => {
    // The bug this exists for: a finished session keeps its points for good, so
    // testing points alone blocked every new session for 24 hours.
    expect(keepsStoredSession(finished, empty)).toBe(false);
  });

  it("gives up its claim when there is nothing stored or nothing recorded", () => {
    expect(keepsStoredSession(null, empty)).toBe(false);
    expect(keepsStoredSession(empty, empty)).toBe(false);
  });

  it("lets the new link through when it cannot be read", () => {
    // Unreadable is not the same as a dud; refusing would strand the trip.
    expect(keepsStoredSession(recording, null)).toBe(false);
  });
});

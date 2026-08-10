import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The family page's loader and action.
 *
 * Everything else under app/lib is pure and tested as such; this is the seam
 * where those pieces meet the database query that feeds them. It is also the
 * query that breaks first whenever a column moves, and until now nothing
 * watched it — so what is pinned here is the shape it hands to the page, not
 * the rendering that follows.
 */

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";
process.env.TELEGRAM_WEBHOOK_SECRET = "hook";
process.env.CRON_SECRET = "cron";
process.env.TELEGRAM_OWNER_ID = "1";

type Row = Record<string, unknown>;

let tripRow: Row | null;
let dayRows: Row[];
let planRows: Row[];
/** Times Garmin was asked for the live session — the cost the switch removes. */
let liveFetches = 0;
let tripPatches: Row[] = [];
let commentPosted: Row | undefined;
let commentResult: { ok: true } | { ok: false; error: string } = { ok: true };

vi.mock("../lib/db.server", () => ({
  getTripBySlug: async (slug: string) => (tripRow && tripRow.share_slug === slug ? tripRow : null),
  updateTrip: async (_id: string, patch: Row) => {
    tripPatches.push(patch);
  },
}));

vi.mock("../lib/supabase.server", () => ({
  supabase: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: table === "days" ? dayRows : planRows }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  }),
}));

vi.mock("../lib/livetrack.server", () => ({
  fetchLiveSession: async () => {
    liveFetches++;
    return {
      points: [{ lat: 47, lng: 11, moving: true }],
      current: { lat: 47, lng: 11, moving: true },
      distanceM: 1000,
      durationS: 600,
      updatedAt: "2026-08-01T10:00:00Z",
      complete: false,
      name: "Ride",
    };
  },
}));

vi.mock("../lib/comments.server", () => ({
  postComment: async (input: Row) => {
    commentPosted = input;
    return commentResult;
  },
}));

const { loader, action } = await import("./t.$slug");

/** The loader's real signature carries router types this test does not need. */
const load = (slug: string) =>
  (loader as unknown as (a: { params: { slug: string }; request: Request }) => Promise<Record<string, unknown>>)({
    params: { slug },
    request: new Request("https://track.test/t/abc"),
  });

const submit = (form: Record<string, string>) => {
  const body = new URLSearchParams(form);
  return (action as unknown as (a: { params: { slug: string }; request: Request }) => Promise<Record<string, unknown>>)({
    params: { slug: "abc" },
    request: new Request("https://track.test/t/abc", { method: "POST", body }),
  });
};

const line = (coords: [number, number][]) => ({
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: coords },
});

beforeEach(() => {
  process.env.LIVE_TRACKING = "0";
  tripRow = {
    id: "trip-1",
    name: "Alpen",
    share_slug: "abc",
    start_date: "2026-08-01",
    end_date: "2026-08-10",
    finished_at: null,
    live_url: null,
    live_expires_at: null,
    og_path: null,
    og_updated_at: null,
  };
  dayRows = [];
  planRows = [];
  liveFetches = 0;
  tripPatches = [];
  commentPosted = undefined;
  commentResult = { ok: true };
});

const dayWithTrack = (over: Row = {}): Row => ({
  id: "day-1",
  day_number: 1,
  date: "2026-08-01",
  color: "#f00",
  track_segments: [
    {
      geojson: line([
        [11, 47],
        [11.01, 47.01],
      ]),
      distance_m: 1200,
      moving_s: 300,
      elevation_up: 50,
      sport: "cycling",
      started_at: "2026-08-01T08:00:00Z",
    },
  ],
  media: [],
  notes: [],
  comments: [],
  weather_cache: null,
  ...over,
});

describe("trip page loader", () => {
  it("404s on a slug that belongs to no trip", async () => {
    await expect(load("nope")).rejects.toMatchObject({ init: { status: 404 } });
  });

  it("adds up the trip from its days", async () => {
    dayRows = [dayWithTrack(), dayWithTrack({ id: "day-2", day_number: 2 })];
    const out = await load("abc");
    expect(out.days).toHaveLength(2);
    expect(out.totalKm).toBeCloseTo(2.4, 5);
    expect(out.totalUp).toBe(100);
    expect(out.movingS).toBe(600);
  });

  it("leaves out a day with nothing on it", async () => {
    // A trip creates a row per day up front; an empty one is a day not yet
    // lived, not a day worth a heading on the page.
    dayRows = [dayWithTrack(), dayWithTrack({ id: "day-2", day_number: 2, track_segments: [] })];
    const out = await load("abc");
    expect(out.days).toHaveLength(1);
  });

  it("keeps a day that has only a photo on it", async () => {
    dayRows = [
      dayWithTrack({
        track_segments: [],
        media: [
          {
            storage_path: "p/1.jpg",
            thumb_path: "p/1-thumb.jpg",
            caption: "Pass",
            matched_lat: 47,
            matched_lng: 11,
            telegram_date: "2026-08-01T12:00:00Z",
            taken_at: "2026-08-01T11:00:00Z",
            created_at: "2026-08-01T12:00:00Z",
            author_name: "Leo",
          },
        ],
      }),
    ];
    const out = await load("abc");
    const days = out.days as { photos: { url: string; thumbUrl: string }[] }[];
    expect(days[0].photos[0].url).toBe("https://cdn.test/p/1.jpg");
    expect(days[0].photos[0].thumbUrl).toBe("https://cdn.test/p/1-thumb.jpg");
  });

  it("names authors only once more than one person has contributed", async () => {
    const photo = (author: string) => ({
      storage_path: `p/${author}.jpg`,
      thumb_path: null,
      caption: null,
      matched_lat: null,
      matched_lng: null,
      telegram_date: "2026-08-01T12:00:00Z",
      taken_at: null,
      created_at: "2026-08-01T12:00:00Z",
      author_name: author,
    });
    dayRows = [dayWithTrack({ media: [photo("Leo")] })];
    expect((await load("abc")).showAuthors).toBe(false);

    dayRows = [dayWithTrack({ media: [photo("Leo"), photo("Mara")] })];
    expect((await load("abc")).showAuthors).toBe(true);
  });

  it("orders a day's photos by when the shutter fired", async () => {
    const shot = (name: string, takenAt: string) => ({
      storage_path: name,
      thumb_path: null,
      caption: null,
      matched_lat: null,
      matched_lng: null,
      telegram_date: "2026-08-01T20:00:00Z",
      taken_at: takenAt,
      created_at: "2026-08-01T20:00:00Z",
      author_name: null,
    });
    dayRows = [
      dayWithTrack({
        media: [shot("late", "2026-08-01T17:00:00Z"), shot("early", "2026-08-01T09:00:00Z")],
      }),
    ];
    const days = (await load("abc")).days as { photos: { url: string }[] }[];
    expect(days[0].photos.map((p) => p.url)).toEqual(["https://cdn.test/early", "https://cdn.test/late"]);
  });
});

describe("trip page loader, live tracking", () => {
  const liveTrip = () => ({
    live_url: "https://livetrack.garmin.com/session/x",
    live_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });

  it("never asks Garmin while the switch is off", async () => {
    tripRow = { ...tripRow!, ...liveTrip() };
    dayRows = [dayWithTrack()];
    const out = await load("abc");
    expect(liveFetches).toBe(0);
    expect(out.live).toBeNull();
    expect(out.liveUrl).toBeNull();
  });

  it("draws the live ride once the switch is on", async () => {
    process.env.LIVE_TRACKING = "1";
    tripRow = { ...tripRow!, ...liveTrip() };
    dayRows = [dayWithTrack()];
    const out = await load("abc");
    expect(liveFetches).toBe(1);
    expect(out.liveUrl).toBe("https://livetrack.garmin.com/session/x");
    expect(out.live).toMatchObject({ distanceM: 1000, moving: true });
  });

  it("ignores an expired link even with the switch on", async () => {
    process.env.LIVE_TRACKING = "1";
    tripRow = {
      ...tripRow!,
      live_url: "https://livetrack.garmin.com/session/x",
      live_expires_at: new Date(Date.now() - 1000).toISOString(),
    };
    dayRows = [dayWithTrack()];
    expect((await load("abc")).live).toBeNull();
    expect(liveFetches).toBe(0);
  });
});

describe("trip page action", () => {
  it("hands a guestbook message over with the day it belongs to", async () => {
    const out = await submit({ dayNumber: "3", authorName: "Oma", text: "Schöne Tour!" });
    expect(commentPosted).toMatchObject({ slug: "abc", dayNumber: 3, authorName: "Oma" });
    expect(out).toMatchObject({ ok: true, dayNumber: 3 });
  });

  it("reports back which day a rejected message was meant for", async () => {
    // The page shows the error under the right day's form, so the number has
    // to survive the round trip even when the post failed.
    commentResult = { ok: false, error: "too many" };
    expect(await submit({ dayNumber: "2", authorName: "", text: "hi" })).toEqual({
      ok: false,
      error: "too many",
      dayNumber: 2,
    });
  });

  it("survives a form with fields missing", async () => {
    await submit({});
    expect(commentPosted).toMatchObject({ authorName: "", text: "" });
  });
});

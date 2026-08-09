import { describe, expect, it } from "vitest";
import { byPhotoTime, photoTimeMs, type OrderablePhoto } from "./photo-order";

const photo = (p: Partial<OrderablePhoto> & { telegram_date: string }): OrderablePhoto => p;

describe("photoTimeMs", () => {
  it("prefers the capture time over the send time", () => {
    expect(
      photoTimeMs({ taken_at: "2026-08-09T11:38:01Z", telegram_date: "2026-08-09T21:20:10Z" }),
    ).toBe(Date.parse("2026-08-09T11:38:01Z"));
  });

  it("falls back to the send time when nothing was captured", () => {
    expect(photoTimeMs({ taken_at: null, telegram_date: "2026-08-09T21:20:10Z" })).toBe(
      Date.parse("2026-08-09T21:20:10Z"),
    );
  });

  it("ignores an unparseable capture time rather than sorting to 1970", () => {
    expect(photoTimeMs({ taken_at: "not a date", telegram_date: "2026-08-09T21:20:10Z" })).toBe(
      Date.parse("2026-08-09T21:20:10Z"),
    );
  });
});

describe("byPhotoTime", () => {
  it("puts an evening batch back into the order it was shot in", () => {
    // The real shape of a hotel upload: one send timestamp, five capture times.
    const sent = "2026-08-09T21:20:10Z";
    const batch = [
      photo({ taken_at: "2026-08-09T20:08:33Z", telegram_date: sent, created_at: "2026-08-09T21:20:23Z" }),
      photo({ taken_at: "2026-08-09T11:38:01Z", telegram_date: sent, created_at: "2026-08-09T21:20:14Z" }),
      photo({ taken_at: "2026-08-09T18:02:00Z", telegram_date: sent, created_at: "2026-08-09T21:20:20Z" }),
    ];
    expect([...batch].sort(byPhotoTime).map((p) => p.taken_at)).toEqual([
      "2026-08-09T11:38:01Z",
      "2026-08-09T18:02:00Z",
      "2026-08-09T20:08:33Z",
    ]);
  });

  it("keeps a batch with no capture times in upload order, stably", () => {
    // Day 3 in the wild: seven photos, one identical send timestamp.
    const sent = "2026-08-08T19:21:15Z";
    const batch = [
      photo({ telegram_date: sent, created_at: "2026-08-08T19:21:22Z" }),
      photo({ telegram_date: sent, created_at: "2026-08-08T19:21:16Z" }),
      photo({ telegram_date: sent, created_at: "2026-08-08T19:21:19Z" }),
    ];
    expect([...batch].sort(byPhotoTime).map((p) => p.created_at)).toEqual([
      "2026-08-08T19:21:16Z",
      "2026-08-08T19:21:19Z",
      "2026-08-08T19:21:22Z",
    ]);
  });

  it("interleaves photos that have a capture time with ones that don't", () => {
    const withExif = photo({ taken_at: "2026-08-09T12:00:00Z", telegram_date: "2026-08-09T22:00:00Z" });
    const withoutExif = photo({ telegram_date: "2026-08-09T13:00:00Z" });
    expect([withoutExif, withExif].sort(byPhotoTime)).toEqual([withExif, withoutExif]);
  });
});

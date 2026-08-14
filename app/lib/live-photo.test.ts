import { describe, expect, it } from "vitest";
import {
  LIVE_PAIR_WINDOW_MS,
  looksLikeMotion,
  motionFormat,
  parkedMotionIsFresh,
  pickStillForMotion,
  type MotionCandidate,
} from "./live-photo";

const still = (over: Partial<MotionCandidate> & { id: string; sentAtMs: number }): MotionCandidate => ({
  dayNumber: 3,
  storagePath: `trip-1/day-3/${over.id}.jpg`,
  hasMotion: false,
  ...over,
});

describe("looksLikeMotion", () => {
  it("takes a three-second video", () => {
    expect(
      looksLikeMotion({ durationS: 3, fileName: null, mimeType: "video/mp4", fileSize: 900_000 }),
    ).toBe(true);
  });

  it("leaves a real clip alone", () => {
    expect(
      looksLikeMotion({ durationS: 40, fileName: null, mimeType: "video/mp4", fileSize: 9_000_000 }),
    ).toBe(false);
  });

  it("judges a file by its size, having no duration to go on", () => {
    expect(
      looksLikeMotion({ durationS: null, fileName: "IMG_4711.MOV", mimeType: null, fileSize: 2_400_000 }),
    ).toBe(true);
    expect(
      looksLikeMotion({ durationS: null, fileName: "ride.mov", mimeType: null, fileSize: 60_000_000 }),
    ).toBe(false);
  });
});

describe("motionFormat", () => {
  it("recognises what Telegram compresses a video into", () => {
    expect(motionFormat("video/mp4", null)).toMatchObject({ extension: ".mp4", patchy: false });
  });

  it("keeps a QuickTime file but flags it as patchy", () => {
    expect(motionFormat("video/quicktime", "IMG_4711.MOV")).toMatchObject({
      extension: ".mov",
      patchy: true,
    });
  });

  it("falls back to the name when Telegram sends no MIME type", () => {
    expect(motionFormat(null, "IMG_4711.MOV")?.extension).toBe(".mov");
    expect(motionFormat("", "clip.mp4")?.extension).toBe(".mp4");
  });

  it("is not fooled by a photo or a track", () => {
    expect(motionFormat("image/jpeg", "IMG_4711.JPG")).toBeNull();
    expect(motionFormat(null, "route.gpx")).toBeNull();
  });
});

describe("pickStillForMotion", () => {
  const now = 1_700_000_000_000;

  it("takes the photo that was just sent, not an older one", () => {
    const picked = pickStillForMotion(now, [
      still({ id: "old", sentAtMs: now - 4000 }),
      still({ id: "new", sentAtMs: now - 1000 }),
    ]);
    expect(picked?.id).toBe("new");
  });

  it("does not hand a Live Photo's motion to the plain photo before it", () => {
    // The ordinary case: a few normal shots, then one Live Photo. The video
    // belongs to the still it was sent straight after.
    const picked = pickStillForMotion(now, [
      still({ id: "plain-1", sentAtMs: now - 240_000 }),
      still({ id: "plain-2", sentAtMs: now - 120_000 }),
      still({ id: "live-still", sentAtMs: now - 2000 }),
    ]);
    expect(picked?.id).toBe("live-still");
  });

  it("gives each of several Live Photos its own motion", () => {
    const photos = [
      still({ id: "a", sentAtMs: now - 3000 }),
      still({ id: "b", sentAtMs: now - 2000 }),
      still({ id: "c", sentAtMs: now - 1000 }),
    ];
    const paired: string[] = [];
    for (let i = 0; i < 3; i++) {
      const hit = pickStillForMotion(now, photos)!;
      paired.push(hit.id);
      hit.hasMotion = true;
    }
    expect(paired).toEqual(["c", "b", "a"]);
  });

  it("will not touch a photo that already has motion", () => {
    expect(
      pickStillForMotion(now, [still({ id: "a", sentAtMs: now - 1000, hasMotion: true })]),
    ).toBeNull();
  });

  it("lets this morning's photo go", () => {
    expect(
      pickStillForMotion(now, [still({ id: "a", sentAtMs: now - LIVE_PAIR_WINDOW_MS - 1 })]),
    ).toBeNull();
  });

  it("ignores a photo stored after the video was sent", () => {
    expect(pickStillForMotion(now, [still({ id: "a", sentAtMs: now + 5000 })])).toBeNull();
  });
});

describe("parkedMotionIsFresh", () => {
  it("holds a motion for as long as a still would have waited", () => {
    expect(parkedMotionIsFresh(1000, 1000 + LIVE_PAIR_WINDOW_MS)).toBe(true);
    expect(parkedMotionIsFresh(1000, 1000 + LIVE_PAIR_WINDOW_MS + 1)).toBe(false);
  });
});

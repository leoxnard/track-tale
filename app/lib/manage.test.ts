import { describe, expect, it } from "vitest";
import {
  countSummary,
  encodeAction,
  motionCode,
  MOTION_ANY,
  paginate,
  parseAction,
  shortLabel,
  MOTION_CODE_LENGTH,
  PAGE_SIZE,
  type ManageAction,
} from "./manage";

describe("manage callback payloads", () => {
  const uuid = "3f1b8c2e-4d5a-4b7c-9e0f-1a2b3c4d5e6f";
  const actions: ManageAction[] = [
    { type: "home" },
    { type: "ping" },
    { type: "day", dayNumber: 7, page: 0 },
    { type: "day", dayNumber: 12, page: 3 },
    { type: "ask", kind: "media", id: uuid, dayNumber: 4 },
    { type: "ask", kind: "note", id: uuid, dayNumber: 4 },
    { type: "confirm", kind: "track_segment", id: uuid, dayNumber: 21 },
    { type: "confirm", kind: "comment", id: uuid, dayNumber: 21 },
    { type: "days", page: 0, mode: "set" },
    { type: "days", page: 2, mode: "clear" },
    { type: "setday", dayNumber: 9 },
    { type: "trips" },
    { type: "usetrip", id: uuid },
    { type: "status" },
    { type: "reminders", on: true },
    { type: "reminders", on: false },
    { type: "endtrip", confirmed: false },
    { type: "endtrip", confirmed: true },
    { type: "clearday", dayNumber: 4, confirmed: false },
    { type: "clearday", dayNumber: 4, confirmed: true },
    { type: "deletetrips" },
    { type: "deletetrip", id: uuid, confirmed: false },
    { type: "deletetrip", id: uuid, confirmed: true },
    { type: "liveoff" },
    { type: "relink", confirmed: false },
    { type: "relink", confirmed: true },
    { type: "mypagelink", confirmed: true },
    { type: "mergefinish" },
    { type: "mergecancel" },
    { type: "replaceHome" },
    { type: "replaceDay", dayNumber: 7, page: 0 },
    { type: "replaceDay", dayNumber: 12, page: 3 },
    { type: "replacePick", id: uuid, dayNumber: 4 },
    { type: "replaceCancel", dayNumber: 4 },
    // A cut of the plan, from a position that travels in the payload. Southern
    // and western hemispheres included: a minus sign is a byte too, and a
    // dropped one would cut the route from the other side of the world.
    { type: "cut", km: 130, lat: 47.3769, lng: 8.5417 },
    { type: "cut", km: 5, lat: -33.86785, lng: 151.20732 },
    { type: "cut", km: 400, lat: -54.80191, lng: -68.30295 },
    // The 64-byte test below is the point of these: a waiting video and a photo
    // both have to fit in one payload, which two full uuids would not.
    { type: "motionHome", code: "a1b2c3d4" },
    { type: "motionDay", code: "a1b2c3d4", dayNumber: 12, page: 3 },
    { type: "motionPick", code: "a1b2c3d4", id: uuid },
    { type: "motionHome", code: MOTION_ANY },
    { type: "motionDay", code: MOTION_ANY, dayNumber: 6, page: 0 },
    { type: "motionPick", code: MOTION_ANY, id: uuid },
  ];

  it("round-trips every screen", () => {
    for (const action of actions) {
      expect(parseAction(encodeAction(action))).toEqual(action);
    }
  });

  it("stays inside Telegram's 64-byte limit for callback data", () => {
    // Exceeding it is not a rendering nuisance: Telegram rejects the whole
    // keyboard, so /manage would come back as a message with no buttons.
    for (const action of actions) {
      expect(new TextEncoder().encode(encodeAction(action)).length).toBeLessThanOrEqual(64);
    }
  });

  it("rejects payloads it does not recognise", () => {
    // Buttons outlive deploys, so an unreadable one has to be survivable.
    expect(parseAction("")).toBeNull();
    expect(parseAction("something:else")).toBeNull();
    expect(parseAction("mg:z")).toBeNull();
    expect(parseAction("mg:d:notanumber:0")).toBeNull();
    expect(parseAction("mg:d:3:-1")).toBeNull();
    // An unknown kind code, and a delete with no id to delete.
    expect(parseAction(`mg:a:q:3:${uuid}`)).toBeNull();
    expect(parseAction("mg:a:p:3:")).toBeNull();
    // A motion browse with no video to browse for, and a pick with no photo.
    expect(parseAction("mg:mh:")).toBeNull();
    expect(parseAction("mg:mdy::3:0")).toBeNull();
    expect(parseAction(`mg:mpk::${uuid}`)).toBeNull();
    expect(parseAction("mg:mpk:a1b2c3d4:")).toBeNull();
    // A picker with no mode, a day that is not one, and a two-step action
    // missing the half that says whether it was confirmed.
    expect(parseAction("mg:dp:0")).toBeNull();
    expect(parseAction("mg:dp:0:x")).toBeNull();
    expect(parseAction("mg:sd:0")).toBeNull();
    expect(parseAction("mg:et")).toBeNull();
    expect(parseAction("mg:dx:1:")).toBeNull();
    expect(parseAction("mg:cd:2:maybe")).toBeNull();
    // A cut with no length, a length of nothing, and coordinates off the world.
    expect(parseAction("mg:rc::47.37690:8.54170")).toBeNull();
    expect(parseAction("mg:rc:0:47.37690:8.54170")).toBeNull();
    expect(parseAction("mg:rc:130:91.00000:8.54170")).toBeNull();
    expect(parseAction("mg:rc:130:47.37690:181.00000")).toBeNull();
    expect(parseAction("mg:rc:130:47.37690")).toBeNull();
    // The same holes on the /replace side.
    expect(parseAction("mg:rd:3:-1")).toBeNull();
    expect(parseAction("mg:rp:3:")).toBeNull();
    expect(parseAction("mg:rx:nope")).toBeNull();
  });

  it("keeps deleting and replacing on separate payloads", () => {
    // The two browsers look alike and sit one tap apart. A /replace button that
    // decoded as a delete would be the worst possible collision, so this pins
    // down that no replace payload reads as anything but itself.
    for (const action of actions.filter((a) => a.type.startsWith("replace"))) {
      expect(parseAction(encodeAction(action))?.type).toBe(action.type);
    }
    expect(parseAction("mg:rh")).toEqual({ type: "replaceHome" });
    expect(parseAction("mg:h")).toEqual({ type: "home" });
  });
});

describe("shortLabel", () => {
  it("folds a multi-line note onto the one line a button gives it", () => {
    expect(shortLabel("first line\n\nsecond line", 40)).toBe("first line second line");
  });

  it("marks where it cut a long note", () => {
    const label = shortLabel("x".repeat(200), 28);
    expect(label).toHaveLength(28);
    expect(label.endsWith("…")).toBe(true);
  });

  it("gives callers an empty string to fall back from", () => {
    expect(shortLabel(null)).toBe("");
    expect(shortLabel("   ")).toBe("");
  });
});

describe("paginate", () => {
  const items = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) => i);

  it("cuts a long day into pages", () => {
    expect(paginate(items, 0).items).toEqual(items.slice(0, PAGE_SIZE));
    expect(paginate(items, 1).items).toEqual(items.slice(PAGE_SIZE, PAGE_SIZE * 2));
    expect(paginate(items, 2).pageCount).toBe(3);
  });

  it("clamps a page that no longer exists", () => {
    // Deleting the last item on the last page walks the traveller off the end.
    expect(paginate(items, 99).page).toBe(2);
    expect(paginate([], 4)).toEqual({ items: [], page: 0, pageCount: 1 });
  });
});

describe("countSummary", () => {
  it("leaves out what a day hasn't got", () => {
    expect(countSummary({ note: 2, media: 0, track_segment: 1, comment: 0 })).toBe("🛤️ 1 · 📝 2");
    expect(countSummary({ note: 0, media: 0, track_segment: 0, comment: 3 })).toBe("💬 3");
    expect(countSummary({ note: 0, media: 0, track_segment: 0, comment: 0 })).toBe("");
  });
});

describe("motionCode", () => {
  it("names a waiting video short enough to share a payload with a photo", () => {
    const code = motionCode("f47ac10b-58cc-4372-a567-0e02b2c3d479");
    expect(code).toBe("f47ac10b");
    expect(code).toHaveLength(MOTION_CODE_LENGTH);
  });

  it("can never collide with the browse-anything sentinel", () => {
    // The sentinel means "no video in hand". A real code that happened to equal
    // it would turn a pick into an unpair.
    expect(motionCode("f47ac10b-58cc-4372-a567-0e02b2c3d479")).not.toBe(MOTION_ANY);
    expect(motionCode("--------------------------------")).not.toBe(MOTION_ANY);
  });

  it("gives two videos different codes", () => {
    expect(motionCode("f47ac10b-58cc-4372-a567-0e02b2c3d479")).not.toBe(
      motionCode("a1b2c3d4-58cc-4372-a567-0e02b2c3d479"),
    );
  });
});

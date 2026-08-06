import { describe, expect, it } from "vitest";
import {
  countSummary,
  encodeAction,
  paginate,
  parseAction,
  shortLabel,
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

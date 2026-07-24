import { describe, expect, it } from "vitest";
import { escapeErr, escapeMd, slugId } from "./telegram-md";

describe("escapeMd", () => {
  it("escapes every character Telegram reads as formatting", () => {
    expect(escapeMd("My_Trip")).toBe("My\\_Trip");
    expect(escapeMd("a*b`c[d]e")).toBe("a\\*b\\`c\\[d\\]e");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeMd("Alpen 2026 — Tag 3 (Süden)")).toBe("Alpen 2026 — Tag 3 (Süden)");
  });

  it("escapes an unbalanced marker, which is what actually breaks a message", () => {
    // Telegram rejects the whole message on an entity that never closes.
    expect(escapeMd("share_token")).toBe("share\\_token");
  });
});

describe("escapeErr", () => {
  it("escapes the message of a real error", () => {
    expect(escapeErr(new Error("no route for tour_planned"))).toBe("no route for tour\\_planned");
  });

  it("falls back to a fixed string for anything that is not an Error", () => {
    expect(escapeErr("boom_")).toBe("unknown error");
    expect(escapeErr(undefined)).toBe("unknown error");
  });
});

describe("slugId", () => {
  it("generates ids that never need escaping", () => {
    // Regression guard for the /mypage outage: nanoid's default alphabet
    // contains "_" and "-", and roughly 40% of 16-character ids carried one.
    for (let i = 0; i < 500; i++) {
      const id = slugId(16);
      expect(id).toMatch(/^[0-9a-zA-Z]{16}$/);
      expect(escapeMd(id)).toBe(id);
    }
  });

  it("honours the requested length", () => {
    expect(slugId(20)).toHaveLength(20);
    expect(slugId(10)).toHaveLength(10);
  });
});

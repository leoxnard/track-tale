import { describe, expect, it } from "vitest";
import { findKomootUrl, parseKomootUrl } from "./komoot";

describe("parseKomootUrl", () => {
  it("reads the tour id from a plain link", () => {
    expect(parseKomootUrl("https://www.komoot.com/tour/3111373277")?.tourId).toBe("3111373277");
  });

  it("reads a locale-prefixed link", () => {
    expect(parseKomootUrl("https://www.komoot.de/de-DE/tour/3111373277")?.tourId).toBe("3111373277");
    expect(parseKomootUrl("https://www.komoot.com/en/tour/3111373277")?.tourId).toBe("3111373277");
  });

  it("keeps the share token, which is what makes the API call work", () => {
    const ref = parseKomootUrl("https://www.komoot.com/tour/3111373277?share_token=abc123&ref=wtd");
    expect(ref).toEqual({ tourId: "3111373277", shareToken: "abc123" });
  });

  it("leaves the token unset when the link carries none", () => {
    expect(parseKomootUrl("https://www.komoot.com/tour/3111373277")?.shareToken).toBeUndefined();
  });

  it("returns null for anything that is not a komoot tour", () => {
    expect(parseKomootUrl("https://www.strava.com/activities/123")).toBeNull();
    expect(parseKomootUrl("https://www.komoot.com/user/12345")).toBeNull();
    expect(parseKomootUrl("just some text")).toBeNull();
  });
});

describe("findKomootUrl", () => {
  it("picks a link out of a chat message", () => {
    const text = "here you go https://www.komoot.com/tour/3111373277?share_token=abc mind the gravel";
    expect(findKomootUrl(text)).toBe("https://www.komoot.com/tour/3111373277?share_token=abc");
  });

  it("returns null when there is no link", () => {
    expect(findKomootUrl("lovely ride today")).toBeNull();
  });

  it("hands findable links straight to the parser", () => {
    const found = findKomootUrl("look: https://www.komoot.de/de-DE/tour/999?share_token=zz");
    expect(parseKomootUrl(found!)).toEqual({ tourId: "999", shareToken: "zz" });
  });
});

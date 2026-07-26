import { describe, expect, it } from "vitest";
import { formatDuration, langCookie, messages, resolveLocale } from "./i18n";

function request(headers: Record<string, string>): Request {
  return new Request("https://tracktale.test/t/abc", { headers });
}

describe("resolveLocale", () => {
  it("falls back to English with nothing to go on", () => {
    expect(resolveLocale(request({}))).toBe("en");
  });

  it("follows the browser's preference", () => {
    expect(resolveLocale(request({ "accept-language": "de-CH,de;q=0.9,en;q=0.8" }))).toBe("de");
  });

  it("skips languages it doesn't have", () => {
    expect(resolveLocale(request({ "accept-language": "fr-FR,fr;q=0.9,de;q=0.5" }))).toBe("de");
  });

  it("honours q-weights rather than order", () => {
    expect(resolveLocale(request({ "accept-language": "en;q=0.4,de;q=0.9" }))).toBe("de");
  });

  it("ignores a language offered at q=0", () => {
    expect(resolveLocale(request({ "accept-language": "de;q=0,en" }))).toBe("en");
  });

  it("lets a chosen language beat the browser", () => {
    const req = request({ "accept-language": "en-GB,en;q=0.9", cookie: "lang=de" });
    expect(resolveLocale(req)).toBe("de");
  });

  it("falls back to the browser when the cookie asks for a language we don't have", () => {
    const req = request({ "accept-language": "de", cookie: "other=1; lang=fr" });
    expect(resolveLocale(req)).toBe("de");
  });

  it("reads the cookie even when it isn't the first one", () => {
    expect(resolveLocale(request({ cookie: "session=xyz; lang=de" }))).toBe("de");
  });
});

describe("dictionaries", () => {
  it("translates plurals per language", () => {
    expect(messages("en").trip.days(1)).toBe("1 day");
    expect(messages("en").trip.days(3)).toBe("3 days");
    expect(messages("de").trip.days(1)).toBe("1 Tag");
    expect(messages("de").trip.days(3)).toBe("3 Tage");
  });

  it("names the weather in both languages", () => {
    expect(messages("en").weather.thunderstorm).toBe("Thunderstorm");
    expect(messages("de").weather.thunderstorm).toBe("Gewitter");
  });
});

describe("formatDuration", () => {
  it("drops the hour when there isn't one", () => {
    expect(formatDuration(25 * 60, "en")).toBe("25m");
    expect(formatDuration(25 * 60, "de")).toBe("25 min");
  });

  it("uses each language's short units", () => {
    expect(formatDuration(3 * 3600 + 20 * 60, "en")).toBe("3h 20m");
    expect(formatDuration(3 * 3600 + 20 * 60, "de")).toBe("3 h 20 min");
  });
});

describe("langCookie", () => {
  it("stores the choice for a year on every path", () => {
    expect(langCookie("de")).toBe("lang=de; Path=/; Max-Age=31536000; SameSite=Lax");
  });
});

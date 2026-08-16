import { describe, expect, it } from "vitest";
import { packItemLine, packListCsv, parsePackItem } from "./packing";

describe("parsePackItem", () => {
  it("reads title, model and link", () => {
    const parsed = parsePackItem("Tent | Hilleberg Anjan 2 | https://hilleberg.com/anjan");
    expect(parsed).toEqual({
      ok: true,
      fields: {
        title: "Tent",
        model: "Hilleberg Anjan 2",
        url: "https://hilleberg.com/anjan",
      },
    });
  });

  it("takes a title on its own", () => {
    expect(parsePackItem("  Spare tube  ")).toEqual({
      ok: true,
      fields: { title: "Spare tube", model: null, url: null },
    });
  });

  it("tells a link from a model by its shape, not its position", () => {
    const parsed = parsePackItem("Stove | https://trangia.se/25-1");
    expect(parsed.ok && parsed.fields).toEqual({
      title: "Stove",
      model: null,
      url: "https://trangia.se/25-1",
    });
  });

  it("survives the empty field somebody types anyway", () => {
    const parsed = parsePackItem("Stove || https://trangia.se/25-1");
    expect(parsed.ok && parsed.fields.title).toBe("Stove");
    expect(parsed.ok && parsed.fields.url).toBe("https://trangia.se/25-1");
  });

  it("assumes https for a link typed without one", () => {
    const parsed = parsePackItem("Panniers | www.ortlieb.com/back-roller");
    expect(parsed.ok && parsed.fields.url).toBe("https://www.ortlieb.com/back-roller");
  });

  it("keeps every extra field as part of the model rather than dropping it", () => {
    const parsed = parsePackItem("Sleeping bag | Cumulus | Panyam 450");
    expect(parsed.ok && parsed.fields.model).toBe("Cumulus | Panyam 450");
  });

  it("refuses a line with nothing on it", () => {
    expect(parsePackItem("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a bare link, which has no title to head it", () => {
    expect(parsePackItem("https://ortlieb.com")).toEqual({ ok: false, reason: "no-title" });
  });

  it("refuses a link only a browser would run", () => {
    // Not a URL by our rules at all, so it lands in the model — where it is
    // text on a page and nothing else.
    const parsed = parsePackItem("Torch | javascript:alert(1)");
    expect(parsed.ok && parsed.fields.url).toBe(null);
    expect(parsed.ok && parsed.fields.model).toBe("javascript:alert(1)");
  });

  it("refuses a link that says http and then isn't one", () => {
    expect(parsePackItem("Torch | https://")).toEqual({ ok: false, reason: "bad-url" });
  });
});

describe("packItemLine", () => {
  it("leaves out what was never given", () => {
    expect(packItemLine({ title: "Spare tube", model: null, url: null })).toBe("Spare tube");
    expect(packItemLine({ title: "Tent", model: "Anjan 2", url: null })).toBe("Tent · Anjan 2");
  });
});

describe("packListCsv", () => {
  it("writes a header and a row per item", () => {
    const csv = packListCsv([
      { title: "Tent", model: "Anjan 2", url: "https://hilleberg.com" },
      { title: "Spare tube", model: null, url: null },
    ]);
    expect(csv.replace("﻿", "").split("\r\n")).toEqual([
      "Title,Model,Link",
      "Tent,Anjan 2,https://hilleberg.com",
      "Spare tube,,",
      "",
    ]);
  });

  it("quotes a cell that would otherwise break the row", () => {
    const csv = packListCsv([{ title: 'Bag, "big"', model: "a\nb", url: null }]);
    expect(csv).toContain('"Bag, ""big""","a\nb",');
  });

  it("starts with the mark that stops Excel mangling umlauts", () => {
    expect(packListCsv([])).toMatch(/^﻿/);
  });
});

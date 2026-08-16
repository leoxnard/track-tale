import { describe, expect, it } from "vitest";
import {
  categoriesOf,
  cleanField,
  groupByCategory,
  packItemLine,
  packListCsv,
  normaliseUrl,
  MAX_TITLE,
} from "./packing";

describe("normaliseUrl", () => {
  it("takes a link as typed", () => {
    expect(normaliseUrl(" https://hilleberg.com/anjan ")).toBe("https://hilleberg.com/anjan");
  });

  it("assumes https for an address typed without a scheme", () => {
    expect(normaliseUrl("www.ortlieb.com/back-roller")).toBe("https://www.ortlieb.com/back-roller");
  });

  it("refuses anything a browser would run rather than fetch", () => {
    expect(normaliseUrl("javascript:alert(1)")).toBeNull();
    expect(normaliseUrl("data:text/html,<script>")).toBeNull();
  });

  it("refuses a scheme with nothing behind it", () => {
    expect(normaliseUrl("https://")).toBeNull();
  });

  it("refuses ordinary words, which is what most answers are", () => {
    expect(normaliseUrl("Ortlieb Back-Roller Classic")).toBeNull();
  });
});

describe("cleanField", () => {
  it("folds whitespace and cuts to length", () => {
    expect(cleanField("  Hilleberg   Anjan 2 ", 160)).toBe("Hilleberg Anjan 2");
    expect(cleanField("x".repeat(200), MAX_TITLE)).toHaveLength(MAX_TITLE);
  });

  it("reads an answer with nothing in it as no answer", () => {
    expect(cleanField("   ", 40)).toBeNull();
  });
});

describe("groupByCategory", () => {
  const items = [
    { title: "Tent", category: "Camping" },
    { title: "Chain lube", category: "Bike" },
    { title: "Spare tube", category: "Bike" },
    { title: "Passport", category: null },
    { title: "Pegs", category: "Camping" },
  ];

  it("keeps categories in the order they first appeared", () => {
    expect(groupByCategory(items).map((g) => g.category)).toEqual(["Camping", "Bike", null]);
  });

  it("gathers a category that comes back later", () => {
    const camping = groupByCategory(items)[0];
    expect(camping.items.map((i) => i.title)).toEqual(["Tent", "Pegs"]);
  });

  it("puts the unfiled things last, whenever they were added", () => {
    const last = groupByCategory(items).at(-1);
    expect(last?.category).toBeNull();
    expect(last?.items.map((i) => i.title)).toEqual(["Passport"]);
  });

  it("has no group at all for a list nobody filed", () => {
    expect(groupByCategory([{ title: "Passport", category: null }])).toEqual([
      { category: null, items: [{ title: "Passport", category: null }] },
    ]);
    expect(categoriesOf([{ category: null }])).toEqual([]);
  });

  it("names every category once, for the buttons that offer them", () => {
    expect(categoriesOf(items)).toEqual(["Camping", "Bike"]);
  });
});

describe("packItemLine", () => {
  it("leaves out what was never given", () => {
    expect(packItemLine({ title: "Spare tube", model: null, url: null, category: null })).toBe(
      "Spare tube",
    );
    expect(packItemLine({ title: "Tent", model: "Anjan 2", url: null, category: "Camping" })).toBe(
      "Tent · Anjan 2",
    );
  });
});

describe("packListCsv", () => {
  it("writes a header and a row per item, grouped", () => {
    const csv = packListCsv([
      { title: "Tent", model: "Anjan 2", url: "https://hilleberg.com", category: "Camping" },
      { title: "Spare tube", model: null, url: null, category: "Bike" },
      { title: "Pegs", model: null, url: null, category: "Camping" },
    ]);
    expect(csv.replace("﻿", "").split("\r\n")).toEqual([
      "Category,Title,Model,Link",
      "Camping,Tent,Anjan 2,https://hilleberg.com",
      "Camping,Pegs,,",
      "Bike,Spare tube,,",
      "",
    ]);
  });

  it("quotes a cell that would otherwise break the row", () => {
    const csv = packListCsv([
      { title: 'Bag, "big"', model: "a\nb", url: null, category: null },
    ]);
    expect(csv).toContain('"Bag, ""big""","a\nb",');
  });

  it("starts with the mark that stops Excel mangling umlauts", () => {
    expect(packListCsv([])).toMatch(/^﻿/);
  });
});

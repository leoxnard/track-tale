import { describe, expect, it } from "vitest";
import {
  APPLE_ICON_SIZE,
  ICON_SIZES,
  iconFileName,
  iconHref,
  logoInitials,
  logoVersion,
  parseIconFile,
  tripLogoSvg,
} from "./trip-logo";

describe("logoInitials", () => {
  it("takes one letter from each of the first two words", () => {
    expect(logoInitials("Nordkap Tour")).toBe("NT");
    expect(logoInitials("Alpen Cross 2026")).toBe("AC");
  });

  it("takes two letters from a single word", () => {
    expect(logoInitials("Rheinradweg")).toBe("RH");
  });

  it("reads a capital inside a word as the next word starting", () => {
    expect(logoInitials("HighlandKinder")).toBe("HK");
    expect(logoInitials("AlpenCross")).toBe("AC");
  });

  it("keeps a run of capitals together", () => {
    expect(logoInitials("NORDKAP")).toBe("NO");
    expect(logoInitials("GPXTour")).toBe("GT");
  });

  it("treats punctuation and emoji as a space, glyph or no glyph", () => {
    expect(logoInitials("🚲 Rund um den Bodensee")).toBe("RU");
    expect(logoInitials("Nord–Süd")).toBe("NS");
    expect(logoInitials("nordkap-tour")).toBe("NT");
  });

  it("falls back rather than drawing an empty tile", () => {
    expect(logoInitials("   ")).toBe("TT");
    expect(logoInitials("🚲")).toBe("TT");
  });

  it("keeps a name that opens outside the BMP in one piece", () => {
    // A surrogate pair sliced in half renders as a replacement character.
    expect(Array.from(logoInitials("𝔄lpen")).length).toBeGreaterThan(0);
  });
});

describe("logoVersion", () => {
  it("is stable for the same name", () => {
    expect(logoVersion("Nordkap Tour")).toBe(logoVersion("Nordkap Tour"));
  });

  it("ignores stray whitespace", () => {
    expect(logoVersion("  Nordkap   Tour ")).toBe(logoVersion("Nordkap Tour"));
  });

  it("follows case, because the letters on the tile do", () => {
    // HighlandKinder draws HK and highlandkinder draws HI, so the two cannot
    // share a URL a phone caches forever.
    expect(logoVersion("HighlandKinder")).not.toBe(logoVersion("highlandkinder"));
  });

  it("changes when the trip is renamed, which is what busts the cache", () => {
    expect(logoVersion("Nordkap Tour")).not.toBe(logoVersion("Nordkap Tour 2"));
  });
});

describe("tripLogoSvg", () => {
  it("draws the same tile twice for the same name", () => {
    expect(tripLogoSvg("Nordkap Tour", 180)).toBe(tripLogoSvg("Nordkap Tour", 180));
  });

  it("gives different names different grounds often enough to tell apart", () => {
    const names = ["Nordkap", "Alpen", "Bodensee", "Rheintal", "Elberadweg", "Ostsee"];
    expect(new Set(names.map(ground)).size).toBeGreaterThan(3);
  });

  it("lets no part of a name reach the document as markup", () => {
    // Two guards, one behind the other: only letters and digits ever become
    // initials, and what does is escaped anyway.
    const svg = tripLogoSvg("<script>alert(1)</script> & co", 180);
    expect(svg).not.toContain("<script>");
    expect(/>SA</.test(svg)).toBe(true);
  });

  it("carries the asked-for size and a fixed unit box", () => {
    const svg = tripLogoSvg("Nordkap Tour", 512);
    expect(svg).toContain('width="512"');
    expect(svg).toContain('viewBox="0 0 100 100"');
  });

  it("bleeds to the edges so a round mask has something to crop", () => {
    expect(tripLogoSvg("Nordkap Tour", 180)).toContain('<rect width="100" height="100"');
  });
});

/** The first gradient stop, which is the part of the tile a glance sees. */
function ground(name: string): string {
  return /stop-color="(#[0-9a-f]{6})"/.exec(tripLogoSvg(name, 180))![1];
}

describe("parseIconFile", () => {
  it("round-trips every size the page hands out", () => {
    for (const size of ICON_SIZES) expect(parseIconFile(iconFileName(size))).toBe(size);
  });

  it("refuses a size nobody asked for, rasteriser included", () => {
    expect(parseIconFile("icon-8000.png")).toBeNull();
    expect(parseIconFile("icon-181.png")).toBeNull();
    expect(parseIconFile("icon.png")).toBeNull();
    expect(parseIconFile("../../etc/passwd")).toBeNull();
  });
});

describe("iconHref", () => {
  it("stamps the name's version onto the URL", () => {
    const href = iconHref("secret-slug", APPLE_ICON_SIZE, "Nordkap Tour");
    expect(href).toBe(`/t/secret-slug/icon/icon-180.png?v=${logoVersion("Nordkap Tour")}`);
  });
});

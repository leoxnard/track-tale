import { describe, expect, it } from "vitest";

import { scrubUrl } from "./analytics";

// A trip link is the credential. If a slug ever reached the analytics
// database it would sit there in plain text, readable by anyone with access —
// these tests are the boundary that stops it.
describe("scrubUrl", () => {
  it("strips the trip slug", () => {
    expect(scrubUrl("/t/summer-alps-2026-x7f2")).toBe("/t/[slug]");
  });

  it("strips the traveler slug", () => {
    expect(scrubUrl("/traveler/leo-9k3m")).toBe("/traveler/[slug]");
  });

  it("keeps the rest of the path", () => {
    expect(scrubUrl("/t/secret/day/3")).toBe("/t/[slug]/day/3");
  });

  it("strips the slug from every sub-route of a trip", () => {
    expect(scrubUrl("/t/secret/downloads")).toBe("/t/[slug]/downloads");
    expect(scrubUrl("/t/secret/packing")).toBe("/t/[slug]/packing");
    expect(scrubUrl("/t/secret/download/track.gpx")).toBe("/t/[slug]/download/track.gpx");
    expect(scrubUrl("/t/secret/manifest.webmanifest")).toBe("/t/[slug]/manifest.webmanifest");
  });

  it("keeps the query without leaking the slug", () => {
    expect(scrubUrl("/t/secret?day=3")).toBe("/t/[slug]?day=3");
  });

  it("leaves slug-free pages alone", () => {
    expect(scrubUrl("/")).toBe("/");
    expect(scrubUrl("/preview")).toBe("/preview");
  });

  it("only matches at the start of the path, not inside a query value", () => {
    expect(scrubUrl("/preview?from=/t/secret")).toBe("/preview?from=/t/secret");
  });
});

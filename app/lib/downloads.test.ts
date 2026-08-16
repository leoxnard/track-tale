import { describe, expect, it } from "vitest";
import {
  attachmentName,
  downloadFileName,
  parseDownloadFile,
  slugifyName,
  type DownloadRequest,
} from "./downloads";

const REQUESTS: DownloadRequest[] = [
  { kind: "gpx", day: null },
  { kind: "gpx", day: 7 },
  { kind: "photos", day: null },
  { kind: "photos", day: 7 },
];

describe("download file names", () => {
  it("names each of the four things the centre offers", () => {
    expect(REQUESTS.map(downloadFileName)).toEqual([
      "trip.gpx",
      "day-7.gpx",
      "photos.zip",
      "day-7-photos.zip",
    ]);
  });

  it("reads every name it writes back to the same request", () => {
    for (const req of REQUESTS) {
      expect(parseDownloadFile(downloadFileName(req))).toEqual(req);
    }
  });

  it("refuses anything that is not one of ours", () => {
    for (const file of [
      "trip.zip",
      "day-.gpx",
      "day-x.gpx",
      "day-7.GPX",
      "day-7-photos.tar",
      "../secret.gpx",
      "day-7.gpx/../trip.gpx",
      "",
    ]) {
      expect(parseDownloadFile(file), file).toBeNull();
    }
  });
});

describe("attachmentName", () => {
  it("puts the trip on the file, not just the day", () => {
    expect(attachmentName("Rhône 2026", { kind: "gpx", day: 3 })).toBe("rhone-2026-day-3.gpx");
    expect(attachmentName("Rhône 2026", { kind: "photos", day: null })).toBe(
      "rhone-2026-photos.zip",
    );
  });

  it("survives a name with nothing usable in it", () => {
    expect(attachmentName("!!!", { kind: "gpx", day: null })).toBe("trip.gpx");
  });
});

describe("slugifyName", () => {
  it("keeps German names readable", () => {
    expect(slugifyName("Großglockner Tour")).toBe("grossglockner-tour");
    expect(slugifyName("Über die Alpen")).toBe("uber-die-alpen");
  });

  it("collapses punctuation and trims the edges", () => {
    expect(slugifyName("  Trip — 2026!  ")).toBe("trip-2026");
  });
});

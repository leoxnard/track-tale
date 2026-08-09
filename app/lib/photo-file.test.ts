import { describe, expect, it } from "vitest";
import { imageDocument } from "./photo-file";

describe("imageDocument", () => {
  it("accepts a JPEG, the format a Lightroom export lands in", () => {
    expect(imageDocument("image/jpeg", "DSC_0042.jpg")).toEqual({
      extension: ".jpg",
      contentType: "image/jpeg",
      keepsExif: true,
    });
  });

  it("accepts a PNG", () => {
    expect(imageDocument("image/png", "screenshot.png")).toMatchObject({ extension: ".png" });
  });

  it("falls back to the file name when Telegram sends no MIME type", () => {
    expect(imageDocument(undefined, "IMG_1234.JPEG")).toMatchObject({ extension: ".jpg" });
    expect(imageDocument("", "photo.png")).toMatchObject({ extension: ".png" });
  });

  it("trusts the MIME type over a misleading name", () => {
    expect(imageDocument("image/png", "actually-a-png.jpg")).toMatchObject({ extension: ".png" });
  });

  it("flags HEIC as unreadable so the bot can explain itself", () => {
    expect(imageDocument("image/heic", "IMG_0001.HEIC")).toBe("unreadable");
    expect(imageDocument(undefined, "IMG_0001.heif")).toBe("unreadable");
  });

  it("flags other image formats as unreadable rather than storing them blind", () => {
    expect(imageDocument("image/tiff", "scan.tif")).toBe("unreadable");
  });

  it("ignores documents that are not images, so tracks keep their own path", () => {
    expect(imageDocument("application/gpx+xml", "ride.gpx")).toBeNull();
    expect(imageDocument(undefined, "ride.fit")).toBeNull();
    expect(imageDocument("application/pdf", "route.pdf")).toBeNull();
  });
});

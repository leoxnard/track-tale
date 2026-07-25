import { describe, expect, it } from "vitest";
import { findLiveTrackUrl, isGarminSender } from "./live-link";

describe("findLiveTrackUrl", () => {
  it("finds a link pasted into a chat message", () => {
    expect(findLiveTrackUrl("on the road https://livetrack.garmin.com/session/abc-123/token/XYZ now")).toBe(
      "https://livetrack.garmin.com/session/abc-123/token/XYZ",
    );
  });

  it("finds the regional connect form", () => {
    expect(findLiveTrackUrl("see https://connect.garmin.com/livetrack/session/9")).toBe(
      "https://connect.garmin.com/livetrack/session/9",
    );
  });

  it("stops at the closing quote inside an HTML email body", () => {
    const html = `<a href="https://livetrack.garmin.com/session/abc/token/XYZ" style="color:red">Follow</a>`;
    expect(findLiveTrackUrl(html)).toBe("https://livetrack.garmin.com/session/abc/token/XYZ");
  });

  it("unescapes entity-encoded query separators from an HTML body", () => {
    const html = `<a href="https://livetrack.garmin.com/session/a?u=1&amp;t=2">go</a>`;
    expect(findLiveTrackUrl(html)).toBe("https://livetrack.garmin.com/session/a?u=1&t=2");
  });

  it("drops trailing sentence punctuation", () => {
    expect(findLiveTrackUrl("track me at https://livetrack.garmin.com/session/abc.")).toBe(
      "https://livetrack.garmin.com/session/abc",
    );
  });

  it("ignores a lookalike host", () => {
    // A prefix match would hand the family a link to someone else's server.
    expect(findLiveTrackUrl("https://livetrack.garmin.com.evil.example/session/abc")).toBe(null);
    expect(findLiveTrackUrl("https://connect.garmin.com.evil.example/livetrack/1")).toBe(null);
    expect(findLiveTrackUrl("https://notgarmin.com/livetrack/session/1")).toBe(null);
  });

  it("still matches a bare host link mid-sentence", () => {
    expect(findLiveTrackUrl("follow at https://livetrack.garmin.com and cheer")).toBe(
      "https://livetrack.garmin.com",
    );
  });

  it("returns null when there is no link", () => {
    expect(findLiveTrackUrl("Made it over the pass, knackered")).toBe(null);
  });
});

describe("isGarminSender", () => {
  it("accepts garmin.com and its subdomains", () => {
    expect(isGarminSender("noreply@garmin.com")).toBe(true);
    expect(isGarminSender("Garmin LiveTrack <no-reply@notify.garmin.com>")).toBe(true);
    expect(isGarminSender("NOREPLY@GARMIN.COM")).toBe(true);
  });

  it("rejects a domain that merely ends in the same letters", () => {
    expect(isGarminSender("spoof@notgarmin.com")).toBe(false);
    expect(isGarminSender("spoof@garmin.com.evil.example")).toBe(false);
  });

  it("rejects a display name that quotes a Garmin address", () => {
    // The angle-bracket address is what actually delivered the mail.
    expect(isGarminSender('"noreply@garmin.com" <attacker@evil.example>')).toBe(false);
  });

  it("rejects malformed senders", () => {
    expect(isGarminSender("")).toBe(false);
    expect(isGarminSender("garmin.com")).toBe(false);
  });
});

import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySvixSignature } from "./webhook-signature";

const key = randomBytes(24);
const secret = `whsec_${key.toString("base64")}`;
const body = JSON.stringify({ type: "email.received", data: { email_id: "abc" } });
const id = "msg_2b1c";
const now = 1_800_000_000_000;
const timestamp = String(now / 1000);

function sign(over: string, withKey = key): string {
  return `v1,${createHmac("sha256", withKey).update(over).digest("base64")}`;
}

const good = {
  secret,
  headers: { id, timestamp, signature: sign(`${id}.${timestamp}.${body}`) },
  body,
  now,
};

describe("verifySvixSignature", () => {
  it("accepts a correctly signed payload", () => {
    expect(verifySvixSignature(good)).toBe(true);
  });

  it("accepts the secret with or without the whsec_ prefix", () => {
    expect(verifySvixSignature({ ...good, secret: key.toString("base64") })).toBe(true);
  });

  it("picks the matching signature out of several", () => {
    const others = `v1,${randomBytes(32).toString("base64")}`;
    const signature = `${others} ${sign(`${id}.${timestamp}.${body}`)}`;
    expect(verifySvixSignature({ ...good, headers: { ...good.headers, signature } })).toBe(true);
  });

  it("rejects a body altered after signing", () => {
    const tampered = body.replace("abc", "xyz");
    expect(verifySvixSignature({ ...good, body: tampered })).toBe(false);
  });

  it("rejects a signature made with the wrong key", () => {
    const signature = sign(`${id}.${timestamp}.${body}`, randomBytes(24));
    expect(verifySvixSignature({ ...good, headers: { ...good.headers, signature } })).toBe(false);
  });

  it("rejects a replay from outside the tolerance window", () => {
    // Correctly signed, but six minutes old.
    const old = String(now / 1000 - 6 * 60);
    const signature = sign(`${id}.${old}.${body}`);
    expect(
      verifySvixSignature({ ...good, headers: { id, timestamp: old, signature } }),
    ).toBe(false);
  });

  it("accepts a timestamp skewed within tolerance in either direction", () => {
    for (const skew of [-4 * 60, 4 * 60]) {
      const ts = String(now / 1000 + skew);
      const signature = sign(`${id}.${ts}.${body}`);
      expect(verifySvixSignature({ ...good, headers: { id, timestamp: ts, signature } })).toBe(true);
    }
  });

  it("rejects missing headers rather than throwing", () => {
    expect(verifySvixSignature({ ...good, headers: { id: null, timestamp, signature: "v1,x" } })).toBe(false);
    expect(verifySvixSignature({ ...good, headers: { id, timestamp: null, signature: "v1,x" } })).toBe(false);
    expect(verifySvixSignature({ ...good, headers: { id, timestamp, signature: null } })).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifySvixSignature({ ...good, headers: { ...good.headers, timestamp: "not-a-time" } }),
    ).toBe(false);
  });

  it("ignores signature versions it does not understand", () => {
    const signature = sign(`${id}.${timestamp}.${body}`).replace("v1,", "v2,");
    expect(verifySvixSignature({ ...good, headers: { ...good.headers, signature } })).toBe(false);
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Svix webhook signature verification, which is what Resend uses.
 *
 * Written out rather than pulling in the `svix` package: it is a dozen lines of
 * HMAC and the alternative is a dependency in the request path of an endpoint
 * that can turn on a banner for the whole family.
 */

/** Replays older than this are rejected even with a valid signature. */
const TOLERANCE_S = 5 * 60;

export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function verifySvixSignature({
  secret,
  headers,
  body,
  now = Date.now(),
}: {
  /** The `whsec_…` signing secret from the Resend webhook page. */
  secret: string;
  headers: SvixHeaders;
  /** The raw request body, byte for byte as received. */
  body: string;
  now?: number;
}): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs(now / 1000 - sentAt) > TOLERANCE_S) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;

  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");

  // The header carries space-separated `v<n>,<signature>` pairs; any matching
  // v1 entry is enough, and every candidate is compared in constant time.
  return signature
    .split(" ")
    .filter((part) => part.startsWith("v1,"))
    .some((part) => constantTimeEquals(part.slice(3), expected));
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself not secret.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

import { env } from "../lib/env.server";
import { applyInboundLiveEmail } from "../lib/live-email.server";
import { verifySvixSignature } from "../lib/webhook-signature";

/**
 * Resend inbound webhook. Garmin emails a LiveTrack link to the inbound address
 * when a ride starts, and this turns it into the live banner.
 *
 * Refuses everything unless live tracking is switched on and both secrets are
 * configured, so an environment without inbound mail set up cannot be poked at.
 */
export async function action({ request }: { request: Request }) {
  const secret = env.resendInboundSecret;
  if (!env.liveTracking || !secret || !env.resendApiKey) {
    return new Response("inbound email is not configured", { status: 404 });
  }

  // Signature is over the exact bytes, so read the body as text and parse after.
  const body = await request.text();
  const verified = verifySvixSignature({
    secret,
    headers: {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    body,
  });
  if (!verified) {
    console.error("inbound email rejected: bad signature");
    return new Response("forbidden", { status: 403 });
  }

  try {
    const outcome = await applyInboundLiveEmail(JSON.parse(body));
    // A rejected message is still a message we successfully handled — 200 keeps
    // Resend from retrying mail that will never be accepted.
    if (!outcome.ok) console.warn("inbound email ignored:", outcome.reason);
    return Response.json(outcome);
  } catch (err) {
    console.error("inbound email failed", err);
    return new Response("error", { status: 500 });
  }
}

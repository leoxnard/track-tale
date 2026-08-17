import { data } from "react-router";
import type { Route } from "./+types/t.$slug.icon.$file";
import { getTripBySlug } from "../lib/db.server";
import { parseIconFile, logoVersion } from "../lib/trip-logo";
import { tripLogoPng } from "../lib/trip-logo.server";

/**
 * The tile a phone puts on its home screen for this trip — see `trip-logo.ts`
 * for what is drawn and why it is drawn from the name rather than stored.
 *
 * Drawn per request, which sounds worse than it is: a 100-unit SVG at 512 px is
 * a couple of milliseconds, and a home screen asks for it once. In exchange
 * there is no bucket to keep in step with a rename, and nothing to clean up
 * when a trip is deleted.
 *
 * Cached hard, because the URL carries the name's hash: a renamed trip asks for
 * a different one, so the answer to *this* URL never changes. That is the whole
 * reason for the `?v=` the page appends.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const size = parseIconFile(params.file);
  if (!size) throw data("Not found", { status: 404 });

  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Not found", { status: 404 });

  const stamped = new URL(request.url).searchParams.get("v") === logoVersion(trip.name);

  return new Response(new Uint8Array(tripLogoPng(trip.name, size)), {
    headers: {
      "Content-Type": "image/png",
      // Unstamped requests are the ones a browser guesses at (`/icon-180.png`
      // straight off a manifest a phone kept), so they get a short life; the
      // stamped ones the page hands out cannot go stale.
      "Cache-Control": stamped
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    },
  });
}

import { data } from "react-router";
import type { Route } from "./+types/t.$slug.manifest";
import { getTripBySlug } from "../lib/db.server";
import { iconHref } from "../lib/trip-logo";

/**
 * The web app manifest for one trip's page.
 *
 * This is what turns "add to home screen" into an app tile with the journey's
 * name under it rather than the browser's guess at a title. iOS reads the
 * `apple-touch-icon` link instead of this file, so the two have to agree —
 * `t.$slug.tsx` writes both out of the same `iconHref`.
 *
 * `start_url` is the page itself, slug and all: the tile *is* the secret link,
 * which is the same bargain the shared URL already makes.
 */
export async function loader({ params }: Route.LoaderArgs) {
  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Not found", { status: 404 });

  const page = `/t/${params.slug}`;
  const manifest = {
    name: trip.name,
    short_name: trip.name.length > 24 ? `${trip.name.slice(0, 23)}…` : trip.name,
    start_url: page,
    scope: page,
    display: "standalone",
    background_color: "#fbfaf7",
    theme_color: "#fbfaf7",
    icons: [
      {
        src: iconHref(params.slug, 192, trip.name),
        sizes: "192x192",
        type: "image/png",
        // The tile is full-bleed with its letters in the middle, so it survives
        // being cropped to a circle — see `trip-logo.ts`.
        purpose: "any maskable",
      },
      {
        src: iconHref(params.slug, 512, trip.name),
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      // Same trade as the icon: the name is in the body, so it is only good
      // until a rename, and a phone re-reads it whenever it re-adds the page.
      "Cache-Control": "public, max-age=3600",
    },
  });
}

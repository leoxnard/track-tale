/**
 * Where to ask about the weather on a day that has no route.
 *
 * A rest day, a day the tracker stayed off, a day someone only sent pictures —
 * none of them have a line on the map, so `sampleSites` has nothing to walk and
 * the day card shows no temperature at all. But a photo out of a phone carries
 * a GPS fix and a capture time, which is exactly what the weather needs: a
 * place, and the day it happened.
 *
 * The obvious approach — feed the photo positions straight into `sampleSites`
 * as if they were a track — is wrong in a way that only shows up on a rest day.
 * That function measures distance *along the sequence* and spreads its sites
 * over the total, so a morning in town and one photo from a hilltop ten
 * kilometres away become a "route" whose middle is a field nobody visited.
 * Photos are places somebody stood, not a path between them, so each one is
 * kept or dropped on its own: keep it if it is somewhere we have not already
 * asked about, drop it if it is within the same weather grid cell as one we
 * have.
 *
 * The spacing and the ceiling are the route's, deliberately — the reasoning
 * behind both (the ~9 km grid the data really has, and the cost of storing a
 * day's hourly readings per site) is about the weather, not about how the
 * coordinates were come by.
 */

import { haversineM, type TrackPoint } from "./track";
import { MAX_SITES, SITE_SPACING_M } from "./wind";

/**
 * Which of a day's photo positions to ask the weather about.
 *
 * Ordered by capture time, and the photo nearest the middle of the day goes
 * first: the day's temperature, rain and icon are read off whichever site leads
 * the list, and a shot from the middle of the day answers "what was it like
 * there" better than breakfast or the last picture before bed.
 */
export function photoSites(spots: TrackPoint[]): TrackPoint[] {
  // Untimed photos sort to the end rather than to 1970, where they would claim
  // the middle of the day between them and drag the daily figures somewhere the
  // photographer may never have been that morning.
  const ordered = [...spots].sort(
    (a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER),
  );

  const kept: TrackPoint[] = [];
  for (const spot of ordered) {
    if (kept.every((site) => haversineM(site, spot) >= SITE_SPACING_M)) kept.push(spot);
  }
  if (kept.length === 0) return [];

  // A day of a hundred well-spread photos would otherwise be a hundred sets of
  // hourly readings stored on one row. Thin evenly across the day rather than
  // cutting the evening off.
  const sites =
    kept.length <= MAX_SITES
      ? kept
      : Array.from(
          { length: MAX_SITES },
          (_, i) => kept[Math.round((i * (kept.length - 1)) / (MAX_SITES - 1))],
        );

  const middle = Math.floor((sites.length - 1) / 2);
  return [sites[middle], ...sites.filter((_, i) => i !== middle)];
}

/**
 * Whether a set of sites has already been asked about.
 *
 * Every photo that lands adds a position, and re-fetching the whole day for
 * each one would mean a request per upload while somebody empties a camera
 * roll. A site inside the spacing of one already stored would have returned the
 * same numbers, so a day whose new photos are all near old ones needs nothing.
 */
export function sitesCovered(sites: TrackPoint[], cached: { lat: number; lng: number }[]): boolean {
  if (cached.length === 0) return false;
  return sites.every((site) => cached.some((c) => haversineM(c, site) < SITE_SPACING_M));
}

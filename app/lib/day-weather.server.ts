import { supabase } from "./supabase.server";
import { photoSites, sitesCovered } from "./photo-sites";
import type { TrackPoint } from "./track";
import { transitMode } from "./transport";
import { fetchDayWeather, type DayWeather } from "./weather";
import { sampleSites } from "./wind";

/**
 * Filling in `weather_cache` for a day, from whatever the day left behind.
 *
 * Two sources, in order of how much they know. A ridden track says where the
 * rider was hour by hour, so the weather can be asked about all along it. A day
 * without one is not necessarily a day nobody went anywhere: photos out of a
 * phone carry their own GPS fix, and that is enough for the temperature and the
 * icon on the day card, which is what a rest day was missing.
 *
 * Both live here rather than beside the uploads that trigger them because both
 * are reached from two directions — an upload, and `/refreshweather` going back
 * over a whole trip — and one of them is now reached from the photo path as
 * well, which the ingest module already depends on.
 */

/**
 * Cache a day's weather, taken along the route it covers.
 *
 * The temperature and the icon come from the middle of the day; the wind is
 * asked about at up to four places spread along it, because a long stage does
 * not have one wind. All of it is one request either way — Open-Meteo answers
 * for a list of coordinates at once.
 *
 * Returns whether anything was stored: callers on the upload path ignore it,
 * since weather is never worth failing an upload over.
 */
export async function cacheDayWeather(
  dayId: string,
  date: string,
  points: TrackPoint[],
): Promise<boolean> {
  if (points.length === 0) return false;
  return store(dayId, date, sampleSites(points));
}

/**
 * Cache a day's weather from where its photographs were taken.
 *
 * Only photos with the camera's own fix count (`location_source = 'exif'`) —
 * a position inferred from a track is no evidence of anything the track did not
 * already say, and on a day with a train leg through it, it would answer for
 * the middle of a railway line.
 *
 * A day that has a ridden track is left alone: that answer is better, and
 * overwriting it with one drawn from three photos would quietly cost the day
 * its wind rose. Transit-only days are fair game, since where a ferry went says
 * nothing about where the day was spent.
 *
 * `force` is what `/refreshweather` passes: without it, a day whose photos are
 * all near places already asked about is left as it is, so emptying a camera
 * roll onto one day does not mean a weather request per picture.
 */
export async function cacheDayWeatherFromPhotos(
  day: { id: string; date: string },
  { force = false }: { force?: boolean } = {},
): Promise<boolean> {
  const { data: segments } = await supabase()
    .from("track_segments")
    .select("sport")
    .eq("day_id", day.id);
  if ((segments ?? []).some((s) => transitMode(s.sport) === null)) return false;

  const { data: photos } = await supabase()
    .from("media")
    .select("matched_lat, matched_lng, taken_at, telegram_date")
    .eq("day_id", day.id)
    .eq("location_source", "exif");

  const spots: TrackPoint[] = (photos ?? [])
    .filter((p) => p.matched_lat !== null && p.matched_lng !== null)
    .map((p) => {
      const at = Date.parse(p.taken_at ?? p.telegram_date);
      return {
        lat: p.matched_lat as number,
        lng: p.matched_lng as number,
        time: Number.isNaN(at) ? undefined : at,
      };
    });
  const sites = photoSites(spots);
  if (sites.length === 0) return false;

  if (!force) {
    const { data: cached } = await supabase()
      .from("weather_cache")
      .select("data")
      .eq("day_id", day.id)
      .maybeSingle();
    const asked = (cached?.data as DayWeather | undefined)?.windSites ?? [];
    if (sitesCovered(sites, asked)) return false;
  }

  return store(day.id, day.date, sites);
}

async function store(dayId: string, date: string, sites: TrackPoint[]): Promise<boolean> {
  try {
    const weather = await fetchDayWeather(sites, date);
    if (!weather) return false;
    await supabase()
      .from("weather_cache")
      .upsert({ day_id: dayId, data: weather, fetched_at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

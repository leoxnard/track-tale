import { data, Link } from "react-router";
import type { Route } from "./+types/traveler.$slug";
import { supabase } from "../lib/supabase.server";

export async function loader({ params }: Route.LoaderArgs) {
  const db = supabase();

  const { data: user } = await db
    .from("users")
    .select("telegram_id, display_name")
    .eq("traveler_slug", params.slug)
    .maybeSingle();
  if (!user) throw data("Not found", { status: 404 });

  const { data: tripRows } = await db
    .from("trips")
    .select(
      "id, name, start_date, end_date, share_slug, og_path, days(day_number, track_segments(distance_m, elevation_up))",
    )
    .eq("owner_telegram_id", user.telegram_id)
    .order("start_date", { ascending: false });

  const storage = db.storage.from("photos");
  const trips = (tripRows ?? [])
    .map((t) => {
      const segments = t.days.flatMap(
        (d) => (d as { track_segments: { distance_m: number; elevation_up: number }[] }).track_segments,
      );
      return {
        name: t.name,
        slug: t.share_slug,
        startDate: t.start_date,
        endDate: t.end_date,
        km: segments.reduce((s, x) => s + x.distance_m, 0) / 1000,
        up: segments.reduce((s, x) => s + x.elevation_up, 0),
        days: t.days.filter(
          (d) => (d as { track_segments: unknown[] }).track_segments.length > 0,
        ).length,
        cardUrl: t.og_path ? storage.getPublicUrl(t.og_path).data.publicUrl : null,
      };
    })
    // A trip with nothing in it yet is noise on a page meant for looking back.
    .filter((t) => t.days > 0);

  return {
    name: user.display_name,
    trips,
    totalKm: trips.reduce((s, t) => s + t.km, 0),
    totalUp: trips.reduce((s, t) => s + t.up, 0),
    totalDays: trips.reduce((s, t) => s + t.days, 0),
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData ? `${loaderData.name} — TrackTale` : "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

function formatRange(start: string, end: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
  const s = new Date(start + "T00:00:00").toLocaleDateString("en-GB", opts);
  const e = new Date(end + "T00:00:00").toLocaleDateString("en-GB", opts);
  return `${s} – ${e}`;
}

export default function TravelerPage({ loaderData }: Route.ComponentProps) {
  const { name, trips, totalKm, totalUp, totalDays } = loaderData;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="border-b border-trail pb-6">
        <h1 className="font-display text-3xl font-semibold text-pine sm:text-4xl">
          {name}
          <span className="text-faint">’s journeys</span>
        </h1>
        {trips.length > 0 && (
          <p className="mt-2 text-faint">
            {totalKm.toFixed(0)} km · {Math.round(totalUp).toLocaleString("en-GB")} m climbed ·{" "}
            {totalDays} days on the road · {trips.length}{" "}
            {trips.length === 1 ? "trip" : "trips"}
          </p>
        )}
      </header>

      {trips.length === 0 ? (
        <p className="mt-10 text-faint">No trips to show yet — the first one is being planned.</p>
      ) : (
        <ul className="mt-8 grid gap-6 sm:grid-cols-2">
          {trips.map((trip) => (
            <li key={trip.slug}>
              <Link
                to={`/t/${trip.slug}`}
                className="group block overflow-hidden rounded-xl border border-trail transition hover:border-pine-soft"
              >
                {/* Crop off the card's caption band — the name and stats are
                    already below, and the route is what's worth showing. */}
                {trip.cardUrl ? (
                  <img
                    src={trip.cardUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-[1200/462] w-full bg-trail/40 object-cover object-top"
                  />
                ) : (
                  <div className="aspect-[1200/462] w-full bg-trail/40" />
                )}
                <div className="px-4 py-3">
                  <h2 className="font-display text-lg font-semibold text-pine group-hover:underline">
                    {trip.name}
                  </h2>
                  <p className="text-sm text-faint">{formatRange(trip.startDate, trip.endDate)}</p>
                  <p className="mt-1 text-sm">
                    {trip.km.toFixed(0)} km
                    <span className="text-faint">
                      {" "}
                      · ↑ {Math.round(trip.up)} m · {trip.days}{" "}
                      {trip.days === 1 ? "day" : "days"}
                    </span>
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <footer className="mt-16 border-t border-trail pt-4 text-xs text-faint">
        Followed with TrackTale — a private trip journal.
      </footer>
    </main>
  );
}

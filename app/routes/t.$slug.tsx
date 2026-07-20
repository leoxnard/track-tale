import { useEffect, useRef, useState } from "react";
import { data } from "react-router";
import type { Route } from "./+types/t.$slug";
import { getTripBySlug } from "../lib/db.server";
import { supabase } from "../lib/supabase.server";
import { fromGeoJson, type TrackGeoJson } from "../lib/track";
import { weatherIcon, type DayWeather } from "../lib/weather";
import "maplibre-gl/dist/maplibre-gl.css";

export interface ViewerPhoto {
  url: string;
  thumbUrl: string;
  caption: string | null;
  lat: number | null;
  lng: number | null;
  author: string | null;
}

export interface ViewerNote {
  text: string;
  author: string | null;
}

export interface ViewerDay {
  dayNumber: number;
  date: string;
  color: string;
  distanceM: number;
  elevationUp: number;
  movingS: number;
  sports: string[];
  tracks: TrackGeoJson[];
  photos: ViewerPhoto[];
  notes: ViewerNote[];
  weather: DayWeather | null;
}

export async function loader({ params }: Route.LoaderArgs) {
  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Trip not found", { status: 404 });

  const [{ data: dayRows }, { data: planRows }] = await Promise.all([
    supabase()
      .from("days")
      .select(
        "id, day_number, date, color, track_segments(geojson, distance_m, moving_s, elevation_up, sport, started_at), media(storage_path, thumb_path, caption, matched_lat, matched_lng, telegram_date, author_name), notes(text, created_at, author_name), weather_cache(data)",
      )
      .eq("trip_id", trip.id)
      .order("day_number"),
    supabase()
      .from("plan_segments")
      .select("geojson, distance_m, name, sort_order")
      .eq("trip_id", trip.id)
      .order("sort_order"),
  ]);

  const storage = supabase().storage.from("photos");
  const days: ViewerDay[] = (dayRows ?? [])
    .map((d) => {
      const segments = [...d.track_segments].sort(
        (a, b) => Date.parse(a.started_at ?? 0) - Date.parse(b.started_at ?? 0),
      );
      return {
        dayNumber: d.day_number,
        date: d.date,
        color: d.color,
        distanceM: segments.reduce((s, seg) => s + seg.distance_m, 0),
        elevationUp: segments.reduce((s, seg) => s + seg.elevation_up, 0),
        movingS: segments.reduce((s, seg) => s + seg.moving_s, 0),
        sports: [...new Set(segments.map((s) => s.sport).filter(Boolean))] as string[],
        tracks: segments.map((s) => s.geojson as TrackGeoJson),
        photos: [...d.media]
          .sort((a, b) => Date.parse(a.telegram_date) - Date.parse(b.telegram_date))
          .map((m) => ({
            url: storage.getPublicUrl(m.storage_path).data.publicUrl,
            thumbUrl: storage.getPublicUrl(m.thumb_path ?? m.storage_path).data.publicUrl,
            caption: m.caption,
            lat: m.matched_lat,
            lng: m.matched_lng,
            author: m.author_name,
          })),
        notes: [...d.notes]
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .map((n) => ({ text: n.text, author: n.author_name })),
        weather: (d.weather_cache as unknown as { data: DayWeather } | null)?.data ?? null,
      };
    })
    .filter((d) => d.tracks.length + d.photos.length + d.notes.length > 0);

  const plan = (planRows ?? []).map((p) => p.geojson as TrackGeoJson);
  const planKm = (planRows ?? []).reduce((s, p) => s + p.distance_m, 0) / 1000;
  const totalKm = days.reduce((s, d) => s + d.distanceM, 0) / 1000;
  const liveActive =
    trip.live_url !== null &&
    trip.live_expires_at !== null &&
    Date.parse(trip.live_expires_at) > Date.now();

  // Naming who wrote what only helps when several people did.
  const contributors = new Set<string>();
  for (const day of days) {
    for (const p of day.photos) if (p.author) contributors.add(p.author);
    for (const n of day.notes) if (n.author) contributors.add(n.author);
  }

  return {
    showAuthors: contributors.size > 1,
    name: trip.name,
    startDate: trip.start_date,
    endDate: trip.end_date,
    liveUrl: liveActive ? trip.live_url : null,
    days,
    plan,
    planKm,
    totalKm,
    totalUp: days.reduce((s, d) => s + d.elevationUp, 0),
    movingS: days.reduce((s, d) => s + d.movingS, 0),
  };
}

export function meta({ loaderData: trip }: Route.MetaArgs) {
  return [
    { title: trip ? `${trip.name} — TrackTale` : "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type MapHandle = { flyToDay: (dayNumber: number) => void };

function TripMap({
  days,
  plan,
  handleRef,
}: {
  days: ViewerDay[];
  plan: TrackGeoJson[];
  handleRef: React.MutableRefObject<MapHandle | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let map: import("maplibre-gl").Map | undefined;

    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (disposed || !containerRef.current) return;

      const allCoords = [
        ...plan.flatMap((p) => p.geometry.coordinates),
        ...days.flatMap((d) => d.tracks.flatMap((t) => t.geometry.coordinates)),
      ];
      if (allCoords.length === 0) return;

      const bounds = allCoords.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(allCoords[0] as [number, number], allCoords[0] as [number, number]),
      );

      map = new maplibregl.Map({
        container: containerRef.current,
        style: "https://tiles.openfreemap.org/styles/liberty",
        bounds,
        fitBoundsOptions: { padding: 48 },
        attributionControl: { compact: true },
        cooperativeGestures: true,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }));

      map.on("load", () => {
        if (!map) return;

        plan.forEach((segment, i) => {
          map!.addSource(`plan-${i}`, { type: "geojson", data: segment });
          map!.addLayer({
            id: `plan-${i}`,
            type: "line",
            source: `plan-${i}`,
            paint: { "line-color": "#9aa59e", "line-width": 3, "line-dasharray": [2, 2] },
            layout: { "line-cap": "round" },
          });
        });

        for (const day of days) {
          day.tracks.forEach((track, i) => {
            const id = `day-${day.dayNumber}-${i}`;
            map!.addSource(id, { type: "geojson", data: track });
            map!.addLayer({
              id,
              type: "line",
              source: id,
              paint: {
                "line-color": day.color,
                "line-width": 4,
              },
              layout: { "line-cap": "round", "line-join": "round" },
            });
          });

          for (const photo of day.photos) {
            if (photo.lat === null || photo.lng === null) continue;
            const el = document.createElement("a");
            el.href = photo.url;
            el.target = "_blank";
            el.rel = "noreferrer";
            el.title = photo.caption ?? "Photo";
            el.style.cssText = `display:block;width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);background:url(${JSON.stringify(photo.thumbUrl)}) center/cover;`;
            new maplibregl.Marker({ element: el }).setLngLat([photo.lng, photo.lat]).addTo(map!);
          }
        }
      });

      handleRef.current = {
        flyToDay(dayNumber) {
          const day = days.find((d) => d.dayNumber === dayNumber);
          if (!day || !map) return;
          const coords = day.tracks.flatMap((t) => t.geometry.coordinates);
          if (coords.length === 0) return;
          const b = coords.reduce(
            (acc, c) => acc.extend(c as [number, number]),
            new maplibregl.LngLatBounds(coords[0] as [number, number], coords[0] as [number, number]),
          );
          map.fitBounds(b, { padding: 64, duration: 900 });
        },
      };
    })();

    return () => {
      disposed = true;
      map?.remove();
      handleRef.current = null;
    };
  }, [days, plan, handleRef]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export interface ViewerTrip {
  name: string;
  startDate: string;
  endDate: string;
  liveUrl: string | null;
  showAuthors: boolean;
  days: ViewerDay[];
  plan: TrackGeoJson[];
  planKm: number;
  totalKm: number;
  totalUp: number;
  movingS: number;
}

export default function TripPage({ loaderData: trip }: Route.ComponentProps) {
  return <TripView trip={trip} />;
}

export function TripView({ trip }: { trip: ViewerTrip }) {
  const mapHandle = useRef<MapHandle | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const progressPct =
    trip.planKm > 0 ? Math.min(100, Math.round((trip.totalKm / trip.planKm) * 100)) : null;

  const scrollToDay = (dayNumber: number) => {
    mapHandle.current?.flyToDay(dayNumber);
    document.getElementById(`day-${dayNumber}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-trail bg-paper">
        <div className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-4">
          <h1 className="font-display text-2xl font-semibold text-pine sm:text-3xl">{trip.name}</h1>
          <p className="text-sm text-faint">
            {formatDate(trip.startDate)} – {formatDate(trip.endDate)}
          </p>
          {trip.liveUrl && (
            <a
              href={trip.liveUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-live px-4 py-1.5 text-sm font-bold text-white"
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute h-full w-full animate-ping rounded-full bg-white/70" />
                <span className="relative h-2.5 w-2.5 rounded-full bg-white" />
              </span>
              Live now — follow along
            </a>
          )}
        </div>
        {progressPct !== null && (
          <div className="mx-auto max-w-5xl px-4 pb-3">
            <div className="flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-trail">
                <div className="h-full rounded-full bg-pine-soft" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="shrink-0 text-xs text-faint">
                {trip.totalKm.toFixed(0)} of {trip.planKm.toFixed(0)} km · {progressPct}%
              </p>
            </div>
          </div>
        )}
      </header>

      <div className="h-[58vh] min-h-[320px] w-full bg-trail/40">
        {mounted && trip.days.length > 0 ? (
          <TripMap days={trip.days} plan={trip.plan} handleRef={mapHandle} />
        ) : (
          <div className="flex h-full items-center justify-center text-faint">
            {trip.days.length === 0 ? "The journey hasn't started yet — check back soon." : "Loading map…"}
          </div>
        )}
      </div>

      {/* Stage ribbon: legend + navigation in one */}
      {trip.days.length > 0 && (
        <nav className="sticky top-0 z-10 border-b border-trail bg-paper/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl gap-2 overflow-x-auto px-4 py-2">
            {trip.days.map((day) => (
              <button
                key={day.dayNumber}
                onClick={() => scrollToDay(day.dayNumber)}
                className="flex shrink-0 items-center gap-2 rounded-full border border-trail px-3 py-1 text-sm hover:border-pine-soft focus-visible:outline-2 focus-visible:outline-pine"
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: day.color }} />
                <span className="font-bold text-pine">Day {day.dayNumber}</span>
                {day.distanceM > 0 && (
                  <span className="text-faint">{(day.distanceM / 1000).toFixed(0)} km</span>
                )}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-5xl px-4 py-8">
        {trip.days.length > 0 && (
          <p className="mb-8 text-sm text-faint">
            {trip.totalKm.toFixed(1)} km · {Math.round(trip.totalUp)} m climbed ·{" "}
            {formatHours(trip.movingS)} in motion · {trip.days.length}{" "}
            {trip.days.length === 1 ? "day" : "days"} so far
          </p>
        )}

        <div className="space-y-10">
          {trip.days.map((day) => {
            const w = day.weather;
            const wi = weatherIcon(w?.weatherCode ?? null);
            return (
              <article
                key={day.dayNumber}
                id={`day-${day.dayNumber}`}
                className="scroll-mt-16 border-l-4 pl-4 sm:pl-6"
                style={{ borderColor: day.color }}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h2 className="font-display text-xl font-semibold text-pine">
                    Day {day.dayNumber}
                  </h2>
                  <p className="text-sm text-faint">{formatDate(day.date)}</p>
                  {w && (
                    <p className="text-sm text-faint" title={wi.label}>
                      {wi.icon} {w.tempMinC !== null && `${Math.round(w.tempMinC)}–`}
                      {w.tempMaxC !== null && `${Math.round(w.tempMaxC)}°C`}
                      {w.precipitationMm !== null && w.precipitationMm > 0.5 && (
                        <> · 💧 {w.precipitationMm.toFixed(0)} mm</>
                      )}
                    </p>
                  )}
                </div>

                {day.distanceM > 0 && (
                  <p className="mt-1 text-sm">
                    <strong>{(day.distanceM / 1000).toFixed(1)} km</strong>
                    <span className="text-faint">
                      {" "}· ↑ {Math.round(day.elevationUp)} m · {formatHours(day.movingS)} moving
                      {day.tracks.length > 1 && ` · ${day.tracks.length} segments`}
                    </span>
                  </p>
                )}

                {day.notes.map((note, i) => (
                  <p key={i} className="mt-3 max-w-prose whitespace-pre-wrap leading-relaxed">
                    {note.text}
                    {trip.showAuthors && note.author && (
                      <span className="text-faint"> — {note.author}</span>
                    )}
                  </p>
                ))}

                {day.photos.length > 0 && (
                  <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {day.photos.map((photo, i) => (
                      <a
                        key={i}
                        href={photo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="group relative block overflow-hidden rounded-lg bg-trail/50"
                      >
                        <img
                          src={photo.thumbUrl}
                          alt={photo.caption ?? `Day ${day.dayNumber} photo`}
                          loading="lazy"
                          className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        />
                        {(photo.caption || (trip.showAuthors && photo.author)) && (
                          <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-6 text-xs text-white">
                            {photo.caption}
                            {trip.showAuthors && photo.author && (
                              <span className="opacity-75">
                                {photo.caption ? " — " : ""}
                                {photo.author}
                              </span>
                            )}
                          </span>
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <footer className="mt-16 border-t border-trail pt-4 text-xs text-faint">
          Followed with TrackTale — a private trip journal.
        </footer>
      </main>
    </div>
  );
}

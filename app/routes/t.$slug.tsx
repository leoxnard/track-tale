import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/t.$slug";
import { getTripBySlug } from "../lib/db.server";
import { postComment } from "../lib/comments.server";
import { supabase } from "../lib/supabase.server";
import { buildProfile, fromGeoJson, type ProfilePoint, type TrackGeoJson } from "../lib/track";
import { weatherIcon, type DayWeather } from "../lib/weather";
import { ElevationProfile } from "../components/ElevationProfile";
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

export interface ViewerComment {
  author: string;
  text: string;
  at: string;
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
  profile: ProfilePoint[];
  photos: ViewerPhoto[];
  notes: ViewerNote[];
  comments: ViewerComment[];
  weather: DayWeather | null;
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const result = await postComment({
    slug: params.slug,
    dayNumber: Number(form.get("dayNumber")),
    authorName: String(form.get("authorName") ?? ""),
    text: String(form.get("text") ?? ""),
  });
  return result.ok
    ? { ok: true as const, error: null, dayNumber: Number(form.get("dayNumber")) }
    : { ok: false as const, error: result.error, dayNumber: Number(form.get("dayNumber")) };
}

export async function loader({ params }: Route.LoaderArgs) {
  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Trip not found", { status: 404 });

  const [{ data: dayRows }, { data: planRows }] = await Promise.all([
    supabase()
      .from("days")
      .select(
        "id, day_number, date, color, track_segments(geojson, distance_m, moving_s, elevation_up, sport, started_at), media(storage_path, thumb_path, caption, matched_lat, matched_lng, telegram_date, author_name), notes(text, created_at, author_name), comments(author_name, text, created_at), weather_cache(data)",
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
        // Segments of a split day read as one continuous climb.
        profile: buildProfile(
          segments.flatMap((s) => fromGeoJson(s.geojson as TrackGeoJson)),
        ),
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
        comments: [...d.comments]
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
          .map((c) => ({
            author: c.author_name,
            text: c.text,
            at: new Date(c.created_at).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "short",
            }),
          })),
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
    ogUrl: trip.og_path
      ? `${storage.getPublicUrl(trip.og_path).data.publicUrl}?v=${Date.parse(trip.og_updated_at ?? "") || 0}`
      : null,
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
  if (!trip) return [{ title: "TrackTale" }, { name: "robots", content: "noindex, nofollow" }];

  const summary = [
    `${trip.totalKm.toFixed(0)} km`,
    `${Math.round(trip.totalUp)} m climbed`,
    `${trip.days.length} ${trip.days.length === 1 ? "day" : "days"}`,
  ].join(" · ");

  return [
    { title: `${trip.name} — TrackTale` },
    { name: "robots", content: "noindex, nofollow" },
    { name: "description", content: summary },
    { property: "og:type", content: "website" },
    { property: "og:title", content: trip.name },
    { property: "og:description", content: summary },
    ...(trip.ogUrl
      ? [
          { property: "og:image", content: trip.ogUrl },
          { property: "og:image:width", content: "1200" },
          { property: "og:image:height", content: "630" },
          { name: "twitter:card", content: "summary_large_image" },
        ]
      : []),
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

type MapHandle = {
  flyToDay: (dayNumber: number) => void;
  showScrub: (lngLat: [number, number] | null, color: string) => void;
};

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

      // One reusable marker follows the elevation chart as it's scrubbed.
      const scrubEl = document.createElement("div");
      scrubEl.style.cssText =
        "width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);transition:background .15s";
      const scrubMarker = new maplibregl.Marker({ element: scrubEl });
      let scrubAttached = false;

      handleRef.current = {
        showScrub(lngLat, color) {
          if (!map) return;
          if (!lngLat) {
            if (scrubAttached) {
              scrubMarker.remove();
              scrubAttached = false;
            }
            return;
          }
          scrubEl.style.background = color;
          scrubMarker.setLngLat(lngLat);
          if (!scrubAttached) {
            scrubMarker.addTo(map);
            scrubAttached = true;
          }
        },
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
  ogUrl: string | null;
  days: ViewerDay[];
  plan: TrackGeoJson[];
  planKm: number;
  totalKm: number;
  totalUp: number;
  movingS: number;
}

interface CommentResult {
  ok: boolean;
  error: string | null;
  dayNumber: number;
}

function DayGuestbook({
  dayNumber,
  comments,
  color,
  result,
}: {
  dayNumber: number;
  comments: ViewerComment[];
  color: string;
  result?: CommentResult;
}) {
  const navigation = useNavigation();
  const sending =
    navigation.state === "submitting" &&
    Number(navigation.formData?.get("dayNumber")) === dayNumber;
  const [open, setOpen] = useState(false);
  const showForm = open || comments.length > 0 || result !== undefined;

  return (
    <section className="mt-5">
      {comments.length > 0 && (
        <ul className="mb-3 space-y-2">
          {comments.map((c, i) => (
            <li key={i} className="rounded-lg bg-trail/30 px-3 py-2 text-sm">
              <span className="font-bold" style={{ color }}>
                {c.author}
              </span>
              <span className="text-faint"> · {c.at}</span>
              <p className="mt-0.5 whitespace-pre-wrap">{c.text}</p>
            </li>
          ))}
        </ul>
      )}

      {showForm ? (
        <Form method="post" className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <input type="hidden" name="dayNumber" value={dayNumber} />
          <input
            name="authorName"
            required
            maxLength={40}
            placeholder="Your name"
            aria-label={`Your name, day ${dayNumber}`}
            className="rounded-lg border border-trail bg-paper px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-pine sm:w-40"
          />
          <input
            name="text"
            required
            maxLength={800}
            placeholder={`Say something about day ${dayNumber}…`}
            aria-label={`Message for day ${dayNumber}`}
            className="flex-1 rounded-lg border border-trail bg-paper px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-pine"
          />
          <button
            type="submit"
            disabled={sending}
            className="rounded-lg bg-pine px-4 py-2 text-sm font-bold text-paper disabled:opacity-60"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </Form>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="text-sm text-faint underline underline-offset-2 hover:text-pine"
        >
          Leave a message for day {dayNumber}
        </button>
      )}

      {result?.error && <p className="mt-2 text-sm text-live">{result.error}</p>}
      {result?.ok && <p className="mt-2 text-sm text-pine-soft">Sent — they'll see it on the road.</p>}
    </section>
  );
}

export default function TripPage({ loaderData: trip, actionData }: Route.ComponentProps) {
  return <TripView trip={trip} actionData={actionData} />;
}

export function TripView({
  trip,
  actionData,
}: {
  trip: ViewerTrip;
  actionData?: CommentResult;
}) {
  const mapHandle = useRef<MapHandle | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const progressPct =
    trip.planKm > 0 ? Math.min(100, Math.round((trip.totalKm / trip.planKm) * 100)) : null;

  // Every day's chart is drawn to the same metres-per-pixel, so a hard stage
  // visibly towers over an easy one instead of each filling its own box.
  const elevationSpan = useMemo(() => {
    const ranges = trip.days
      .filter((d) => d.profile.length > 1)
      .map((d) => {
        const es = d.profile.map((p) => p.e);
        return Math.max(...es) - Math.min(...es);
      });
    return Math.max(20, ...ranges);
  }, [trip.days]);

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

      {/* Map stays pinned so scrubbing a day's elevation chart is visible on it. */}
      <div className="sticky top-0 z-10 bg-paper">
        <div className="h-[42vh] min-h-[240px] w-full bg-trail/40 sm:h-[48vh]">
          {mounted && trip.days.length > 0 ? (
            <TripMap days={trip.days} plan={trip.plan} handleRef={mapHandle} />
          ) : (
            <div className="flex h-full items-center justify-center text-faint">
              {trip.days.length === 0
                ? "The journey hasn't started yet — check back soon."
                : "Loading map…"}
            </div>
          )}
        </div>

        {/* Stage ribbon: legend + navigation in one */}
        {trip.days.length > 0 && (
          <nav className="border-b border-trail bg-paper/95 backdrop-blur">
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
      </div>

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
                className="scroll-mt-[calc(42vh+3rem)] border-l-4 pl-4 sm:scroll-mt-[calc(48vh+3rem)] sm:pl-6"
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

                {day.profile.length > 1 && (
                  <ElevationProfile
                    profile={day.profile}
                    color={day.color}
                    span={elevationSpan}
                    onScrub={(p) => mapHandle.current?.showScrub([p.lng, p.lat], day.color)}
                  />
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
                <DayGuestbook
                  dayNumber={day.dayNumber}
                  comments={day.comments}
                  color={day.color}
                  result={actionData?.dayNumber === day.dayNumber ? actionData : undefined}
                />
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

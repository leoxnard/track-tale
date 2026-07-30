import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, useNavigation } from "react-router";
import type { Route } from "./+types/t.$slug";

const RECENT_TRIPS_KEY = "tt_recent_trips";
const MAX_RECENT_TRIPS = 5;

function saveRecentTrip(slug: string, name: string) {
  if (typeof window === "undefined") return;
  try {
    const stored = localStorage.getItem(RECENT_TRIPS_KEY);
    const trips: { slug: string; name: string; url: string; visitedAt: number }[] = stored ? JSON.parse(stored) : [];
    const filtered = trips.filter((t) => t.slug !== slug);
    filtered.unshift({ slug, name, url: `/t/${slug}`, visitedAt: Date.now() });
    localStorage.setItem(RECENT_TRIPS_KEY, JSON.stringify(filtered.slice(0, MAX_RECENT_TRIPS)));
  } catch {
    // ignore localStorage errors
  }
}
import { getTripBySlug, updateTrip } from "../lib/db.server";
import { postComment } from "../lib/comments.server";
import { supabase } from "../lib/supabase.server";
import { buildProfile, fromGeoJson, type ProfilePoint, type TrackGeoJson } from "../lib/track";
import { weatherIcon, type DayWeather } from "../lib/weather";
import { fetchLiveSession } from "../lib/livetrack.server";
import { isSettled } from "../lib/livetrack";
import { ElevationProfile } from "../components/ElevationProfile";
import { TourProfile } from "../components/TourProfile";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  formatDayDate,
  formatDuration,
  formatShortDate,
  messages,
  resolveLocale,
  type Messages,
} from "../lib/i18n";
import { useLocale, useMessages } from "../lib/locale";
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
    locale: resolveLocale(request),
  });
  return result.ok
    ? { ok: true as const, error: null, dayNumber: Number(form.get("dayNumber")) }
    : { ok: false as const, error: result.error, dayNumber: Number(form.get("dayNumber")) };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolveLocale(request);
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
            at: formatShortDate(c.created_at, locale),
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

  // Read straight off Garmin at render time — no polling, no extra cron, and if
  // it fails the page is exactly what it was before.
  const session = liveActive ? await fetchLiveSession(trip.live_url!) : null;
  // Garmin's own page says "Session Complete" once the ride is over. Take the
  // banner and the live overlay down with it rather than waiting out the 24h
  // expiry, so nothing on the page claims to be live when it isn't.
  const live = session?.complete ? null : session;
  const showLive = liveActive && !session?.complete;

  // A ride starts by push — Garmin emails the link — but only fetching this
  // page reveals that it ended. So a link left to run out its 24 hours costs
  // every single visitor a request to Garmin for a session that finished hours
  // ago. Once the session is settled the link has nothing left to tell us, so
  // retire it and the fetch above stops happening at all. Awaited rather than
  // fired and forgotten: it is one small write that only ever runs once, and a
  // serverless function can be killed before background work finishes.
  if (session && isSettled(session)) {
    try {
      await updateTrip(trip.id, { live_url: null, live_expires_at: null });
    } catch (err) {
      // Purely an optimisation — the page is already correct without it.
      console.error("could not retire the finished live link", err);
    }
  }

  // Naming who wrote what only helps when several people did.
  const contributors = new Set<string>();
  for (const day of days) {
    for (const p of day.photos) if (p.author) contributors.add(p.author);
    for (const n of day.notes) if (n.author) contributors.add(n.author);
  }

  return {
    locale,
    showAuthors: contributors.size > 1,
    ogUrl: trip.og_path
      ? `${storage.getPublicUrl(trip.og_path).data.publicUrl}?v=${Date.parse(trip.og_updated_at ?? "") || 0}`
      : null,
    name: trip.name,
    startDate: trip.start_date,
    endDate: trip.end_date,
    finished: trip.finished_at !== null,
    liveUrl: showLive ? trip.live_url : null,
    // A session with no points yet is a valid read with nothing to draw.
    live: live === null || live.points.length === 0 ? null : {
      coords: live.points.map((p) => [p.lng, p.lat] as [number, number]),
      current: live.current ? ([live.current.lng, live.current.lat] as [number, number]) : null,
      distanceM: live.distanceM,
      durationS: live.durationS,
      updatedAt: live.updatedAt,
      moving: live.current?.moving ?? false,
    },
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

  const m = messages(trip.locale);
  const summary = [
    `${trip.totalKm.toFixed(0)} km`,
    m.trip.climbed(String(Math.round(trip.totalUp))),
    m.trip.days(trip.days.length),
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

type MapHandle = {
  flyToDay: (dayNumber: number) => void;
  /** Zoom back out to the whole journey, plan included. */
  resetView: () => void;
  /** Close in on the live position, which is a speck at whole-tour zoom. */
  flyToLive: () => void;
  showScrub: (lngLat: [number, number] | null, color: string) => void;
};

function TripMap({
  days,
  plan,
  live,
  handleRef,
  m,
}: {
  days: ViewerDay[];
  plan: TrackGeoJson[];
  live?: ViewerLive | null;
  handleRef: React.MutableRefObject<MapHandle | null>;
  m: Messages;
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
        ...(live?.coords ?? []),
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
            el.title = photo.caption ?? m.trip.photo;
            el.style.cssText = `display:block;width:26px;height:26px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);background:url(${JSON.stringify(photo.thumbUrl)}) center/cover;`;
            new maplibregl.Marker({ element: el }).setLngLat([photo.lng, photo.lat]).addTo(map!);
          }
        }

        // Today's ride, straight from Garmin: drawn on top of the finished days
        // because it is the bit anyone opening the page right now cares about.
        if (live && live.coords.length > 1) {
          map.addSource("live-track", {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: live.coords },
            },
          });
          map.addLayer({
            id: "live-track",
            type: "line",
            source: "live-track",
            paint: { "line-color": "#d64533", "line-width": 4, "line-dasharray": [3, 1.5] },
            layout: { "line-cap": "round", "line-join": "round" },
          });
        }
        if (live?.current) {
          const el = document.createElement("div");
          el.title = m.trip.livePosition;
          el.style.cssText =
            "width:18px;height:18px;border-radius:50%;background:#d64533;border:3px solid #fff;box-shadow:0 0 0 rgba(214,69,51,.7);animation:tt-pulse 2s infinite";
          new maplibregl.Marker({ element: el }).setLngLat(live.current).addTo(map);
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
        resetView() {
          map?.fitBounds(bounds, { padding: 48, duration: 900 });
        },
        flyToLive() {
          if (!map || !live?.current) return;
          map.flyTo({ center: live.current, zoom: 13, duration: 1200 });
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
  }, [days, plan, live, handleRef, m]);

  return <div ref={containerRef} className="h-full w-full" />;
}

export interface ViewerLive {
  /** Today's session so far, as [lng, lat] pairs. */
  coords: [number, number][];
  current: [number, number] | null;
  distanceM: number;
  durationS: number;
  updatedAt: string | null;
  moving: boolean;
}

export interface ViewerTrip {
  name: string;
  startDate: string;
  endDate: string | null;
  finished: boolean;
  liveUrl: string | null;
  live?: ViewerLive | null;
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
  const m = useMessages();
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
            placeholder={m.guestbook.yourName}
            aria-label={m.guestbook.yourNameFor(dayNumber)}
            className="rounded-lg border border-trail bg-paper px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-pine sm:w-40"
          />
          <input
            name="text"
            required
            maxLength={800}
            placeholder={m.guestbook.messagePlaceholder(dayNumber)}
            aria-label={m.guestbook.messageFor(dayNumber)}
            className="flex-1 rounded-lg border border-trail bg-paper px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-pine"
          />
          <button
            type="submit"
            disabled={sending}
            className="rounded-lg bg-pine px-4 py-2 text-sm font-bold text-paper disabled:opacity-60"
          >
            {sending ? m.guestbook.sending : m.guestbook.send}
          </button>
        </Form>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="text-sm text-faint underline underline-offset-2 hover:text-pine"
        >
          {m.guestbook.leaveMessage(dayNumber)}
        </button>
      )}

      {result?.error && <p className="mt-2 text-sm text-live">{result.error}</p>}
      {result?.ok && <p className="mt-2 text-sm text-pine-soft">{m.guestbook.sent}</p>}
    </section>
  );
}

export default function TripPage({ loaderData: trip, params, actionData }: Route.ComponentProps) {
  useEffect(() => {
    saveRecentTrip(params.slug, trip.name);
  }, [params.slug, trip.name]);
  return <TripView trip={trip} actionData={actionData} />;
}

export function TripView({
  trip,
  actionData,
}: {
  trip: ViewerTrip;
  actionData?: CommentResult;
}) {
  const locale = useLocale();
  const m = useMessages();
  const formatDate = (iso: string) => formatDayDate(iso, locale);
  const formatHours = (seconds: number) => formatDuration(seconds, locale);

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
      {/* iOS runs the page under the notch/Dynamic Island (viewport-fit=cover).
          The sticky map below sits at the very top once pinned, and Safari's
          sticky-element repaint glitch (see .map-shell) is most visible in
          that strip — this covers it with the same paper background so
          nothing stale from further down the page ever shows through there. */}
      <div className="safe-area-blocker fixed inset-x-0 top-0 z-20 bg-paper" />

      <header className="border-b border-trail bg-paper">
        <div className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-4">
          <h1 className="font-display text-2xl font-semibold text-pine sm:text-3xl">{trip.name}</h1>
          <p className="text-sm text-faint">
            {trip.endDate
              ? `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)}`
              : m.trip.since(formatDate(trip.startDate))}
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
              {trip.live
                ? m.trip.live(
                    (trip.live.distanceM / 1000).toFixed(1),
                    trip.live.durationS > 0 ? formatHours(trip.live.durationS) : null,
                  )
                : m.trip.liveFollow}
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
                {m.trip.progress(trip.totalKm.toFixed(0), trip.planKm.toFixed(0), progressPct)}
              </p>
            </div>
          </div>
        )}
      </header>

      {/* Map stays pinned so scrubbing a day's elevation chart is visible on it. */}
      <div className="map-shell sticky top-0 z-10 bg-paper">
        {/* dvh, not vh: mobile Safari resolves vh against the viewport with the
            toolbars hidden, which made the map overhang the visible area. */}
        <div className="h-[38dvh] min-h-[200px] w-full bg-trail/40 sm:h-[48dvh]">
          {mounted && trip.days.length > 0 ? (
            <TripMap
              days={trip.days}
              plan={trip.plan}
              live={trip.live}
              handleRef={mapHandle}
              m={m}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-faint">
              {trip.days.length === 0 ? m.trip.notStarted : m.trip.loadingMap}
            </div>
          )}
        </div>

        {/* Stage ribbon: legend + navigation in one. Opaque rather than
            translucent — a backdrop-filter inside a sticky element makes Safari
            composite the map canvas through it. */}
        {trip.days.length > 0 && (
          <nav className="border-b border-trail bg-paper">
            <div className="mx-auto flex max-w-5xl flex-wrap gap-2 px-4 py-2">
              <button
                onClick={() => {
                  mapHandle.current?.resetView();
                  document
                    .getElementById("tour-profile")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-trail px-3 py-1 text-sm font-bold text-pine hover:border-pine-soft focus-visible:outline-2 focus-visible:outline-pine"
                title={m.trip.wholeTourHint}
              >
                <span aria-hidden>⤢</span> {m.trip.wholeTour}
              </button>
              {trip.live?.current && (
                <button
                  onClick={() => mapHandle.current?.flyToLive()}
                  className="flex shrink-0 items-center gap-2 rounded-full border border-live px-3 py-1 text-sm font-bold text-live hover:bg-live/10 focus-visible:outline-2 focus-visible:outline-live"
                  title={m.trip.liveNowHint}
                >
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute h-full w-full animate-ping rounded-full bg-live/70" />
                    <span className="relative h-2.5 w-2.5 rounded-full bg-live" />
                  </span>
                  {m.trip.liveNow}
                </button>
              )}
              {/* A long tour wraps to several rows, so on a phone each day is
                  cut back to its colour and number — enough to pick one out,
                  and small enough that a fortnight still fits in two rows. */}
              {trip.days.map((day) => (
                <button
                  key={day.dayNumber}
                  onClick={() => scrollToDay(day.dayNumber)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-trail px-2.5 py-1 text-sm hover:border-pine-soft focus-visible:outline-2 focus-visible:outline-pine sm:gap-2 sm:px-3"
                  title={m.trip.day(day.dayNumber)}
                >
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: day.color }} />
                  <span className="font-bold text-pine">
                    <span className="hidden sm:inline">{m.trip.dayPrefix}</span>
                    {day.dayNumber}
                  </span>
                  {day.distanceM > 0 && (
                    <span className="hidden text-faint sm:inline">
                      {(day.distanceM / 1000).toFixed(0)} km
                    </span>
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
            {trip.totalKm.toFixed(1)} km · {m.trip.climbed(String(Math.round(trip.totalUp)))} ·{" "}
            {m.trip.inMotion(formatHours(trip.movingS))} · {m.trip.days(trip.days.length)}
            {!trip.finished && m.trip.soFar}
          </p>
        )}

        {trip.days.length > 0 && (
          <div className="mb-10">
            <TourProfile
              plan={trip.plan}
              planKm={trip.planKm}
              days={trip.days}
              onScrub={(p, color) => mapHandle.current?.showScrub([p.lng, p.lat], color)}
              onScrubEnd={() => mapHandle.current?.showScrub(null, "")}
              onSelectDay={scrollToDay}
            />
          </div>
        )}

        <div className="space-y-10">
          {trip.days.map((day) => {
            const w = day.weather;
            const wi = weatherIcon(w?.weatherCode ?? null, locale);
            return (
              <article
                key={day.dayNumber}
                id={`day-${day.dayNumber}`}
                className="scroll-mt-[calc(38dvh+3.5rem)] border-l-4 pl-4 sm:scroll-mt-[calc(48dvh+3.5rem)] sm:pl-6"
                style={{ borderColor: day.color }}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <button
                    type="button"
                    onClick={() => mapHandle.current?.flyToDay(day.dayNumber)}
                    className="font-display text-xl font-semibold text-pine hover:underline focus-visible:outline-2 focus-visible:outline-pine"
                    title={m.trip.focusDay}
                  >
                    {m.trip.day(day.dayNumber)}
                  </button>
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
                      {" "}· ↑ {Math.round(day.elevationUp)} m ·{" "}
                      {m.trip.moving(formatHours(day.movingS))}
                      {day.tracks.length > 1 && ` · ${m.trip.segments(day.tracks.length)}`}
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
                          alt={photo.caption ?? m.trip.photoAlt(day.dayNumber)}
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

        <footer className="mt-16 flex flex-wrap items-center justify-between gap-2 border-t border-trail pt-4 text-xs text-faint">
          <span>{m.footer}</span>
          <LanguageSwitcher />
        </footer>
      </main>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  buildProfile,
  fromGeoJson,
  groupContinuous,
  haversineM,
  type TrackGeoJson,
  type TrackPoint,
} from "../lib/track";
import type { TourPiece } from "../lib/tour-layout";
import { transitMode, type TransitMode } from "../lib/transport";
import { weatherIcon, type DayWeather } from "../lib/weather";
import { byPhotoTime } from "../lib/photo-order";
import { env } from "../lib/env.server";
import { fetchLiveSession } from "../lib/livetrack.server";
import { isSettled } from "../lib/livetrack";
import { ElevationProfile } from "../components/ElevationProfile";
import { TourProfile } from "../components/TourProfile";
import { PhotoLightbox, type LightboxPhoto } from "../components/PhotoLightbox";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import {
  formatDayDate,
  formatDuration,
  formatShortDate,
  messages,
  resolveLocale,
  type Messages,
} from "../lib/i18n";
import { BADGE_PX, drawVehicleBadge } from "../lib/vehicle-canvas";
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

/** A drawn line plus how it was travelled — null for anything under own power. */
export interface ViewerTrack {
  geojson: TrackGeoJson;
  mode: TransitMode | null;
}

export interface ViewerDay {
  dayNumber: number;
  date: string;
  color: string;
  /** Ridden only. A train leg is on the map but not in the day's distance. */
  distanceM: number;
  elevationUp: number;
  movingS: number;
  /** Kilometres covered by train, ferry or bus, kept apart from the ridden ones. */
  transitM: number;
  transitModes: TransitMode[];
  sports: string[];
  tracks: ViewerTrack[];
  /**
   * The day's riding, in stretches ridden without a break. One for most days;
   * a day interrupted by a train is several, and nothing joins them up.
   */
  pieces: TourPiece[];
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

/**
 * How far a station may be from where the riding stopped and still be the
 * reason it stopped. Generous: the last kilometre to the platform is often not
 * recorded, and being wrong here only costs the gap its little icon.
 */
const BRIDGE_NEAR_M = 5000;

/**
 * Which travelled leg accounts for the gap between two stretches of riding.
 *
 * Matched on where the leg begins and ends rather than on when it was: a GPX
 * built from a timetable-less railway line carries no clock at all, and the
 * geometry is the part that cannot be missing.
 */
function bridgingMode(
  legs: { mode: TransitMode; points: TrackPoint[] }[],
  from: TrackPoint,
  to: TrackPoint,
): TransitMode | null {
  for (const leg of legs) {
    const head = leg.points[0];
    const tail = leg.points[leg.points.length - 1];
    if (!head || !tail) continue;
    const forwards =
      haversineM(head, from) <= BRIDGE_NEAR_M && haversineM(tail, to) <= BRIDGE_NEAR_M;
    const backwards =
      haversineM(tail, from) <= BRIDGE_NEAR_M && haversineM(head, to) <= BRIDGE_NEAR_M;
    if (forwards || backwards) return leg.mode;
  }
  return null;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolveLocale(request);
  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Trip not found", { status: 404 });

  const [{ data: dayRows }, { data: planRows }] = await Promise.all([
    supabase()
      .from("days")
      .select(
        "id, day_number, date, color, track_segments(geojson, distance_m, moving_s, elevation_up, sport, started_at), media(storage_path, thumb_path, caption, matched_lat, matched_lng, telegram_date, taken_at, created_at, author_name), notes(text, created_at, author_name), comments(author_name, text, created_at), weather_cache(data)",
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
      // A train or ferry leg is drawn with the day but adds up separately: it
      // is not distance the traveller made, and its "climb" is the line's, not
      // theirs.
      const ridden = segments.filter((s) => transitMode(s.sport) === null);
      const transit = segments.filter((s) => transitMode(s.sport) !== null);
      // Segments of a split day read as one continuous climb — but only where
      // the day actually continued. Ride to Aberdeen, train to Forres, ride
      // on, and those are two stretches with 133 km between them that were
      // never pedalled.
      const riddenPoints = ridden.map((s) => fromGeoJson(s.geojson as TrackGeoJson));
      const transitLegs = transit.map((s) => ({
        mode: transitMode(s.sport)!,
        points: fromGeoJson(s.geojson as TrackGeoJson),
      }));
      const groups = groupContinuous(riddenPoints);
      const pieces = groups.map((group, gi) => {
        const previous = groups[gi - 1];
        return {
          distanceM: group.reduce((sum, i) => sum + ridden[i].distance_m, 0),
          profile: buildProfile(group.flatMap((i) => riddenPoints[i])),
          after: previous
            ? bridgingMode(
                transitLegs,
                riddenPoints[previous[previous.length - 1]].at(-1)!,
                riddenPoints[group[0]][0],
              )
            : null,
        };
      });
      return {
        dayNumber: d.day_number,
        date: d.date,
        color: d.color,
        distanceM: ridden.reduce((s, seg) => s + seg.distance_m, 0),
        elevationUp: ridden.reduce((s, seg) => s + seg.elevation_up, 0),
        movingS: ridden.reduce((s, seg) => s + seg.moving_s, 0),
        transitM: transit.reduce((s, seg) => s + seg.distance_m, 0),
        transitModes: [...new Set(transit.map((s) => transitMode(s.sport)!))],
        sports: [...new Set(ridden.map((s) => s.sport).filter(Boolean))] as string[],
        tracks: segments.map((s) => ({
          geojson: s.geojson as TrackGeoJson,
          mode: transitMode(s.sport),
        })),
        pieces,
        photos: [...d.media]
          .sort(byPhotoTime)
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
  // With live tracking switched off the page never talks to Garmin, which is
  // one fewer third-party round trip in front of the map.
  const liveActive =
    env.liveTracking &&
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
    transitKm: days.reduce((s, d) => s + d.transitM, 0) / 1000,
    transitModes: [...new Set(days.flatMap((d) => d.transitModes))],
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

/**
 * Photo markers are thumbnails up close and plain dots once the map is pulled
 * back — at whole-trip zoom a day's photos sit on top of each other and the
 * route disappears under them, so past a point the useful thing is *where* the
 * photos are, not what they show.
 *
 * The switch is on real-world scale rather than a zoom number, because a zoom
 * level covers a very different distance in Scotland than at the equator.
 */
const PHOTO_DOT_ABOVE_M_PER_CM = 10_000;
/** Metres per CSS pixel at zoom 0, for MapLibre's 512 px tiles. */
const METERS_PER_PIXEL_Z0 = 40_075_016.686 / 512;
const CSS_PX_PER_CM = 96 / 2.54;

function metersPerCm(map: import("maplibre-gl").Map): number {
  const atEquator = METERS_PER_PIXEL_Z0 / 2 ** map.getZoom();
  const metersPerPixel = atEquator * Math.cos((map.getCenter().lat * Math.PI) / 180);
  return metersPerPixel * CSS_PX_PER_CM;
}

const SHARED_MARKER_STYLE =
  "display:block;border-radius:50%;box-sizing:border-box;transition:width .15s,height .15s,border-width .15s";

const photoThumbStyle = (thumbUrl: string) =>
  `${SHARED_MARKER_STYLE};width:26px;height:26px;border:2px solid #fff;` +
  `box-shadow:0 1px 4px rgba(0,0,0,.4);background:url(${JSON.stringify(thumbUrl)}) center/cover`;

/** The collapsed state: a dot in the day's own colour, so it still reads as
 * belonging to that leg of the route. */
const photoDotStyle = (color: string) =>
  `${SHARED_MARKER_STYLE};width:10px;height:10px;border:2px solid #fff;` +
  `box-shadow:0 1px 3px rgba(0,0,0,.35);background:${color}`;

/**
 * The locomotive the tour profile draws, on a canvas the map can repeat along
 * a line — MapLibre puts images on a line, not components.
 *
 * A disc of the page's own paper, ringed in the day's colour, so it sits in
 * the hatched railway rather than on top of it. Just the engine: the line
 * underneath already reads as a railway, and a train long enough to mean
 * anything would have to be redrawn at every zoom.
 */
function ensureVehicleBadge(
  map: import("maplibre-gl").Map,
  mode: TransitMode,
  color: string,
): string | null {
  const id = `transit-${mode}-${color}`;
  if (map.hasImage(id)) return id;

  // Drawn at twice the size and handed over as such, so it stays crisp on the
  // phone screens most of these pages are read on.
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = BADGE_PX * scale;
  canvas.height = BADGE_PX * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.scale(scale, scale);
  drawVehicleBadge(ctx, { mode, color });

  map.addImage(id, ctx.getImageData(0, 0, canvas.width, canvas.height), { pixelRatio: scale });
  return id;
}

/**
 * Signposted cycle routes from OpenStreetMap, rendered by Waymarked Trails as
 * transparent tiles: the international routes (EuroVelo and friends) in red,
 * national in blue, regional and local paler. It answers the question a family
 * link keeps raising — "is that an actual cycle route they're on?" — without
 * replacing the quiet basemap the day colours are drawn to stand out against.
 */
const CYCLE_TILES = "https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png";
const CYCLE_ATTRIBUTION =
  '<a href="https://cycling.waymarkedtrails.org/" target="_blank" rel="noreferrer">Waymarked Trails</a> (CC BY-SA 3.0)';
const CYCLE_LAYER = "cycle-routes";

type MapHandle = {
  flyToDay: (dayNumber: number) => void;
  /** Zoom back out to the whole journey, plan included. */
  resetView: () => void;
  /** Close in on the live position, which is a speck at whole-tour zoom. */
  flyToLive: () => void;
  setCycleRoutes: (visible: boolean) => void;
  showScrub: (lngLat: [number, number] | null, color: string) => void;
};

function TripMap({
  days,
  plan,
  live,
  handleRef,
  cycleRoutes,
  onPhoto,
  m,
}: {
  days: ViewerDay[];
  plan: TrackGeoJson[];
  live?: ViewerLive | null;
  handleRef: React.MutableRefObject<MapHandle | null>;
  /** Whether the cycle-route overlay is switched on. */
  cycleRoutes: boolean;
  /** Open a photo marker in the lightbox instead of navigating to the file. */
  onPhoto: (photo: ViewerPhoto) => void;
  m: Messages;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Read through a ref rather than an effect dependency: toggling the overlay
  // must not tear the map down and rebuild it. The ref also carries the choice
  // across a rebuild triggered by anything else, so the overlay doesn't
  // silently switch itself off.
  const cycleRef = useRef(cycleRoutes);
  cycleRef.current = cycleRoutes;

  useEffect(() => {
    handleRef.current?.setCycleRoutes(cycleRoutes);
  }, [cycleRoutes, handleRef]);

  useEffect(() => {
    let disposed = false;
    let map: import("maplibre-gl").Map | undefined;

    (async () => {
      const maplibregl = (await import("maplibre-gl")).default;
      if (disposed || !containerRef.current) return;

      const allCoords = [
        ...plan.flatMap((p) => p.geometry.coordinates),
        ...days.flatMap((d) => d.tracks.flatMap((t) => t.geojson.geometry.coordinates)),
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

      const photoMarkers: { el: HTMLElement; thumbUrl: string; color: string }[] = [];
      // Only touch the DOM when the answer actually changes — this runs on
      // every frame of a pan.
      let showingDots: boolean | null = null;
      const applyPhotoScale = () => {
        if (!map || photoMarkers.length === 0) return;
        const dots = metersPerCm(map) > PHOTO_DOT_ABOVE_M_PER_CM;
        if (dots === showingDots) return;
        showingDots = dots;
        for (const marker of photoMarkers) {
          marker.el.style.cssText = dots
            ? photoDotStyle(marker.color)
            : photoThumbStyle(marker.thumbUrl);
        }
      };

      map.on("load", () => {
        if (!map) return;

        // First of everything we add, so the tour's own lines stay on top of
        // the route network rather than being lost in it.
        map.addSource(CYCLE_LAYER, {
          type: "raster",
          tiles: [CYCLE_TILES],
          tileSize: 256,
          maxzoom: 18,
          attribution: CYCLE_ATTRIBUTION,
        });
        map.addLayer({
          id: CYCLE_LAYER,
          type: "raster",
          source: CYCLE_LAYER,
          // Full strength would out-shout the day colours; half lets the
          // network read as context under them.
          paint: { "raster-opacity": 0.55 },
          layout: { visibility: cycleRef.current ? "visible" : "none" },
        });

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
            map!.addSource(id, { type: "geojson", data: track.geojson });
            map!.addLayer({
              id,
              type: "line",
              source: id,
              paint: {
                "line-color": day.color,
                // A travelled leg is thinner, so the sleepers laid over it
                // below read as hatching rather than as a striped rope.
                "line-width": track.mode ? 3 : 4,
              },
              layout: track.mode
                ? { "line-cap": "butt", "line-join": "round" }
                : { "line-cap": "round", "line-join": "round" },
            });
            // The railway symbol every map uses: the line in the day's colour,
            // cross-hatched in white. It keeps the leg part of day 7 while
            // saying at a glance that this stretch was not ridden. Dash lengths
            // are multiples of the line width, so the hatching keeps its
            // proportions at every zoom.
            if (track.mode) {
              map!.addLayer({
                id: `${id}-hatch`,
                type: "line",
                source: id,
                paint: {
                  "line-color": "#ffffff",
                  "line-width": 3,
                  "line-dasharray": [0.7, 0.7],
                },
                layout: { "line-cap": "butt", "line-join": "round" },
              });

              // …and the vehicle itself, riding the line at intervals.
              const icon = ensureVehicleBadge(map!, track.mode, day.color);
              if (icon) {
                map!.addLayer({
                  id: `${id}-glyph`,
                  type: "symbol",
                  source: id,
                  layout: {
                    "icon-image": icon,
                    "symbol-placement": "line",
                    "symbol-spacing": 100,
                    // Upright whatever the line is doing: a locomotive aligned
                    // to the map runs backwards and upside down half the time.
                    "icon-rotation-alignment": "viewport",
                    "icon-allow-overlap": false,
                    "icon-padding": 6,
                  },
                });
              }
            }
          });

          for (const photo of day.photos) {
            if (photo.lat === null || photo.lng === null) continue;
            // Still an anchor, so a middle-click or long-press offers the file
            // the way any other link would — the plain click opens the viewer.
            const el = document.createElement("a");
            el.href = photo.url;
            el.target = "_blank";
            el.rel = "noreferrer";
            el.title = photo.caption ?? m.trip.photo;
            el.addEventListener("click", (event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              onPhoto(photo);
            });
            el.style.cssText = photoThumbStyle(photo.thumbUrl);
            new maplibregl.Marker({ element: el }).setLngLat([photo.lng, photo.lat]).addTo(map!);
            photoMarkers.push({ el, thumbUrl: photo.thumbUrl, color: day.color });
          }
        }

        applyPhotoScale();
        // Latitude moves the scale as much as zoom does, so watch the whole
        // camera rather than just the zoom level.
        map.on("move", applyPhotoScale);

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
        setCycleRoutes(visible) {
          // A toggle during the style's first load has nothing to set yet; the
          // load handler reads the same ref and picks the choice up there.
          if (!map?.getLayer(CYCLE_LAYER)) return;
          map.setLayoutProperty(CYCLE_LAYER, "visibility", visible ? "visible" : "none");
        },
        flyToDay(dayNumber) {
          const day = days.find((d) => d.dayNumber === dayNumber);
          if (!day || !map) return;
          const coords = day.tracks.flatMap((t) => t.geojson.geometry.coordinates);
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
  }, [days, plan, live, handleRef, onPhoto, m]);

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
  transitKm: number;
  transitModes: TransitMode[];
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

  // The name is worth keeping — the same visitor usually writes again — but the
  // message has already been said, so a posted one must not linger in the box
  // where it looks unsent and invites a double post.
  const [text, setText] = useState("");
  const textRef = useRef<HTMLInputElement | null>(null);
  const [justSent, setJustSent] = useState(false);
  useEffect(() => {
    if (!result?.ok) {
      if (result) setJustSent(false);
      return;
    }
    setText("");
    setJustSent(true);
    textRef.current?.focus();
  }, [result]);

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
            ref={textRef}
            name="text"
            required
            maxLength={800}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setJustSent(false);
            }}
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
      {justSent && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-sm font-bold text-pine-soft">
          <span aria-hidden="true">✓</span>
          {m.guestbook.sent}
        </p>
      )}
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
  // Off to begin with: the overlay is a third-party tile request, and it stays
  // unmade until someone asks for it.
  const [cycleRoutes, setCycleRoutes] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // A ride in progress is drawn before any of it has been uploaded as a track,
  // so day one of a trip has a live route and nothing else. Gating the map on
  // finished days alone left that first ride with nowhere to appear.
  const hasLiveTrack = (trip.live?.coords.length ?? 0) > 0;
  const hasMap = trip.days.length > 0 || hasLiveTrack;

  // Every photo on the trip, in the order the page tells the story, so the
  // viewer runs straight from one day into the next instead of stopping at the
  // end of whichever gallery it was opened from.
  const photos = useMemo<LightboxPhoto[]>(
    () =>
      trip.days.flatMap((day) =>
        day.photos.map((photo) => ({
          url: photo.url,
          thumbUrl: photo.thumbUrl,
          caption: photo.caption,
          author: photo.author,
          dayNumber: day.dayNumber,
        })),
      ),
    [trip.days],
  );
  const [openPhoto, setOpenPhoto] = useState<number | null>(null);
  // Markers carry the photo, not its place in the flat list; the URL is what
  // the two sides have in common.
  const openByUrl = useCallback(
    (photo: { url: string }) => {
      const at = photos.findIndex((p) => p.url === photo.url);
      if (at !== -1) setOpenPhoto(at);
    },
    [photos],
  );

  const progressPct =
    trip.planKm > 0 ? Math.min(100, Math.round((trip.totalKm / trip.planKm) * 100)) : null;

  // Every day's chart is drawn to the same metres-per-pixel, so a hard stage
  // visibly towers over an easy one instead of each filling its own box.
  const elevationSpan = useMemo(() => {
    // Across the whole day, stretches included: an interrupted day is still
    // one chart, and its two halves share a scale with every other day.
    const ranges = trip.days
      .map((d) => d.pieces.flatMap((piece) => piece.profile).map((p) => p.e))
      .filter((es) => es.length > 1)
      .map((es) => Math.max(...es) - Math.min(...es));
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
          {mounted && hasMap ? (
            <TripMap
              days={trip.days}
              plan={trip.plan}
              live={trip.live}
              handleRef={mapHandle}
              cycleRoutes={cycleRoutes}
              onPhoto={openByUrl}
              m={m}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-faint">
              {hasMap ? m.trip.loadingMap : m.trip.notStarted}
            </div>
          )}
        </div>

        {/* Stage ribbon: legend + navigation in one. Opaque rather than
            translucent — a backdrop-filter inside a sticky element makes Safari
            composite the map canvas through it. */}
        {hasMap && (
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
              <button
                onClick={() => setCycleRoutes((on) => !on)}
                aria-pressed={cycleRoutes}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-bold focus-visible:outline-2 focus-visible:outline-pine ${
                  cycleRoutes
                    ? "border-pine bg-pine text-paper"
                    : "border-trail text-pine hover:border-pine-soft"
                }`}
                title={m.trip.cycleRoutesHint}
              >
                <span aria-hidden>🚲</span> {m.trip.cycleRoutes}
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
            {trip.transitKm > 0 &&
              ` · ${m.trip.transit(trip.transitKm.toFixed(0), trip.transitModes)}`}
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

                {(day.distanceM > 0 || day.transitM > 0) && (
                  <p className="mt-1 text-sm">
                    {day.distanceM > 0 && (
                      <>
                        <strong>{(day.distanceM / 1000).toFixed(1)} km</strong>
                        <span className="text-faint">
                          {" "}· ↑ {Math.round(day.elevationUp)} m ·{" "}
                          {m.trip.moving(formatHours(day.movingS))}
                        </span>
                      </>
                    )}
                    <span className="text-faint">
                      {day.transitM > 0 &&
                        `${day.distanceM > 0 ? " · " : ""}${m.trip.transit(
                          (day.transitM / 1000).toFixed(0),
                          day.transitModes,
                        )}`}
                      {day.tracks.length > 1 && ` · ${m.trip.segments(day.tracks.length)}`}
                    </span>
                  </p>
                )}

                {day.pieces.some((piece) => piece.profile.length > 1) && (
                  <ElevationProfile
                    pieces={day.pieces.map((piece) => piece.profile)}
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
                        aria-label={m.lightbox.open(day.dayNumber)}
                        onClick={(e) => {
                          // Leave the modified clicks alone: opening a photo in
                          // a new tab is a thing people do, and the href is real.
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                          e.preventDefault();
                          openByUrl(photo);
                        }}
                        className="group relative block cursor-zoom-in overflow-hidden rounded-lg bg-trail/50"
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

      <PhotoLightbox
        photos={photos}
        index={openPhoto}
        onIndex={setOpenPhoto}
        onClose={() => setOpenPhoto(null)}
        showAuthors={trip.showAuthors}
      />
    </div>
  );
}

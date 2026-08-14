import { zipSync, strToU8 } from "fflate";
import { supabase } from "./supabase.server";
import { makeProjection, polylinePoints } from "./geo-project";
import { toGpx } from "./gpx-export";
import {
  buildProfile,
  fromGeoJson,
  groupContinuous,
  layEndToEnd,
  type ProfilePoint,
  type TrackGeoJson,
  type TrackPoint,
} from "./track";
import { weatherIcon, type DayWeather } from "./weather";
import { byPhotoTime } from "./photo-order";
import { isTransit } from "./transport";
import { riddenStretches, toPieces, type StoredSegment } from "./day-stretches";
import { reachedAlongPlan } from "./tour-layout";

const MAP_W = 1000;
const MAP_H = 620;

const PAPER = "#fbfaf7";
const INK = "#24312b";
const PINE = "#1e3a2f";
const FAINT = "#6b7a72";
const TRAIL = "#e3e0d8";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

interface ArchiveDay {
  dayNumber: number;
  date: string;
  color: string;
  distanceM: number;
  elevationUp: number;
  movingS: number;
  segments: TrackPoint[][];
  profile: ProfilePoint[];
  photos: {
    file: string;
    /** The three seconds behind a Live Photo, bundled beside the still. */
    motion: string | null;
    caption: string | null;
    author: string | null;
    lat: number | null;
    lng: number | null;
  }[];
  notes: { text: string; author: string | null }[];
  comments: { author: string; text: string; at: string }[];
  weather: DayWeather | null;
}

function formatDate(iso: string): string {
  return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: ${PAPER}; color: ${INK};
  font-family: "Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5; }
.wrap { max-width: 900px; margin: 0 auto; padding: 0 16px 64px; }
header { border-bottom: 1px solid ${TRAIL}; margin-bottom: 20px; padding: 24px 0 16px; }
h1 { font-family: Georgia, "Times New Roman", serif; font-size: 2rem; color: ${PINE}; margin: 0 0 4px; }
.sub { color: ${FAINT}; font-size: .95rem; }
.mapwrap { position: sticky; top: 0; background: ${PAPER}; padding: 8px 0; z-index: 5; }
svg.map { width: 100%; height: auto; display: block; background: #f2f0ea; border-radius: 10px; }
.ribbon { display: flex; gap: 8px; overflow-x: auto; padding: 8px 0; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid ${TRAIL};
  border-radius: 999px; padding: 4px 12px; font-size: .85rem; background: ${PAPER};
  cursor: pointer; white-space: nowrap; color: inherit; text-decoration: none; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
article { border-left: 4px solid; padding-left: 16px; margin: 40px 0; scroll-margin-top: 68vh; }
h2 { font-family: Georgia, serif; font-size: 1.3rem; color: ${PINE}; margin: 0 0 2px; display: inline-block; }
.meta { color: ${FAINT}; font-size: .9rem; margin-left: 8px; }
.stats { font-size: .95rem; margin: 4px 0 0; }
.stats span { color: ${FAINT}; }
figure { margin: 12px 0 0; }
svg.chart { width: 100%; height: 110px; display: block; touch-action: none; }
figcaption { display: flex; justify-content: space-between; font-size: .8rem; color: ${FAINT}; margin-top: 4px; }
.note { white-space: pre-wrap; margin: 12px 0 0; max-width: 65ch; }
.note .who { color: ${FAINT}; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 8px; margin-top: 14px; }
.grid a { position: relative; display: block; border-radius: 8px; overflow: hidden; background: ${TRAIL}; }
.grid img { width: 100%; aspect-ratio: 4/3; object-fit: cover; display: block; }
.grid video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  opacity: 0; transition: opacity .2s; pointer-events: none; }
.has-live:hover video { opacity: 1; }
.live { position: absolute; top: 6px; left: 6px; padding: 1px 5px; border-radius: 4px;
  background: rgba(0,0,0,.45); color: #fff; font-size: .6rem; letter-spacing: .08em; }
.has-live:hover .live { opacity: 0; }
.cap { position: absolute; left: 0; right: 0; bottom: 0; padding: 18px 8px 6px; font-size: .75rem;
  color: #fff; background: linear-gradient(to top, rgba(0,0,0,.72), transparent); }
.comments { margin-top: 18px; }
.comment { background: rgba(227,224,216,.45); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; font-size: .9rem; }
.comment .who { font-weight: 700; }
.comment .when { color: ${FAINT}; }
.comment p { margin: 2px 0 0; white-space: pre-wrap; }
footer { border-top: 1px solid ${TRAIL}; margin-top: 48px; padding-top: 16px; font-size: .8rem; color: ${FAINT}; }
footer a { color: ${PINE}; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

/**
 * Scrubbing works exactly as on the live page, but against the inline SVG map
 * rather than a tile map — so the archive needs no network to stay interactive.
 */
const JS = `
(function () {
  var marker = document.getElementById('scrub');
  document.querySelectorAll('svg.chart').forEach(function (svg) {
    var data = JSON.parse(svg.getAttribute('data-points'));
    var cap = svg.parentNode.querySelector('figcaption');
    var hint = cap.querySelector('.hint');
    var readout = cap.querySelector('.readout');
    var cursor = svg.querySelector('.cursor');
    var colour = svg.getAttribute('data-colour');
    function at(clientX) {
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      var frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      var i = Math.round(frac * (data.length - 1));
      var p = data[i];
      cursor.setAttribute('transform', 'translate(' + p[0] + ',0)');
      cursor.style.display = '';
      marker.setAttribute('cx', p[2]);
      marker.setAttribute('cy', p[3]);
      marker.setAttribute('fill', colour);
      marker.style.display = '';
      readout.textContent = (p[4] / 1000).toFixed(1) + ' km  ·  ' + Math.round(p[5]) + ' m';
      if (hint) hint.style.display = 'none';
    }
    svg.addEventListener('mousemove', function (e) { at(e.clientX); });
    svg.addEventListener('touchstart', function (e) { at(e.touches[0].clientX); }, { passive: true });
    svg.addEventListener('touchmove', function (e) { at(e.touches[0].clientX); }, { passive: true });
  });
})();
`;

function buildMapSvg(days: ArchiveDay[], plan: TrackPoint[][]): string {
  const all = [...plan.flat(), ...days.flatMap((d) => d.segments.flat())];
  if (all.length === 0) return "";
  const proj = makeProjection(all, { x: 24, y: 24, w: MAP_W - 48, h: MAP_H - 48 });

  let out = "";
  for (const seg of plan) {
    out += `<polyline points="${polylinePoints(seg, proj)}" fill="none" stroke="#9aa59e" stroke-width="4" stroke-dasharray="8 8" stroke-linecap="round"/>`;
  }
  for (const day of days) {
    for (const seg of day.segments) {
      out += `<polyline points="${polylinePoints(seg, proj)}" fill="none" stroke="${day.color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    for (const photo of day.photos) {
      if (photo.lat === null || photo.lng === null) continue;
      const [x, y] = proj.project({ lat: photo.lat, lng: photo.lng });
      out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${PAPER}" stroke="${day.color}" stroke-width="3"/>`;
    }
  }
  out += `<circle id="scrub" r="8" fill="${PINE}" stroke="#fff" stroke-width="3" style="display:none"/>`;

  return `<svg class="map" viewBox="0 0 ${MAP_W} ${MAP_H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Route map">${out}</svg>`;
}

function buildChart(
  day: ArchiveDay,
  proj: ReturnType<typeof makeProjection> | null,
  span: number,
): string {
  const p = day.profile;
  if (p.length < 2 || !proj) return "";

  const W = 720;
  const H = 110;
  const TOP = 12;
  const BOT = 16;
  const es = p.map((q) => q.e);
  const lo = Math.min(...es);
  const hi = Math.max(...es);
  const total = p[p.length - 1].d || 1;

  // Shared metres-per-pixel across days, centred on this day's own altitude.
  const band = Math.max(span, hi - lo);
  const base = (lo + hi) / 2 - band / 2;

  const x = (q: ProfilePoint) => (q.d / total) * W;
  const y = (q: ProfilePoint) => TOP + (1 - (q.e - base) / band) * (H - TOP - BOT);

  const line = p.map((q, i) => `${i === 0 ? "M" : "L"}${x(q).toFixed(1)},${y(q).toFixed(1)}`).join("");
  const area = `${line}L${W},${H - BOT}L0,${H - BOT}Z`;

  // [chartX, chartY, mapX, mapY, metres, elevation] — everything the scrub needs.
  const pts = p.map((q) => {
    const [mx, my] = proj.project(q);
    return [
      +x(q).toFixed(1),
      +y(q).toFixed(1),
      +mx.toFixed(1),
      +my.toFixed(1),
      q.d,
      Math.round(q.e),
    ];
  });

  return `<figure>
  <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-colour="${day.color}" data-points='${JSON.stringify(pts)}' role="img" aria-label="Elevation profile for day ${day.dayNumber}">
    <path d="${area}" fill="${day.color}" opacity="0.16"/>
    <path d="${line}" fill="none" stroke="${day.color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <g class="cursor" style="display:none"><line x1="0" x2="0" y1="${TOP}" y2="${H - BOT}" stroke="${day.color}" stroke-width="1" vector-effect="non-scaling-stroke"/></g>
  </svg>
  <figcaption><span>${Math.round(lo)}–${Math.round(hi)} m</span><span class="readout"></span><span class="hint">drag along the line</span></figcaption>
</figure>`;
}

function buildHtml(opts: {
  name: string;
  startDate: string;
  endDate: string | null;
  days: ArchiveDay[];
  plan: TrackPoint[][];
  totalKm: number;
  totalUp: number;
  movingS: number;
  planKm: number;
  /** How far along the plan the journey has got — not what it has ridden. */
  reachedKm: number;
  liveUrl: string;
  showAuthors: boolean;
}): string {
  const all = [...opts.plan.flat(), ...opts.days.flatMap((d) => d.segments.flat())];
  const proj =
    all.length > 0
      ? makeProjection(all, { x: 24, y: 24, w: MAP_W - 48, h: MAP_H - 48 })
      : null;

  // Position along the route rather than distance ridden: a wandering day
  // advances less route than it rides, and a train advances it without riding.
  const pct = opts.planKm > 0 ? Math.round((opts.reachedKm / opts.planKm) * 100) : null;

  const elevationSpan = Math.max(
    20,
    ...opts.days
      .filter((d) => d.profile.length > 1)
      .map((d) => {
        const es = d.profile.map((p) => p.e);
        return Math.max(...es) - Math.min(...es);
      }),
  );

  const ribbon = opts.days
    .map(
      (d) =>
        `<a class="chip" href="#day-${d.dayNumber}"><span class="dot" style="background:${d.color}"></span><strong>Day ${d.dayNumber}</strong>${
          d.distanceM > 0 ? ` <span style="color:${FAINT}">${(d.distanceM / 1000).toFixed(0)} km</span>` : ""
        }</a>`,
    )
    .join("");

  const articles = opts.days
    .map((day) => {
      const w = day.weather;
      const wi = weatherIcon(w?.weatherCode ?? null);
      const weatherBit = w
        ? ` <span class="meta">${wi.icon} ${w.tempMinC !== null ? Math.round(w.tempMinC) + "–" : ""}${
            w.tempMaxC !== null ? Math.round(w.tempMaxC) + "°C" : ""
          }${w.precipitationMm !== null && w.precipitationMm > 0.5 ? ` · ${w.precipitationMm.toFixed(0)} mm` : ""}</span>`
        : "";

      const stats =
        day.distanceM > 0
          ? `<p class="stats"><strong>${(day.distanceM / 1000).toFixed(1)} km</strong> <span>· ↑ ${Math.round(
              day.elevationUp,
            )} m · ${formatHours(day.movingS)} moving${day.segments.length > 1 ? ` · ${day.segments.length} segments` : ""}</span></p>`
          : "";

      const notes = day.notes
        .map(
          (n) =>
            `<p class="note">${esc(n.text)}${
              opts.showAuthors && n.author ? `<span class="who"> — ${esc(n.author)}</span>` : ""
            }</p>`,
        )
        .join("");

      const photos =
        day.photos.length > 0
          ? `<div class="grid">${day.photos
              .map((p) => {
                const label = [p.caption, opts.showAuthors ? p.author : null].filter(Boolean).join(" — ");
                // A Live Photo plays where it sits, on hover, much as it does on
                // the trip page. The hover has to be read off the tile rather
                // than the video, which is behind `pointer-events: none` so it
                // never swallows the click that opens the picture.
                const live = p.motion
                  ? `<video src="${p.motion}" muted loop playsinline preload="none"></video>` +
                    `<span class="live">LIVE</span>`
                  : "";
                const plays = p.motion
                  ? ` onmouseenter="this.querySelector('video').play()"` +
                    ` onmouseleave="const v=this.querySelector('video');v.pause();v.currentTime=0"`
                  : "";
                return `<a href="${p.file}" class="${p.motion ? "has-live" : ""}"${plays}><img src="${p.file}" alt="${esc(p.caption ?? `Day ${day.dayNumber} photo`)}" loading="lazy">${live}${
                  label ? `<span class="cap">${esc(label)}</span>` : ""
                }</a>`;
              })
              .join("")}</div>`
          : "";

      const comments =
        day.comments.length > 0
          ? `<div class="comments">${day.comments
              .map(
                (c) =>
                  `<div class="comment"><span class="who" style="color:${day.color}">${esc(
                    c.author,
                  )}</span> <span class="when">· ${esc(c.at)}</span><p>${esc(c.text)}</p></div>`,
              )
              .join("")}</div>`
          : "";

      return `<article id="day-${day.dayNumber}" style="border-color:${day.color}">
  <h2>Day ${day.dayNumber}</h2><span class="meta">${formatDate(day.date)}</span>${weatherBit}
  ${stats}
  ${buildChart(day, proj, elevationSpan)}
  ${notes}
  ${photos}
  ${comments}
</article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.name)} — TrackTale archive</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(opts.name)}</h1>
    <p class="sub">${opts.endDate ? `${formatDate(opts.startDate)} – ${formatDate(opts.endDate)}` : `since ${formatDate(opts.startDate)}`}</p>
  </header>

  <div class="mapwrap">
    ${buildMapSvg(opts.days, opts.plan)}
    <nav class="ribbon">${ribbon}</nav>
  </div>

  <p class="sub">${opts.totalKm.toFixed(1)} km · ${Math.round(opts.totalUp)} m climbed · ${formatHours(
    opts.movingS,
  )} in motion · ${opts.days.length} ${opts.days.length === 1 ? "day" : "days"}${
    pct !== null ? ` · ${pct}% of the planned route` : ""
  }</p>

  ${articles}

  <footer>
    Archived from TrackTale. Everything here — map, charts, photos — works offline.
    GPX tracks are in <code>tracks/</code>. <a href="${esc(opts.liveUrl)}">Live version</a>.
  </footer>
</div>
<script>${JS}</script>
</body>
</html>
`;
}

export interface ArchiveResult {
  zip: Uint8Array;
  filename: string;
  path: string;
  publicUrl: string;
}

/** Build a self-contained bundle for a trip and store it. */
export async function buildArchive(tripId: string, appOrigin: string): Promise<ArchiveResult> {
  const db = supabase();

  const { data: trip } = await db.from("trips").select("*").eq("id", tripId).maybeSingle();
  if (!trip) throw new Error("Trip not found");

  const [{ data: dayRows }, { data: planRows }] = await Promise.all([
    db
      .from("days")
      .select(
        "day_number, date, color, track_segments(geojson, distance_m, moving_s, elevation_up, sport, started_at), media(storage_path, motion_path, caption, author_name, matched_lat, matched_lng, telegram_date, taken_at, created_at), notes(text, created_at, author_name), comments(author_name, text, created_at), weather_cache(data)",
      )
      .eq("trip_id", tripId)
      .order("day_number"),
    db.from("plan_segments").select("geojson, distance_m").eq("trip_id", tripId).order("sort_order"),
  ]);

  const files: Record<string, Uint8Array> = {};
  const days: ArchiveDay[] = [];
  const contributors = new Set<string>();

  for (const d of dayRows ?? []) {
    const segments = [...d.track_segments].sort(
      (a, b) => Date.parse(a.started_at ?? 0) - Date.parse(b.started_at ?? 0),
    );
    const segPoints = segments.map((s) => fromGeoJson(s.geojson as TrackGeoJson));
    // The GPX keeps every metre of the day; the numbers count only what was
    // ridden, so a leg taken by train reads the same here as on the page.
    const ridden = segments.filter((s) => !isTransit(s.sport));
    const riddenPoints = ridden.map((s) => fromGeoJson(s.geojson as TrackGeoJson));

    const photos: ArchiveDay["photos"] = [];
    const sortedMedia = [...d.media].sort(byPhotoTime);
    for (let i = 0; i < sortedMedia.length; i++) {
      const m = sortedMedia[i];
      // Photos sent as files keep their own format, so don't rename a PNG .jpg.
      const ext = /\.[a-z0-9]+$/i.exec(m.storage_path)?.[0] ?? ".jpg";
      const file = `photos/day-${d.day_number}-${String(i + 1).padStart(2, "0")}${ext}`;
      const { data: blob } = await db.storage.from("photos").download(m.storage_path);
      if (blob) files[file] = new Uint8Array(await blob.arrayBuffer());

      // A Live Photo's motion travels with its still, under the same name, so
      // the two stay together however the folder is later sorted or moved.
      let motion: string | null = null;
      if (m.motion_path) {
        const motionExt = /\.[a-z0-9]+$/i.exec(m.motion_path)?.[0] ?? ".mp4";
        const motionFile = `${file.replace(/\.[a-z0-9]+$/i, "")}-live${motionExt}`;
        const { data: motionBlob } = await db.storage.from("photos").download(m.motion_path);
        if (motionBlob) {
          files[motionFile] = new Uint8Array(await motionBlob.arrayBuffer());
          motion = motionFile;
        }
      }

      if (m.author_name) contributors.add(m.author_name);
      photos.push({
        file,
        motion,
        caption: m.caption,
        author: m.author_name,
        lat: m.matched_lat,
        lng: m.matched_lng,
      });
    }

    for (const n of d.notes) if (n.author_name) contributors.add(n.author_name);

    if (segPoints.some((s) => s.length > 0)) {
      files[`tracks/day-${d.day_number}.gpx`] = strToU8(
        toGpx(`${trip.name} — day ${d.day_number}`, segPoints),
      );
    }

    days.push({
      dayNumber: d.day_number,
      date: d.date,
      color: d.color,
      distanceM: ridden.reduce((s, x) => s + x.distance_m, 0),
      elevationUp: ridden.reduce((s, x) => s + x.elevation_up, 0),
      movingS: ridden.reduce((s, x) => s + x.moving_s, 0),
      segments: segPoints,
      // Stretch by stretch, laid end to end: a day interrupted by a train did
      // not ride the 133 km in between, and measuring straight through them
      // would put that distance on the chart's axis.
      profile: layEndToEnd(
        groupContinuous(riddenPoints).map((group) =>
          buildProfile(group.flatMap((i) => riddenPoints[i])),
        ),
      ),
      photos,
      notes: [...d.notes]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((n) => ({ text: n.text, author: n.author_name })),
      comments: [...d.comments]
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((c) => ({
          author: c.author_name,
          text: c.text,
          at: new Date(c.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        })),
      weather: (d.weather_cache as unknown as { data: DayWeather } | null)?.data ?? null,
    });
  }

  const withContent = days.filter(
    (d) => d.segments.length + d.photos.length + d.notes.length > 0,
  );

  files["index.html"] = strToU8(
    buildHtml({
      name: trip.name,
      startDate: trip.start_date,
      endDate: trip.end_date,
      days: withContent,
      plan: (planRows ?? []).map((p) => fromGeoJson(p.geojson as TrackGeoJson)),
      totalKm: withContent.reduce((s, d) => s + d.distanceM, 0) / 1000,
      totalUp: withContent.reduce((s, d) => s + d.elevationUp, 0),
      movingS: withContent.reduce((s, d) => s + d.movingS, 0),
      planKm: (planRows ?? []).reduce((s, p) => s + p.distance_m, 0) / 1000,
      reachedKm:
        reachedAlongPlan(
          (planRows ?? []).flatMap((p) => fromGeoJson(p.geojson as TrackGeoJson)),
          (planRows ?? []).reduce((s, p) => s + p.distance_m, 0),
          (dayRows ?? []).map((d) => ({
            dayNumber: d.day_number,
            color: d.color,
            // In the order they were ridden; grouping is about sequence.
            pieces: toPieces(
              riddenStretches(
                [...d.track_segments].sort(
                  (a, b) => Date.parse(a.started_at ?? 0) - Date.parse(b.started_at ?? 0),
                ) as StoredSegment[],
              ),
            ),
          })),
        ) / 1000,
      liveUrl: `${appOrigin}/t/${trip.share_slug}`,
      showAuthors: contributors.size > 1,
    }),
  );

  const slug = trip.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trip";
  const filename = `${slug}-${trip.start_date}.zip`;
  const zip = zipSync(files, { level: 6 });

  const path = `${tripId}/${filename}`;
  const { error } = await db.storage
    .from("archives")
    .upload(path, zip, { contentType: "application/zip", upsert: true });
  if (error) throw error;

  await db
    .from("trips")
    .update({ archive_path: path, archived_at: new Date().toISOString() })
    .eq("id", tripId);

  return {
    zip,
    filename,
    path,
    publicUrl: db.storage.from("archives").getPublicUrl(path).data.publicUrl,
  };
}

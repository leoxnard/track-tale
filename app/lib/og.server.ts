import { Resvg } from "@resvg/resvg-js";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ATKINSON_BOLD_B64, ATKINSON_REGULAR_B64 } from "./fonts";
import { supabase } from "./supabase.server";
import { fromGeoJson, type TrackGeoJson, type TrackPoint } from "./track";

const WIDTH = 1200;
const HEIGHT = 630;
const BAND_H = 168;
const PAD = 48;

const PAPER = "#fbfaf7";
const PINE = "#1e3a2f";
const TRAIL = "#c9d2cc";

/**
 * resvg loads fonts from disk only, so the embedded fonts are materialised into
 * a temp directory once per process. This keeps cards identical on Vercel, on a
 * self-hosted box, and locally, without depending on what the bundler ships.
 */
let fontFiles: string[] | undefined;
function fonts(): string[] {
  if (fontFiles && fontFiles.every(existsSync)) return fontFiles;
  const dir = mkdtempSync(join(tmpdir(), "tracktale-fonts-"));
  const write = (name: string, b64: string) => {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(b64, "base64"));
    return path;
  };
  fontFiles = [
    write("atkinson-regular.ttf", ATKINSON_REGULAR_B64),
    write("atkinson-bold.ttf", ATKINSON_BOLD_B64),
  ];
  return fontFiles;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

interface Projection {
  project(p: TrackPoint): [number, number];
}

/**
 * Equirectangular projection with a cosine correction, fitted to the drawing
 * box. Accurate enough at trip scale and avoids a mapping dependency.
 */
function makeProjection(points: TrackPoint[], box: { x: number; y: number; w: number; h: number }): Projection {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const k = Math.cos((midLat * Math.PI) / 180);

  const xs = lngs.map((l) => l * k);
  const ys = lats.map((l) => -l);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;
  const scale = Math.min(box.w / spanX, box.h / spanY);
  const offX = box.x + (box.w - spanX * scale) / 2;
  const offY = box.y + (box.h - spanY * scale) / 2;

  return {
    project(p) {
      return [offX + (p.lng * k - minX) * scale, offY + (-p.lat - minY) * scale];
    },
  };
}

function polyline(points: TrackPoint[], proj: Projection): string {
  return points.map((p) => proj.project(p).map((n) => n.toFixed(1)).join(",")).join(" ");
}

/** A small bicycle mark, drawn rather than typed so no emoji font is needed. */
function bikeMark(x: number, y: number): string {
  const s = 1.35;
  const g = (dx: number, dy: number) => `${(x + dx * s).toFixed(1)},${(y + dy * s).toFixed(1)}`;
  return `
    <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="30" fill="${PAPER}" stroke="${PINE}" stroke-width="3"/>
    <g stroke="${PINE}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="${(x - 8 * s).toFixed(1)}" cy="${(y + 6 * s).toFixed(1)}" r="${(6.5 * s).toFixed(1)}"/>
      <circle cx="${(x + 8 * s).toFixed(1)}" cy="${(y + 6 * s).toFixed(1)}" r="${(6.5 * s).toFixed(1)}"/>
      <polyline points="${g(-8, 6)} ${g(-2, -4)} ${g(6, -4)} ${g(8, 6)}"/>
      <polyline points="${g(-2, -4)} ${g(2, 6)} ${g(8, 6)}"/>
      <polyline points="${g(4, -8)} ${g(8, -8)}"/>
      <polyline points="${g(6, -4)} ${g(6.5, -7.5)}"/>
    </g>`;
}

interface OgData {
  name: string;
  planPoints: TrackPoint[][];
  dayTracks: { color: string; points: TrackPoint[] }[];
  totalKm: number;
  planKm: number;
  totalUp: number;
  dayCount: number;
  current: TrackPoint | null;
}

function buildSvg(data: OgData): string {
  const box = { x: PAD, y: PAD, w: WIDTH - PAD * 2, h: HEIGHT - BAND_H - PAD * 1.5 };
  const all = [...data.planPoints.flat(), ...data.dayTracks.flatMap((d) => d.points)];

  let route = "";
  let bike = "";
  if (all.length > 0) {
    const proj = makeProjection(all, box);
    for (const plan of data.planPoints) {
      route += `<polyline points="${polyline(plan, proj)}" fill="none" stroke="${TRAIL}" stroke-width="7" stroke-dasharray="14 12" stroke-linecap="round"/>`;
    }
    for (const day of data.dayTracks) {
      route += `<polyline points="${polyline(day.points, proj)}" fill="none" stroke="${day.color}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    if (data.current) {
      const [cx, cy] = proj.project(data.current);
      bike = bikeMark(cx, cy);
    }
  }

  const bandY = HEIGHT - BAND_H;
  const pct = data.planKm > 0 ? Math.min(100, Math.round((data.totalKm / data.planKm) * 100)) : null;

  const statParts = [
    `${data.totalKm.toFixed(0)} km`,
    `${Math.round(data.totalUp)} m climbed`,
    `${data.dayCount} ${data.dayCount === 1 ? "day" : "days"}`,
  ];
  if (pct !== null) statParts.push(`${pct}% of route`);

  const barX = PAD;
  const barW = WIDTH - PAD * 2;
  const barY = bandY + BAND_H - 42;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  ${route}
  ${bike}
  <rect x="0" y="${bandY}" width="${WIDTH}" height="${BAND_H}" fill="${PINE}"/>
  <text x="${PAD}" y="${bandY + 58}" font-family="Atkinson Hyperlegible" font-weight="700" font-size="46" fill="${PAPER}">${escapeXml(data.name)}</text>
  <text x="${PAD}" y="${bandY + 98}" font-family="Atkinson Hyperlegible" font-size="26" fill="#a9bcb2">${escapeXml(statParts.join("  ·  "))}</text>
  ${
    pct !== null
      ? `<rect x="${barX}" y="${barY}" width="${barW}" height="10" rx="5" fill="#2e5243"/>
         <rect x="${barX}" y="${barY}" width="${((barW * pct) / 100).toFixed(1)}" height="10" rx="5" fill="${PAPER}"/>`
      : ""
  }
</svg>`;
}

/**
 * Render the trip's share card and store it. Called after every track upload so
 * a link pasted mid-trip previews the journey as it stands.
 */
export async function renderOgCard(tripId: string): Promise<string | null> {
  const db = supabase();

  const { data: trip } = await db.from("trips").select("id, name").eq("id", tripId).maybeSingle();
  if (!trip) return null;

  const [{ data: dayRows }, { data: planRows }] = await Promise.all([
    db
      .from("days")
      .select("day_number, color, track_segments(geojson, distance_m, elevation_up, started_at)")
      .eq("trip_id", tripId)
      .order("day_number"),
    db.from("plan_segments").select("geojson, distance_m").eq("trip_id", tripId).order("sort_order"),
  ]);

  const dayTracks: OgData["dayTracks"] = [];
  let totalKm = 0;
  let totalUp = 0;
  let dayCount = 0;
  let current: TrackPoint | null = null;
  let latestStart = -Infinity;

  for (const day of dayRows ?? []) {
    const segments = [...day.track_segments].sort(
      (a, b) => Date.parse(a.started_at ?? 0) - Date.parse(b.started_at ?? 0),
    );
    if (segments.length > 0) dayCount++;
    for (const seg of segments) {
      const points = fromGeoJson(seg.geojson as TrackGeoJson);
      if (points.length === 0) continue;
      dayTracks.push({ color: day.color, points });
      totalKm += seg.distance_m / 1000;
      totalUp += seg.elevation_up;
      const started = Date.parse(seg.started_at ?? 0) || 0;
      if (started >= latestStart) {
        latestStart = started;
        current = points[points.length - 1];
      }
    }
  }

  const svg = buildSvg({
    name: trip.name,
    planPoints: (planRows ?? []).map((p) => fromGeoJson(p.geojson as TrackGeoJson)),
    dayTracks,
    totalKm,
    planKm: (planRows ?? []).reduce((s, p) => s + p.distance_m, 0) / 1000,
    totalUp,
    dayCount,
    current,
  });

  const png = new Resvg(svg, {
    font: { loadSystemFonts: false, fontFiles: fonts(), defaultFontFamily: "Atkinson Hyperlegible" },
    fitTo: { mode: "width", value: WIDTH },
  })
    .render()
    .asPng();

  const path = `og/${tripId}.png`;
  const { error } = await db.storage
    .from("photos")
    .upload(path, png, { contentType: "image/png", upsert: true });
  if (error) throw error;

  await db
    .from("trips")
    .update({ og_path: path, og_updated_at: new Date().toISOString() })
    .eq("id", tripId);

  return path;
}

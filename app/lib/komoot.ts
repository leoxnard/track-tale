import { computeStats, type NormalizedTrack, type TrackPoint } from "./track";

export interface KomootRef {
  tourId: string;
  shareToken?: string;
}

export interface KomootTour extends NormalizedTrack {
  tourId: string;
  /** "tour_recorded" = a ride that happened, "tour_planned" = a route plan */
  tourType: "tour_recorded" | "tour_planned";
  sourceUrl: string;
}

const TOUR_URL_RE = /komoot\.[a-z.]+\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?tour\/(\d+)/i;

/** Extract tour id + share token from any komoot tour URL (locale-prefixed or not). */
export function parseKomootUrl(url: string): KomootRef | null {
  const match = url.match(TOUR_URL_RE);
  if (!match) return null;
  let shareToken: string | undefined;
  try {
    shareToken = new URL(url).searchParams.get("share_token") ?? undefined;
  } catch {
    // not a fully-qualified URL; token stays undefined
  }
  return { tourId: match[1], shareToken };
}

export function findKomootUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s]*komoot\.[a-z.]+\/[^\s]+/i);
  return match ? match[0] : null;
}

const API_BASE = "https://api.komoot.de/v007";
const HEADERS = {
  Accept: "application/hal+json",
  "User-Agent": "Mozilla/5.0 (TrackTale private trip journal)",
};

async function apiGet(path: string, shareToken?: string): Promise<unknown> {
  const url = new URL(`${API_BASE}${path}`);
  if (shareToken) url.searchParams.set("share_token", shareToken);
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Komoot API ${res.status} for ${path}`);
  }
  return res.json();
}

/**
 * Fetch a full tour via Komoot's internal API using the share token.
 * Unofficial endpoint — callers must always offer GPX upload as fallback.
 */
export async function fetchKomootTour(ref: KomootRef): Promise<KomootTour> {
  const tour = (await apiGet(`/tours/${ref.tourId}`, ref.shareToken)) as {
    name?: string;
    sport?: string;
    type?: string;
    date?: string;
    distance?: number;
    duration?: number;
    time_in_motion?: number;
    elevation_up?: number;
    elevation_down?: number;
  };

  const coords = (await apiGet(
    `/tours/${ref.tourId}/coordinates`,
    ref.shareToken,
  )) as { items?: { lat: number; lng: number; alt?: number; t?: number }[] };

  const baseTime = tour.date ? Date.parse(tour.date) : undefined;
  const points: TrackPoint[] = (coords.items ?? []).map((item) => ({
    lat: item.lat,
    lng: item.lng,
    alt: item.alt,
    time:
      baseTime !== undefined && item.t !== undefined
        ? baseTime + item.t
        : undefined,
  }));

  if (points.length === 0) throw new Error("Komoot tour has no coordinates");

  const tourType = tour.type === "tour_planned" ? "tour_planned" : "tour_recorded";
  // Prefer Komoot's official figures over GPS-derived ones where available.
  const computed = computeStats(points);
  return {
    tourId: ref.tourId,
    tourType,
    name: tour.name,
    sport: tour.sport,
    points,
    stats: {
      distanceM: tour.distance ?? computed.distanceM,
      durationS: tour.duration ?? computed.durationS,
      movingS: tour.time_in_motion ?? computed.movingS,
      elevationUp: tour.elevation_up ?? computed.elevationUp,
      elevationDown: tour.elevation_down ?? computed.elevationDown,
      startedAt: computed.startedAt ?? tour.date,
    },
    sourceUrl: `https://www.komoot.com/tour/${ref.tourId}${ref.shareToken ? `?share_token=${ref.shareToken}` : ""}`,
  };
}

import { DOMParser } from "@xmldom/xmldom";
import { gpx as gpxToGeoJson } from "@tmcw/togeojson";
import FitParser from "fit-file-parser";
import { computeStats, type NormalizedTrack, type TrackPoint } from "./track";

/** Parse a GPX file into one normalized track (all track segments concatenated). */
export function parseGpx(xml: string): NormalizedTrack {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  // @tmcw/togeojson accepts any DOM-compatible document
  const collection = gpxToGeoJson(doc as unknown as Document);

  const points: TrackPoint[] = [];
  let name: string | undefined;

  for (const feature of collection.features) {
    const props = feature.properties ?? {};
    name ??= typeof props.name === "string" ? props.name : undefined;
    const geometry = feature.geometry;
    if (!geometry) continue;

    const lines =
      geometry.type === "LineString"
        ? [geometry.coordinates]
        : geometry.type === "MultiLineString"
          ? geometry.coordinates
          : [];

    const timeLists: string[][] =
      geometry.type === "MultiLineString"
        ? (props.coordinateProperties?.times ?? [])
        : [props.coordinateProperties?.times ?? []];

    lines.forEach((line, li) => {
      const times = timeLists[li] ?? [];
      line.forEach((coord, ci) => {
        const [lng, lat, alt] = coord;
        const t = times[ci] ? Date.parse(times[ci]) : undefined;
        points.push({ lat, lng, alt, time: Number.isNaN(t) ? undefined : t });
      });
    });
  }

  if (points.length === 0) throw new Error("GPX contains no track points");
  return { name, points, stats: computeStats(points) };
}

/** Parse a Garmin FIT file into one normalized track. */
export async function parseFit(buffer: ArrayBuffer): Promise<NormalizedTrack> {
  const parser = new FitParser({ force: true, lengthUnit: "m", mode: "list" });
  const data = await parser.parseAsync(buffer);

  const points: TrackPoint[] = (data.records ?? [])
    .filter((r) => typeof r.position_lat === "number" && typeof r.position_long === "number")
    .map((r) => ({
      lat: r.position_lat as number,
      lng: r.position_long as number,
      alt: (r.enhanced_altitude ?? r.altitude) as number | undefined,
      time: r.timestamp ? new Date(r.timestamp).getTime() : undefined,
    }));

  if (points.length === 0) throw new Error("FIT contains no GPS records");
  const sport = data.sessions?.[0]?.sport;
  return {
    sport: typeof sport === "string" ? sport : undefined,
    points,
    stats: computeStats(points),
  };
}

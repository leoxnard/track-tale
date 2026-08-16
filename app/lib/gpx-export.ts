import type { TrackPoint } from "./track";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/** One track in a file: what it is called, and the stretches it is made of. */
export interface GpxTrack {
  name: string;
  segments: TrackPoint[][];
}

function trkseg(seg: TrackPoint[]): string {
  const pts = seg
    .map((p) => {
      const ele = p.alt !== undefined ? `<ele>${p.alt.toFixed(1)}</ele>` : "";
      const time = p.time !== undefined ? `<time>${new Date(p.time).toISOString()}</time>` : "";
      return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${ele}${time}</trkpt>`;
    })
    .join("\n      ");
  return `    <trkseg>\n      ${pts}\n    </trkseg>`;
}

/**
 * Several named tracks in one GPX 1.1 file.
 *
 * A whole trip in a single `<trk>` would be one nameless smear in every mapping
 * tool: the days would be indistinguishable and a leg taken by train would add
 * its kilometres to whatever the tool totals up. One `<trk>` per day — and a
 * train, ferry or bus leg in a track of its own, named as such — keeps them
 * separable by anything that reads the file, which is the point of handing out
 * the file at all.
 */
export function toGpxTracks(tracks: GpxTrack[]): string {
  const trks = tracks
    .map((track) => ({ ...track, segments: track.segments.filter((seg) => seg.length > 0) }))
    .filter((track) => track.segments.length > 0)
    .map(
      (track) =>
        `  <trk>\n    <name>${esc(track.name)}</name>\n${track.segments.map(trkseg).join("\n")}\n  </trk>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrackTale" xmlns="http://www.topografix.com/GPX/1/1">
${trks}
</gpx>
`;
}

/** Standard GPX 1.1, so an archived day opens in any mapping tool. */
export function toGpx(name: string, segments: TrackPoint[][]): string {
  return toGpxTracks([{ name, segments }]);
}

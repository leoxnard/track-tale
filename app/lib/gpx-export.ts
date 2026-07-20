import type { TrackPoint } from "./track";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
}

/** Standard GPX 1.1, so an archived day opens in any mapping tool. */
export function toGpx(name: string, segments: TrackPoint[][]): string {
  const trksegs = segments
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      const pts = seg
        .map((p) => {
          const ele = p.alt !== undefined ? `<ele>${p.alt.toFixed(1)}</ele>` : "";
          const time = p.time !== undefined ? `<time>${new Date(p.time).toISOString()}</time>` : "";
          return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${ele}${time}</trkpt>`;
        })
        .join("\n      ");
      return `    <trkseg>\n      ${pts}\n    </trkseg>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrackTale" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(name)}</name>
${trksegs}
  </trk>
</gpx>
`;
}

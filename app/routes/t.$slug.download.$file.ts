import { data } from "react-router";
import type { Route } from "./+types/t.$slug.download.$file";
import { attachmentName, parseDownloadFile } from "../lib/downloads";
import { buildDownloadGpx, buildPhotoZip, buildPlanGpx } from "../lib/downloads.server";
import { messages, resolveLocale } from "../lib/i18n";

/**
 * The bytes behind the download centre's links.
 *
 * A resource route with no component: it answers with a file or with a status,
 * never with a page. The trip is found by its slug exactly as the family page
 * finds it — knowing the slug is the authorisation, and there is nothing here
 * that the page itself does not already show.
 *
 * Nothing is cached publicly. A shared link is meant to reach the family, not a
 * CDN edge that keeps a trip's photographs after the trip is deleted.
 */

const NO_STORE = "private, no-store";

export async function loader({ params, request }: Route.LoaderArgs) {
  const req = parseDownloadFile(params.file);
  if (!req) throw data("Not found", { status: 404 });

  if (req.kind === "gpx" || req.kind === "plan") {
    const built =
      req.kind === "plan"
        ? await buildPlanGpx(params.slug, req.day)
        : await buildDownloadGpx(params.slug, req.day);
    if (!built) throw data("Not found", { status: 404 });
    return new Response(built.gpx, {
      headers: {
        "Content-Type": "application/gpx+xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="${attachmentName(built.trip.name, req)}"`,
        "Cache-Control": NO_STORE,
      },
    });
  }

  const zip = await buildPhotoZip(params.slug, req.day);
  if (!zip) throw data("Not found", { status: 404 });
  if (!zip.ok) {
    if (zip.reason === "empty") throw data("Not found", { status: 404 });
    // 413 is the honest status, and the body is what a reader sees if the
    // browser shows it: the day zips are still there, and they always work.
    throw data(messages(resolveLocale(request)).downloads.tooLarge, { status: 413 });
  }

  // Wrapped rather than handed over raw: a Uint8Array is not a `BodyInit`, and
  // a Blob carries the length with it.
  return new Response(new Blob([zip.zip], { type: "application/zip" }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${attachmentName(zip.trip.name, req)}"`,
      "Content-Length": String(zip.zip.byteLength),
      "Cache-Control": NO_STORE,
    },
  });
}

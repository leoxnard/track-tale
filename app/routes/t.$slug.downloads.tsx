import { data, Link } from "react-router";
import type { Route } from "./+types/t.$slug.downloads";
import { tripDownloads } from "../lib/downloads.server";
import { downloadFileName } from "../lib/downloads";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { TRANSIT_NOUNS, formatDayDate, resolveLocale } from "../lib/i18n";
import { useLocale, useMessages } from "../lib/locale";

/**
 * The first page hanging off the trip's menu.
 *
 * A link to a file is all this is — no state, no fetch, no progress bar. The
 * work of packing a zip happens in the resource route the browser is sent to,
 * so a reader who taps a 400 MB trip and changes their mind simply cancels a
 * download rather than leaving something half-built behind.
 */

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolveLocale(request);
  const trip = await tripDownloads(params.slug);
  if (!trip) throw data("Trip not found", { status: 404 });
  return { ...trip, locale };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData ? `${loaderData.name} — TrackTale` : "TrackTale" },
    // Same as the trip page itself: knowing the slug is the authorisation, so
    // nothing here goes anywhere near an index.
    { name: "robots", content: "noindex, nofollow" },
  ];
}

/** One file, as a row you can tap: what it is, how much of it there is. */
function DownloadRow({
  href,
  label,
  detail,
  disabled,
}: {
  href: string;
  label: string;
  detail: string;
  disabled?: boolean;
}) {
  const shared =
    "flex items-center justify-between gap-4 rounded-xl border px-4 py-3 text-sm transition";
  if (disabled) {
    return (
      <span className={`${shared} border-trail text-faint`} aria-disabled="true">
        <span>{label}</span>
        <span className="text-xs">{detail}</span>
      </span>
    );
  }
  return (
    <a
      href={href}
      // No <Link>: a client-side navigation would try to make a loader response
      // out of a zip. This is a plain document request, and `download` keeps the
      // browser from replacing the page with the file it just fetched.
      download
      className={`${shared} border-trail text-pine hover:border-pine-soft hover:bg-trail/30 focus-visible:outline-2 focus-visible:outline-pine`}
    >
      <span className="flex items-center gap-2">
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4v11m0 0 4-4m-4 4-4-4" />
          <path d="M5 19h14" />
        </svg>
        {label}
      </span>
      <span className="text-xs text-faint">{detail}</span>
    </a>
  );
}

export default function DownloadsPage({ loaderData, params }: Route.ComponentProps) {
  const { name, days, totalPhotos, daysWithTrack, hasPlan, packItems } = loaderData;
  const locale = useLocale();
  const m = useMessages();
  const file = (day: number | null, kind: "gpx" | "photos" | "plan" | "packing") =>
    `/t/${params.slug}/download/${downloadFileName({ kind, day })}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="border-b border-trail pb-6">
        <Link
          to={`/t/${params.slug}`}
          className="text-sm text-faint underline underline-offset-2 hover:text-pine"
        >
          {m.downloads.back(name)}
        </Link>
        <h1 className="mt-3 font-display text-3xl font-semibold text-pine sm:text-4xl">
          {m.downloads.title}
        </h1>
        <p className="mt-2 text-faint">{m.downloads.intro}</p>
      </header>

      {days.length === 0 && packItems === 0 && (
        <p className="mt-10 text-faint">{m.downloads.empty}</p>
      )}

      {days.length > 0 && (
        <>
          <section className="mt-8">
            <h2 className="font-display text-xl font-semibold text-pine">
              {m.downloads.wholeTrip}
            </h2>
            <div className="mt-3 grid gap-2">
              <DownloadRow
                href={file(null, "gpx")}
                label={m.downloads.tracks}
                detail={m.downloads.daysWithTrack(daysWithTrack)}
                disabled={daysWithTrack === 0}
              />
              <DownloadRow
                href={file(null, "photos")}
                label={m.downloads.photos}
                detail={m.downloads.photoCount(totalPhotos)}
                disabled={totalPhotos === 0}
              />
              {hasPlan && (
                <DownloadRow
                  href={file(null, "plan")}
                  label={m.downloads.plan}
                  detail={m.downloads.planDetail}
                />
              )}
            </div>
            <p className="mt-3 text-xs text-faint">{m.downloads.trackNote}</p>
            {hasPlan && <p className="mt-1 text-xs text-faint">{m.downloads.planNote}</p>}
            <p className="mt-1 text-xs text-faint">{m.downloads.photoNote}</p>
          </section>

          <section className="mt-10">
            <h2 className="font-display text-xl font-semibold text-pine">{m.downloads.perDay}</h2>
            <ul className="mt-3 grid gap-4">
              {days.map((day) => (
                <li key={day.dayNumber} className="border-l-4 pl-4" style={{ borderColor: day.color }}>
                  <p className="text-sm font-bold text-pine">
                    {m.trip.day(day.dayNumber)}
                    <span className="ml-2 font-normal text-faint">
                      {formatDayDate(day.date, locale)}
                      {day.hasTrack && ` · ${day.km.toFixed(day.km < 10 ? 1 : 0)} km`}
                      {day.transitModes.length > 0 &&
                        ` · ${day.transitModes.map((mode) => TRANSIT_NOUNS[locale][mode]).join(", ")}`}
                    </span>
                  </p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <DownloadRow
                      href={file(day.dayNumber, "gpx")}
                      label={m.downloads.tracks}
                      detail={day.hasTrack ? "GPX" : m.downloads.noTrack}
                      disabled={!day.hasTrack}
                    />
                    <DownloadRow
                      href={file(day.dayNumber, "photos")}
                      label={m.downloads.photos}
                      detail={
                        day.photos > 0 ? m.downloads.photoCount(day.photos) : m.downloads.noPhotos
                      }
                      disabled={day.photos === 0}
                    />
                    {hasPlan && (
                      <DownloadRow
                        href={file(day.dayNumber, "plan")}
                        label={m.downloads.planDay}
                        // A day that pedalled nothing has no two ends to cut
                        // the plan between — a rest day, or one spent on a train.
                        detail={
                          day.hasRidden ? m.downloads.planDayDetail : m.downloads.noPlanDay
                        }
                        disabled={!day.hasRidden}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {/* Its own section rather than a row under "the whole trip": a packing
          list exists before the first day does, and belongs to the trip in a
          way a day's photos never are. */}
      {packItems > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-xl font-semibold text-pine">{m.packing.title}</h2>
          <div className="mt-3 grid gap-2">
            <DownloadRow
              href={file(null, "packing")}
              label={m.downloads.packing}
              detail={m.downloads.packingDetail(packItems)}
            />
          </div>
          <p className="mt-3 text-xs text-faint">
            <Link
              to={`/t/${params.slug}/packing`}
              className="underline underline-offset-2 hover:text-pine"
            >
              {m.menu.packing}
            </Link>
          </p>
        </section>
      )}

      <footer className="mt-16 flex flex-wrap items-center justify-between gap-2 border-t border-trail pt-4 text-xs text-faint">
        <span>{m.footer}</span>
        <LanguageSwitcher />
      </footer>
    </main>
  );
}

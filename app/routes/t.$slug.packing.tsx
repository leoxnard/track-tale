import { data, Link } from "react-router";
import type { Route } from "./+types/t.$slug.packing";
import { getTripBySlug } from "../lib/db.server";
import { listPackItems } from "../lib/packing.server";
import { groupByCategory } from "../lib/packing";
import { downloadFileName } from "../lib/downloads";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { resolveLocale } from "../lib/i18n";
import { useMessages } from "../lib/locale";

/**
 * The trip's packing list, the second page hanging off the menu.
 *
 * The one thing on this site that is not a day: it is written before the trip
 * starts and read by whoever is planning their own, which is why it sits beside
 * the download centre rather than under a date. Same authorisation as
 * everything else — knowing the slug is the whole of it.
 *
 * Links are followed at the reader's own risk and told to say so: they point at
 * shops and manufacturers a traveller typed into a chat, so they leave with no
 * referrer and no window handle back to this page.
 */

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolveLocale(request);
  const trip = await getTripBySlug(params.slug);
  if (!trip) throw data("Trip not found", { status: 404 });
  const items = await listPackItems(trip.id);
  // The author is in the row but not on the page: a packing list is the trip's,
  // not a byline, and half the entries being credited reads as an argument.
  return {
    locale,
    name: trip.name,
    // Grouped here rather than in the component: the grouping is the same
    // answer the bot and the CSV give, and it belongs where they get it from.
    groups: groupByCategory(items).map((group) => ({
      category: group.category,
      items: group.items.map(({ id, title, model, url }) => ({ id, title, model, url })),
    })),
    total: items.length,
  };
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [
    { title: loaderData ? `${loaderData.name} — TrackTale` : "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function PackingPage({ loaderData, params }: Route.ComponentProps) {
  const { name, groups, total } = loaderData;
  const m = useMessages();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <header className="border-b border-trail pb-6">
        <Link
          to={`/t/${params.slug}`}
          className="text-sm text-faint underline underline-offset-2 hover:text-pine"
        >
          {m.packing.back(name)}
        </Link>
        <h1 className="mt-3 font-display text-3xl font-semibold text-pine sm:text-4xl">
          {m.packing.title}
        </h1>
        <p className="mt-2 text-faint">{m.packing.intro}</p>
      </header>

      {total === 0 ? (
        <p className="mt-10 text-faint">{m.packing.empty}</p>
      ) : (
        <>
          <p className="mt-8 text-sm text-faint">{m.packing.count(total)}</p>

          {groups.map((group) => (
            <section key={group.category ?? "\u0000"} className="mt-6">
              {/* A list nobody filed gets no heading at all: one heading reading
                  "Everything else" over the whole page says nothing. */}
              {(group.category !== null || groups.length > 1) && (
                <h2 className="font-display text-xl font-semibold text-pine">
                  {group.category ?? m.packing.other}
                </h2>
              )}
              <ul className="mt-3 grid gap-2">
                {group.items.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-trail px-4 py-3"
                  >
                    <span className="font-bold text-pine">{item.title}</span>
                    {item.model && <span className="text-sm text-faint">{item.model}</span>}
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer nofollow"
                        className="w-full text-xs text-pine underline underline-offset-2 hover:text-pine-soft sm:w-auto"
                      >
                        {hostOf(item.url)}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <a
            href={`/t/${params.slug}/download/${downloadFileName({ kind: "packing", day: null })}`}
            // A plain document request, as in the download centre: a client-side
            // navigation would try to make a loader response out of a CSV.
            download
            className="mt-8 inline-flex items-center gap-2 rounded-xl border border-trail px-4 py-3 text-sm text-pine transition hover:border-pine-soft hover:bg-trail/30 focus-visible:outline-2 focus-visible:outline-pine"
          >
            {m.packing.download}
          </a>
        </>
      )}

      <footer className="mt-16 flex flex-wrap items-center justify-between gap-2 border-t border-trail pt-4 text-xs text-faint">
        <span>{m.footer}</span>
        <LanguageSwitcher />
      </footer>
    </main>
  );
}

/**
 * What a link says on the page: the site it goes to, not the whole URL. A
 * product URL is half tracking parameters, and none of that belongs in a row
 * that has to stay one line on a phone.
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

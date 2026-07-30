import { Link } from "react-router";
import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useMessages } from "../lib/locale";
import { getRecentLinks, type RecentLink } from "../lib/recent-links";

export function meta() {
  return [
    { title: "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function Home() {
  const m = useMessages();
  const recentLinks: RecentLink[] = getRecentLinks();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="font-display text-4xl font-semibold text-pine">{m.appName}</h1>
      <p className="max-w-md text-faint">{m.home.intro}</p>

      {recentLinks.length > 0 && (
        <section className="w-full max-w-md mt-8">
          <h2 className="mb-3 text-left font-semibold text-pine">{m.home.recentTrips}</h2>
          <ul className="space-y-2 text-left">
            {recentLinks.map((link) => (
              <li key={link.slug}>
                <Link
                  to={link.url}
                  className="flex items-center justify-between gap-3 rounded-lg border border-trail bg-paper/50 px-3 py-2 text-sm hover:border-pine-soft hover:bg-paper transition"
                >
                  <span className="font-medium text-pine truncate">{link.name}</span>
                  <span className="shrink-0 text-faint">{m.home.continueTrip}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <LanguageSwitcher className="mt-2 text-sm text-faint" />
    </main>
  );
}
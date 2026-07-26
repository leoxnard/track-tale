import { LanguageSwitcher } from "../components/LanguageSwitcher";
import { useMessages } from "../lib/locale";

export function meta() {
  return [
    { title: "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function Home() {
  const m = useMessages();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="font-display text-4xl font-semibold text-pine">{m.appName}</h1>
      <p className="max-w-md text-faint">{m.home.intro}</p>
      <LanguageSwitcher className="mt-2 text-sm text-faint" />
    </main>
  );
}

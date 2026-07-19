export function meta() {
  return [
    { title: "TrackTale" },
    { name: "robots", content: "noindex, nofollow" },
  ];
}

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
      <h1 className="font-display text-4xl font-semibold text-pine">TrackTale</h1>
      <p className="max-w-md text-faint">
        A private trip journal. If someone shared their adventure with you, use the link they sent
        — there's nothing to browse here.
      </p>
    </main>
  );
}

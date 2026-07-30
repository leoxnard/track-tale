const RECENT_TRIPS_KEY = "tt_recent_trips";
const MAX_RECENT_TRIPS = 5;

export function getRecentTrips(): { slug: string; name: string }[] {
  if (typeof window === "undefined") return [];
  try {
    const stored = localStorage.getItem(RECENT_TRIPS_KEY);
    if (!stored) return [];
    const trips: { slug: string; name: string; visitedAt: number }[] = JSON.parse(stored);
    return trips
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, MAX_RECENT_TRIPS)
      .map(({ slug, name }) => ({ slug, name }));
  } catch {
    return [];
  }
}

export function clearRecentTrips(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(RECENT_TRIPS_KEY);
}
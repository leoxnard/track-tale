const STORAGE_KEY = "tt_recent_trips";
const MAX_LINKS = 5;

export interface RecentLink {
  slug: string;
  name: string;
  url: string;
  visitedAt: number;
}

function getStored(): RecentLink[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function setStored(links: RecentLink[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
  } catch {
    // ignore quota errors
  }
}

export function addRecentLink(slug: string, name: string): void {
  const links = getStored();
  const url = `/t/${slug}`;
  const now = Date.now();

  const filtered = links.filter((l) => l.slug !== slug);
  filtered.unshift({ slug, name, url, visitedAt: now });
  setStored(filtered.slice(0, MAX_LINKS));
}

export function getRecentLinks(): RecentLink[] {
  const stored = getStored();
  // Ensure url is present for older entries
  return stored.map((link) => ({
    ...link,
    url: link.url ?? `/t/${link.slug}`,
  }));
}

export function clearRecentLinks(): void {
  setStored([]);
}
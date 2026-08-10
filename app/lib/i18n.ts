/**
 * Two languages, no dependency. The viewer is read by whoever the traveller
 * shared the link with — often family who read German more comfortably than
 * English — so the page picks its language from the browser and remembers a
 * manual choice in a cookie.
 *
 * Dictionaries are plain objects and anything with a number in it is a
 * function, which keeps plurals and word order in the translation instead of
 * spread across the components.
 */

import type { TransitMode } from "./transport";

export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** What to call each language, in that language. */
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", de: "Deutsch" };

/** BCP-47 tags for Intl — the trip dates were always formatted British-style. */
const INTL_TAGS: Record<Locale, string> = { en: "en-GB", de: "de-DE" };

export const LANG_COOKIE = "lang";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function intlTag(locale: Locale): string {
  return INTL_TAGS[locale];
}

export function langCookie(locale: Locale): string {
  return `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax`;
}

function localeFromCookie(header: string | null): Locale | null {
  for (const part of header?.split(";") ?? []) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LANG_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return isLocale(value) ? value : null;
    }
  }
  return null;
}

/** First language the browser asks for that we actually have, honouring q-weights. */
function localeFromAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  const wanted = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      return { tag: tag.trim().toLowerCase(), q: q === undefined ? 1 : Number(q) || 0 };
    })
    .filter((w) => w.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of wanted) {
    const base = tag.split("-")[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/** A chosen language wins over the browser's, which wins over English. */
export function resolveLocale(request: Request): Locale {
  return (
    localeFromCookie(request.headers.get("cookie")) ??
    localeFromAcceptLanguage(request.headers.get("accept-language")) ??
    DEFAULT_LOCALE
  );
}

/**
 * What each way of travelling is called, and what it looks like.
 *
 * The glyph is the same one the bot replies with and the one dropped into the
 * gap the leg left in the tour profile, so a train is a train wherever it
 * turns up.
 */
export const TRANSIT_NOUNS: Record<Locale, Record<TransitMode, string>> = {
  en: { train: "train", ferry: "ferry", bus: "bus" },
  de: { train: "Zug", ferry: "Fähre", bus: "Bus" },
};

export const TRANSIT_GLYPHS: Record<TransitMode, string> = {
  train: "🚆",
  ferry: "⛴️",
  bus: "🚌",
};

const en = {
  appName: "TrackTale",
  footer: "Followed with TrackTale — a private trip journal.",
  home: {
    intro:
      "A private trip journal. If someone shared their adventure with you, use the link they sent — there's nothing to browse here.",
    recentTrips: "Recent trips",
    continueTrip: "Continue this trip →",
  },
  language: {
    label: "Language",
  },
  error: {
    oops: "Oops!",
    generic: "Error",
    unexpected: "An unexpected error occurred.",
    notFound: "The requested page could not be found.",
  },
  /** `3h 20m`, the compact form used in stat lines. */
  duration: (h: number, m: number) => (h > 0 ? `${h}h ${m}m` : `${m}m`),
  trip: {
    since: (date: string) => `since ${date}`,
    climbed: (m: string) => `${m} m climbed`,
    days: (n: number) => `${n} ${n === 1 ? "day" : "days"}`,
    live: (km: string, duration: string | null) =>
      duration ? `Live — ${km} km · ${duration}` : `Live — ${km} km`,
    liveFollow: "Live now — follow along",
    liveNow: "Live now",
    liveNowHint: "Zoom the map to where they are right now",
    livePosition: "Live position",
    progress: (done: string, total: string, pct: number) => `${done} of ${total} km · ${pct}%`,
    notStarted: "The journey hasn't started yet — check back soon.",
    loadingMap: "Loading map…",
    wholeTour: "Whole tour",
    wholeTourHint: "Zoom the map back out and jump to the whole-tour profile",
    day: (n: number) => `Day ${n}`,
    /** Dropped on narrow screens, where only the day's number is shown. */
    dayPrefix: "Day ",
    focusDay: "Focus the map on this day",
    inMotion: (duration: string) => `${duration} in motion`,
    soFar: " so far",
    moving: (duration: string) => `${duration} moving`,
    /** Kilometres travelled rather than ridden — `132 km by train`. */
    transit: (km: string, modes: TransitMode[]) =>
      `${km} km by ${modes.map((mode) => TRANSIT_NOUNS.en[mode]).join(" + ") || "transport"}`,
    segments: (n: number) => `${n} segments`,
    photo: "Photo",
    photoAlt: (day: number) => `Day ${day} photo`,
  },
  lightbox: {
    label: "Photos",
    open: (day: number) => `Open day ${day} photo full size`,
    close: "Close",
    previous: "Previous photo",
    next: "Next photo",
    position: (n: number, total: number) => `${n} of ${total}`,
    hint: "Arrow keys to browse, Esc to close",
    openOriginal: "Open the original",
  },
  guestbook: {
    yourName: "Your name",
    yourNameFor: (day: number) => `Your name, day ${day}`,
    messagePlaceholder: (day: number) => `Say something about day ${day}…`,
    messageFor: (day: number) => `Message for day ${day}`,
    sending: "Sending…",
    send: "Send",
    leaveMessage: (day: number) => `Leave a message for day ${day}`,
    sent: "Sent — they'll see it on the road.",
    errors: {
      noName: "Add your name so they know who wrote it.",
      noText: "Write a message first.",
      noTrip: "This trip no longer exists.",
      noDay: "That day isn't part of the trip.",
      tooMany: "That's a lot of messages at once — try again in a minute.",
      saveFailed: "Could not save your message.",
    },
  },
  traveler: {
    /** Wrapped around the traveller's name; whichever part is empty is skipped. */
    journeys: { before: "", after: "’s journeys" },
    daysOnRoad: (n: number) => `${n} days on the road`,
    trips: (n: number) => `${n} ${n === 1 ? "trip" : "trips"}`,
    noTrips: "No trips to show yet — the first one is being planned.",
  },
  profile: {
    title: "The whole tour",
    planned: "planned",
    ridden: (km: string) => `${km} km ridden`,
    aria: (ridden: string, planned: string) =>
      `Elevation of the whole tour: ${ridden} of ${planned} kilometres ridden`,
    day: (n: number) => `day ${n}`,
    /** Sits on the gap a train left in the line: `by train — not ridden`. */
    skipped: (mode: TransitMode) => `by ${TRANSIT_NOUNS.en[mode]} — not ridden`,
    tapToJump: "tap to jump to that day",
    alongRoute: (from: string, to: string) => `${from} – ${to} km along the planned route`,
    dragToZoom: "drag across to zoom · ",
    dragHandles: "drag the handles to zoom",
    brushLabel: "Stretch of the tour on screen",
  },
  elevation: {
    aria: (min: number, max: number, km: string) =>
      `Elevation profile: ${min} to ${max} metres over ${km} kilometres`,
    dragAlong: "drag along the line to follow the route",
    resetZoom: "Reset zoom",
  },
  brush: {
    zoomRange: "Zoom range",
    rangeStart: "Range start",
    rangeEnd: "Range end",
  },
  weather: {
    clear: "Clear",
    mostlyClear: "Mostly clear",
    partlyCloudy: "Partly cloudy",
    overcast: "Overcast",
    fog: "Fog",
    drizzle: "Drizzle",
    rain: "Rain",
    snow: "Snow",
    showers: "Showers",
    thunderstorm: "Thunderstorm",
  },
};

/** English is the source of truth for the shape; `as const` is left off so the
 *  German dictionary is checked against `string`, not against each literal. */
export type Messages = typeof en;

/** Same shape as the English dictionary, so a missing key is a type error. */
const de: Messages = {
  appName: "TrackTale",
  footer: "Begleitet mit TrackTale — ein privates Reisetagebuch.",
  home: {
    intro:
      "Ein privates Reisetagebuch. Wenn jemand seine Reise mit dir geteilt hat, benutze den Link, den du bekommen hast — hier gibt es nichts zu entdecken.",
    recentTrips: "Zuletzt besuchte Reisen",
    continueTrip: "Reise fortsetzen →",
  },
  language: {
    label: "Sprache",
  },
  error: {
    oops: "Hoppla!",
    generic: "Fehler",
    unexpected: "Ein unerwarteter Fehler ist aufgetreten.",
    notFound: "Die angeforderte Seite wurde nicht gefunden.",
  },
  duration: (h: number, m: number) => (h > 0 ? `${h} h ${m} min` : `${m} min`),
  trip: {
    since: (date: string) => `seit ${date}`,
    climbed: (m: string) => `${m} m Aufstieg`,
    days: (n: number) => `${n} ${n === 1 ? "Tag" : "Tage"}`,
    live: (km: string, duration: string | null) =>
      duration ? `Live — ${km} km · ${duration}` : `Live — ${km} km`,
    liveFollow: "Jetzt live — sei dabei",
    liveNow: "Jetzt live",
    liveNowHint: "Karte auf die aktuelle Position zoomen",
    livePosition: "Live-Position",
    progress: (done: string, total: string, pct: number) => `${done} von ${total} km · ${pct} %`,
    notStarted: "Die Reise hat noch nicht begonnen — schau bald wieder vorbei.",
    loadingMap: "Karte wird geladen…",
    wholeTour: "Ganze Tour",
    wholeTourHint: "Karte wieder herauszoomen und zum Profil der ganzen Tour springen",
    day: (n: number) => `Tag ${n}`,
    dayPrefix: "Tag ",
    focusDay: "Karte auf diesen Tag ausrichten",
    inMotion: (duration: string) => `${duration} in Bewegung`,
    soFar: " bisher",
    moving: (duration: string) => `${duration} unterwegs`,
    transit: (km: string, modes: TransitMode[]) =>
      `${km} km per ${modes.map((mode) => TRANSIT_NOUNS.de[mode]).join(" + ") || "Verkehrsmittel"}`,
    segments: (n: number) => `${n} Abschnitte`,
    photo: "Foto",
    photoAlt: (day: number) => `Foto von Tag ${day}`,
  },
  lightbox: {
    label: "Fotos",
    open: (day: number) => `Foto von Tag ${day} groß öffnen`,
    close: "Schließen",
    previous: "Vorheriges Foto",
    next: "Nächstes Foto",
    position: (n: number, total: number) => `${n} von ${total}`,
    hint: "Pfeiltasten zum Blättern, Esc zum Schließen",
    openOriginal: "Original öffnen",
  },
  guestbook: {
    yourName: "Dein Name",
    yourNameFor: (day: number) => `Dein Name, Tag ${day}`,
    messagePlaceholder: (day: number) => `Schreib etwas zu Tag ${day}…`,
    messageFor: (day: number) => `Nachricht zu Tag ${day}`,
    sending: "Wird gesendet…",
    send: "Senden",
    leaveMessage: (day: number) => `Hinterlasse eine Nachricht zu Tag ${day}`,
    sent: "Gesendet — sie lesen es unterwegs.",
    errors: {
      noName: "Schreib deinen Namen dazu, damit sie wissen, von wem die Nachricht ist.",
      noText: "Schreib zuerst eine Nachricht.",
      noTrip: "Diese Reise gibt es nicht mehr.",
      noDay: "Dieser Tag gehört nicht zur Reise.",
      tooMany: "Das sind viele Nachrichten auf einmal — versuch es in einer Minute nochmal.",
      saveFailed: "Deine Nachricht konnte nicht gespeichert werden.",
    },
  },
  traveler: {
    journeys: { before: "Reisen von ", after: "" },
    daysOnRoad: (n: number) => `${n} Tage unterwegs`,
    trips: (n: number) => `${n} ${n === 1 ? "Reise" : "Reisen"}`,
    noTrips: "Noch keine Reisen — die erste wird gerade geplant.",
  },
  profile: {
    title: "Die ganze Tour",
    planned: "geplant",
    ridden: (km: string) => `${km} km gefahren`,
    aria: (ridden: string, planned: string) =>
      `Höhenprofil der ganzen Tour: ${ridden} von ${planned} Kilometern gefahren`,
    day: (n: number) => `Tag ${n}`,
    skipped: (mode: TransitMode) => `per ${TRANSIT_NOUNS.de[mode]} — nicht geradelt`,
    tapToJump: "antippen, um zu diesem Tag zu springen",
    alongRoute: (from: string, to: string) => `${from} – ${to} km entlang der geplanten Route`,
    dragToZoom: "ziehen zum Zoomen · ",
    dragHandles: "Regler ziehen zum Zoomen",
    brushLabel: "Ausschnitt der Tour auf dem Bildschirm",
  },
  elevation: {
    aria: (min: number, max: number, km: string) =>
      `Höhenprofil: ${min} bis ${max} Meter über ${km} Kilometer`,
    dragAlong: "der Linie folgen, um die Route zu verfolgen",
    resetZoom: "Zoom zurücksetzen",
  },
  brush: {
    zoomRange: "Zoombereich",
    rangeStart: "Bereichsanfang",
    rangeEnd: "Bereichsende",
  },
  weather: {
    clear: "Klar",
    mostlyClear: "Meist klar",
    partlyCloudy: "Teils wolkig",
    overcast: "Bedeckt",
    fog: "Nebel",
    drizzle: "Nieselregen",
    rain: "Regen",
    snow: "Schnee",
    showers: "Schauer",
    thunderstorm: "Gewitter",
  },
};

const DICTIONARIES: Record<Locale, Messages> = { en, de };

export function messages(locale: Locale): Messages {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/** `3h 20m` / `3 h 20 min` from a raw number of seconds. */
export function formatDuration(seconds: number, locale: Locale): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return messages(locale).duration(h, m);
}

/** A year ago today, so a date from an older trip carries its year and isn't mistaken for this year's. */
function isAtLeastAYearAgo(date: Date): boolean {
  const aYearAgo = new Date();
  aYearAgo.setFullYear(aYearAgo.getFullYear() - 1);
  return date <= aYearAgo;
}

export function formatDayDate(iso: string, locale: Locale): string {
  const date = new Date(iso + "T00:00:00");
  return date.toLocaleDateString(intlTag(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: isAtLeastAYearAgo(date) ? "numeric" : undefined,
  });
}

export function formatShortDate(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleDateString(intlTag(locale), { day: "numeric", month: "short" });
}

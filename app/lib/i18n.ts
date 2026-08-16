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
 * What each way of travelling is called. What it *looks* like is in
 * lib/vehicle-art now — the page draws its own train rather than borrowing a
 * different one from every browser's emoji font.
 */
export const TRANSIT_NOUNS: Record<Locale, Record<TransitMode, string>> = {
  en: { train: "train", ferry: "ferry", bus: "bus" },
  de: { train: "Zug", ferry: "Fähre", bus: "Bus" },
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
  share: {
    /** Both the button's name and its tooltip — it has no visible text. */
    label: "Share",
    copied: "Link copied",
  },
  menu: {
    /** Like the share button, a glyph on screen and the words only here. */
    label: "Menu",
    downloads: "Download centre",
    packing: "Packing list",
  },
  packing: {
    title: "Packing list",
    intro: "What went along — and, where it matters, exactly which one.",
    back: (name: string) => `← Back to ${name}`,
    count: (n: number) => `${n} ${n === 1 ? "thing" : "things"}`,
    /** The heading over the things that were never filed anywhere. */
    other: "Everything else",
    download: "Download as CSV",
    empty: "Nothing has been packed on this trip yet.",
  },
  downloads: {
    title: "Download centre",
    intro: "Take the trip with you — the tracks as GPX, the pictures as a zip.",
    back: (name: string) => `← Back to ${name}`,
    wholeTrip: "The whole trip",
    perDay: "Day by day",
    tracks: "Tracks (GPX)",
    photos: "Photos (ZIP)",
    plan: "Planned route (GPX)",
    planDetail: "the whole tour",
    /** The day's share of the plan, which is not the day's ride. */
    planDay: "Planned route (GPX)",
    planDayDetail: "this day's stretch",
    noPlanDay: "not on the plan",
    daysWithTrack: (n: number) => `${n} ${n === 1 ? "day" : "days"} with a track`,
    photoCount: (n: number) => `${n} ${n === 1 ? "photo" : "photos"}`,
    noTrack: "no track",
    noPhotos: "no photos",
    empty: "There is nothing on this trip to download yet.",
    /**
     * Said plainly rather than left to be discovered: what is stored is a
     * screen-sized copy of anything the bot had to compress, and no amount of
     * downloading brings back a camera original that never reached us.
     */
    photoNote:
      "Photos come as they are stored: the untouched file for anything sent as a document, a 2048 px copy for the rest. A Live Photo's motion travels beside its still.",
    trackNote:
      "The tracks come as they were recorded, at full resolution, rather than as the line the map is drawn from. Each day is its own track in the file, and a leg taken by train, ferry or bus is one of its own — so nothing counts kilometres nobody rode. A day uploaded before the recordings were kept comes as the map draws it.",
    /**
     * Worth its own sentence: this is the one file here that is not the page's
     * own line written out, and a reader importing it will notice the
     * difference in bends the moment a device tries to match it to a road.
     */
    planNote:
      "The planned route comes as it was imported, at full resolution — not the thinned copy the map is drawn from. A day's own stretch of it is cut from where that day's riding began to where it stopped, so the shopping trips and wrong turnings the ride took are not in it. A plan imported before the originals were kept falls back to the thinned copy until its next refresh.",
    tooLarge: "Too much to pack in one go — take the days one at a time instead.",
    packing: "Packing list (CSV)",
    packingDetail: (n: number) => `${n} ${n === 1 ? "thing" : "things"}`,
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
    /**
     * How far along the planned route the journey has got — position, not
     * distance ridden, which is on the page too and is a different number.
     */
    progress: (done: string, total: string, pct: number) =>
      `${done} of ${total} km along the route · ${pct}%`,
    notStarted: "The journey hasn't started yet — check back soon.",
    loadingMap: "Loading map…",
    wholeTour: "Whole tour",
    wholeTourHint: "Zoom the map back out and jump to the whole-tour profile",
    cycleRoutes: "Cycle routes",
    cycleRoutesHint: "Show signposted cycle routes — EuroVelo, national and regional",
    windOverlay: "Wind",
    windOverlayHint: "Show the wind that was blowing along the route, hour by hour",
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
    live: "Live",
    livePlay: "Play the live photo",
    liveHint: "Hold to play",
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
  wind: {
    title: "Wind on the road",
    /** 16-point compass, north first, clockwise — the order `sectorOf` counts in. */
    points: ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
    verdicts: {
      headwind: "Into the wind",
      tailwind: "Wind at your back",
      crosswind: "Wind from the side",
      calm: "Barely a breath",
    },
    average: (kmh: number, from: string) => `${kmh} km/h out of the ${from}`,
    gusts: (kmh: number) => `gusts ${kmh}`,
    /** The wind left over along the route once the sideways part is taken out. */
    net: (kmh: number, inTheFace: boolean) => `${kmh} ${inTheFace ? "in the face" : "from behind"}`,
    legs: {
      against: (km: string) => `${km} km against`,
      across: (km: string) => `${km} km across`,
      with: (km: string) => `${km} km with`,
    },
    scale: "km/h:",
    expand: "Show the day's wind in full",
    /** The tooltip on the little arrow in a day's weather line. The angle is
     *  the rider's, the compass point is the map's; the arrow draws the first. */
    chip: (kmh: number, angle: string, from: string) =>
      `${kmh} km/h ${angle}, out of the ${from} — tap for the rose`,
    chipScattered: (kmh: number, from: string) =>
      `${kmh} km/h from every side, out of the ${from} on balance — tap for the rose`,
    axis: "Kilometres ridden with the wind at that angle to the rider",
    coverage: (percent: number) => `From the ${percent}% of the riding that carried a clock`,
    /** The four quarters of the rose, which is drawn around the rider: up is
     *  wherever they were heading at the time, not north. */
    around: ["ahead", "right", "behind", "left"],
    /** Eight-point naming for one petal, clockwise from straight ahead. */
    relative: [
      "head on",
      "ahead on the right",
      "from the right",
      "behind on the right",
      "from behind",
      "behind on the left",
      "from the left",
      "ahead on the left",
    ],
    petal: (km: string, angle: string, kmh: number) =>
      `${km} km with the wind ${angle} at ${kmh} km/h`,
    aria: (verdict: string, kmh: number, from: string) =>
      `${verdict}: ${kmh} km/h on average, out of the ${from}. The rose is drawn around the rider — up is the direction of travel, so petals at the top are wind in the face.`,
  },
  riding: {
    /** Wraps the weather word so the line says these are the hours ridden. */
    whileRiding: (weather: string) => `${weather} — while riding`,
    mean: (c: number) => `${c}°C on average`,
    /** The x-axis is the ride, not a clock: the trip's timezone isn't on the page. */
    overHours: (n: number) => `across ${n} ${n === 1 ? "hour" : "hours"} of riding`,
    tempAria: (lo: number, hi: number) => `Temperature while riding, ${lo} to ${hi}°C`,
    tempChip: (c: number) => `${c}°C on average while riding — tap for the day's curve`,
    rainChip: "Rain while riding — tap for the detail",
    onTheRider: "fell on the rider",
    dayTotal: (mm: string) => `${mm} mm fell that day in all`,
    wetKm: (km: string) => `${km} km in the rain`,
    dryKm: (km: string) => `${km} km dry`,
    heaviest: (mmh: string) => `Heaviest hour: ${mmh} mm/h`,
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
  share: {
    label: "Teilen",
    copied: "Link kopiert",
  },
  menu: {
    label: "Menü",
    downloads: "Download-Center",
    packing: "Packliste",
  },
  packing: {
    title: "Packliste",
    intro: "Was mitgekommen ist — und, wo es darauf ankommt, genau welches.",
    back: (name: string) => `← Zurück zu ${name}`,
    count: (n: number) => `${n} ${n === 1 ? "Sache" : "Sachen"}`,
    other: "Alles Übrige",
    download: "Als CSV herunterladen",
    empty: "Auf dieser Reise wurde noch nichts eingepackt.",
  },
  downloads: {
    title: "Download-Center",
    intro: "Nimm die Reise mit — die Tracks als GPX, die Bilder als ZIP.",
    back: (name: string) => `← Zurück zu ${name}`,
    wholeTrip: "Die ganze Reise",
    perDay: "Tag für Tag",
    tracks: "Tracks (GPX)",
    photos: "Fotos (ZIP)",
    plan: "Geplante Route (GPX)",
    planDetail: "die ganze Tour",
    planDay: "Geplante Route (GPX)",
    planDayDetail: "die Etappe dieses Tages",
    noPlanDay: "nicht auf der Route",
    daysWithTrack: (n: number) => `${n} ${n === 1 ? "Tag" : "Tage"} mit Track`,
    photoCount: (n: number) => `${n} ${n === 1 ? "Foto" : "Fotos"}`,
    noTrack: "kein Track",
    noPhotos: "keine Fotos",
    empty: "Auf dieser Reise gibt es noch nichts zum Herunterladen.",
    photoNote:
      "Die Fotos kommen so, wie sie gespeichert sind: die unveränderte Datei bei allem, was als Datei geschickt wurde, sonst eine 2048-px-Kopie. Die Bewegung eines Live Photos liegt neben seinem Standbild.",
    trackNote:
      "Die Tracks kommen so, wie sie aufgezeichnet wurden, in voller Auflösung — nicht als die Linie, aus der die Karte gezeichnet wird. Jeder Tag ist ein eigener Track in der Datei, und eine Etappe mit Zug, Fähre oder Bus noch einmal ein eigener — so zählt niemand Kilometer mit, die keiner gefahren ist. Ein Tag, der vor dem Aufheben der Aufzeichnungen hochgeladen wurde, kommt so, wie die Karte ihn zeichnet.",
    planNote:
      "Die geplante Route kommt so, wie sie importiert wurde, in voller Auflösung — nicht als die gedünnte Kopie, aus der die Karte gezeichnet wird. Die Etappe eines Tages wird von dort, wo die Fahrt begann, bis dorthin, wo sie endete, herausgeschnitten — Einkaufswege und falsche Abbiegungen sind also nicht darin. Ein Plan, der vor dem Aufheben der Originale importiert wurde, fällt bis zur nächsten Aktualisierung auf die gedünnte Kopie zurück.",
    tooLarge: "Zu viel für ein Paket — lade die Tage einzeln herunter.",
    packing: "Packliste (CSV)",
    packingDetail: (n: number) => `${n} ${n === 1 ? "Sache" : "Sachen"}`,
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
    progress: (done: string, total: string, pct: number) =>
      `${done} von ${total} km der Route · ${pct} %`,
    notStarted: "Die Reise hat noch nicht begonnen — schau bald wieder vorbei.",
    loadingMap: "Karte wird geladen…",
    wholeTour: "Ganze Tour",
    wholeTourHint: "Karte wieder herauszoomen und zum Profil der ganzen Tour springen",
    cycleRoutes: "Radrouten",
    cycleRoutesHint: "Ausgeschilderte Radrouten einblenden — EuroVelo, nationale und regionale",
    windOverlay: "Wind",
    windOverlayHint: "Den Wind einblenden, der unterwegs wehte — Stunde für Stunde",
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
    live: "Live",
    livePlay: "Live-Foto abspielen",
    liveHint: "Gedrückt halten zum Abspielen",
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
  wind: {
    title: "Wind unterwegs",
    points: ["N", "NNO", "NO", "ONO", "O", "OSO", "SO", "SSO", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"],
    verdicts: {
      headwind: "Gegenwind",
      tailwind: "Rückenwind",
      crosswind: "Seitenwind",
      calm: "Kaum ein Lüftchen",
    },
    average: (kmh: number, from: string) => `${kmh} km/h aus ${from}`,
    gusts: (kmh: number) => `Böen ${kmh}`,
    net: (kmh: number, inTheFace: boolean) => `${kmh} ${inTheFace ? "von vorn" : "von hinten"}`,
    legs: {
      against: (km: string) => `${km} km dagegen`,
      across: (km: string) => `${km} km quer`,
      with: (km: string) => `${km} km damit`,
    },
    scale: "km/h:",
    expand: "Den Wind des Tages ausklappen",
    chip: (kmh: number, angle: string, from: string) =>
      `${kmh} km/h ${angle}, aus ${from} — für die Rose antippen`,
    chipScattered: (kmh: number, from: string) =>
      `${kmh} km/h aus allen Richtungen, im Mittel aus ${from} — für die Rose antippen`,
    axis: "Gefahrene Kilometer mit Wind aus diesem Winkel zur Fahrtrichtung",
    coverage: (percent: number) => `Aus den ${percent}% der Fahrt mit Zeitstempel`,
    around: ["vorn", "rechts", "hinten", "links"],
    relative: [
      "direkt von vorn",
      "von schräg vorn rechts",
      "von rechts",
      "von schräg hinten rechts",
      "von hinten",
      "von schräg hinten links",
      "von links",
      "von schräg vorn links",
    ],
    petal: (km: string, angle: string, kmh: number) =>
      `${km} km mit Wind ${angle} mit ${kmh} km/h`,
    aria: (verdict: string, kmh: number, from: string) =>
      `${verdict}: ${kmh} km/h im Schnitt aus ${from}. Die Rose ist um die Fahrerin gezeichnet — oben ist die Fahrtrichtung, Blüten oben sind also Wind ins Gesicht.`,
  },
  riding: {
    whileRiding: (weather: string) => `${weather} — während der Fahrt`,
    mean: (c: number) => `im Schnitt ${c}°C`,
    overHours: (n: number) => `über ${n} ${n === 1 ? "Fahrstunde" : "Fahrstunden"}`,
    tempAria: (lo: number, hi: number) => `Temperatur unterwegs, ${lo} bis ${hi}°C`,
    tempChip: (c: number) => `im Schnitt ${c}°C unterwegs — für den Verlauf antippen`,
    rainChip: "Regen unterwegs — für Details antippen",
    onTheRider: "sind auf dich gefallen",
    dayTotal: (mm: string) => `am ganzen Tag fielen ${mm} mm`,
    wetKm: (km: string) => `${km} km im Regen`,
    dryKm: (km: string) => `${km} km trocken`,
    heaviest: (mmh: string) => `Stärkste Stunde: ${mmh} mm/h`,
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

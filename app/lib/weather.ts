import { DEFAULT_LOCALE, messages, type Locale, type Messages } from "./i18n";

/**
 * The day's weather, hour by hour, as it was where the route ran.
 *
 * Kept as three parallel arrays rather than 24 little objects because it is
 * stored as JSON in `weather_cache.data` and read back on every page render —
 * the flat shape is a third of the bytes and needs no mapping to use.
 *
 * `fromDeg` follows the meteorological convention the API uses: the direction
 * the wind blows *from*, clockwise from north. A westerly is 270 and pushes you
 * east. Getting this backwards turns every headwind into a tailwind, which is
 * exactly the kind of mistake nobody notices until a rider disagrees with the
 * page.
 */
export interface HourlyWeather {
  /** Epoch milliseconds, one per hour, ascending. */
  time: number[];
  /** Wind speed at 10 m, km/h. */
  speedKmh: (number | null)[];
  /** Direction the wind comes from, degrees clockwise from north. */
  fromDeg: (number | null)[];
  /** Gusts at 10 m, km/h. */
  gustKmh: (number | null)[];
  /** Air temperature at 2 m, °C — an instant, so it may be interpolated. */
  tempC: (number | null)[];
  /**
   * Rain in that hour, mm. An **accumulation over the preceding hour**, not a
   * reading at the stamp: the entry at 14:00 is what fell between 13:00 and
   * 14:00. It must never be interpolated the way temperature and wind are —
   * halfway between two hours is not halfway between two totals, it is simply
   * inside the later bucket.
   */
  precipMm: (number | null)[];
}

export interface LatLng {
  lat: number;
  lng: number;
}

/** One place the weather was asked about, and what it did there all day. */
export interface WeatherSite extends LatLng {
  hourly: HourlyWeather;
}

export interface DayWeather {
  tempMaxC: number | null;
  tempMinC: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
  /** The day's prevailing wind direction, as the API summarises it. */
  windFromDeg?: number | null;
  /**
   * The wind at the *middle* of the route, kept for rows cached before the day
   * was sampled in several places — and as the fallback when a day only ever
   * had the one site. `/refreshweather` upgrades an old row to `windSites`.
   */
  hourlyWind?: HourlyWeather | null;
  /**
   * The wind along the route, one entry per place it was asked about.
   *
   * A hundred-kilometre day does not have *a* wind. Asking at the midpoint and
   * calling it the day was the first version, and on a long stage — or anywhere
   * a range or a coast sits between morning and evening — it answered for
   * ground the rider had left hours earlier.
   */
  windSites?: WeatherSite[];
}

interface DailyResponse {
  daily?: {
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_sum?: (number | null)[];
    wind_speed_10m_max?: (number | null)[];
    wind_direction_10m_dominant?: (number | null)[];
    weather_code?: (number | null)[];
  };
  hourly?: {
    time?: number[];
    wind_speed_10m?: (number | null)[];
    wind_direction_10m?: (number | null)[];
    wind_gusts_10m?: (number | null)[];
    temperature_2m?: (number | null)[];
    precipitation?: (number | null)[];
  };
}

async function fetchDaily(
  endpoint: string,
  sites: LatLng[],
  isoDate: string,
): Promise<DailyResponse[] | null> {
  const url = new URL(endpoint);
  // Open-Meteo answers for a list of coordinates in one request and replies with
  // one object per site, in order. Four sites along a day's route therefore cost
  // exactly what one used to.
  url.searchParams.set("latitude", sites.map((s) => s.lat).join(","));
  url.searchParams.set("longitude", sites.map((s) => s.lng).join(","));
  url.searchParams.set("start_date", isoDate);
  url.searchParams.set("end_date", isoDate);
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,weather_code",
  );
  // Temperature and rain ride along with the wind at no extra cost: same
  // request, same sites every 10 km. What they buy is the difference between
  // "8 mm fell that calendar day somewhere near the route" and "8 mm fell on
  // the rider" — a night of rain that stopped before breakfast is the single
  // most misleading thing a daily total can say.
  url.searchParams.set(
    "hourly",
    "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation",
  );
  url.searchParams.set("timezone", "auto");
  // `auto` keeps the daily figures bounded by the *local* day, which is what a
  // max temperature should mean — but it would also hand back hourly stamps as
  // wall-clock strings with no offset attached, and matching those against a
  // track's epoch timestamps needs the offset. Unix time sidesteps the whole
  // question: the daily aggregation stays local, the hourly stamps are absolute.
  url.searchParams.set("timeformat", "unixtime");

  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as DailyResponse | DailyResponse[];
  // A single coordinate still comes back as a bare object rather than a list of
  // one, so both shapes have to be accepted.
  const all = Array.isArray(body) ? body : [body];
  // A day inside the window has every array populated; one it doesn't cover
  // comes back with the arrays present but full of nulls.
  return all[0]?.daily?.temperature_2m_max?.[0] != null ? all : null;
}

/** Only worth storing if at least one hour actually has a wind in it. */
function toHourlyWind(hourly: DailyResponse["hourly"]): HourlyWeather | null {
  const time = hourly?.time;
  if (!time || time.length === 0) return null;
  const speedKmh = hourly.wind_speed_10m ?? [];
  const fromDeg = hourly.wind_direction_10m ?? [];
  const gustKmh = hourly.wind_gusts_10m ?? [];
  if (!speedKmh.some((v) => v != null) || !fromDeg.some((v) => v != null)) return null;
  return {
    time: time.map((s) => s * 1000),
    speedKmh: time.map((_, i) => speedKmh[i] ?? null),
    fromDeg: time.map((_, i) => fromDeg[i] ?? null),
    gustKmh: time.map((_, i) => gustKmh[i] ?? null),
    tempC: time.map((_, i) => hourly.temperature_2m?.[i] ?? null),
    precipMm: time.map((_, i) => hourly.precipitation?.[i] ?? null),
  };
}

const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
/** ERA5 reanalysis — what the weather actually did, going back decades. */
const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";

/** The archive trails real time by roughly this much; only the forecast API has fresher days. */
const ARCHIVE_LAG_DAYS = 5;

/**
 * Daily weather at a point for one date. Free, no API key.
 *
 * Which endpoint is right depends entirely on how old the day is. The forecast
 * API keeps only a short rolling window either side of today, so it is the one
 * that can answer for a trip happening right now — but for anything older it
 * either has nothing or is still serving a *forecast* of a day that has long
 * since happened. The archive holds measured reanalysis data instead, which is
 * what an imported past tour wants, and it lags a few days behind.
 *
 * So pick by age and keep the other as a fallback: neither covers the whole
 * range alone, and the handover between them is not a sharp line.
 */
export async function fetchDayWeather(
  sites: LatLng[],
  isoDate: string,
): Promise<DayWeather | null> {
  if (sites.length === 0) return null;
  const ageDays = (Date.now() - Date.parse(isoDate + "T00:00:00Z")) / 86400000;
  const order =
    ageDays > ARCHIVE_LAG_DAYS ? [ARCHIVE_API, FORECAST_API] : [FORECAST_API, ARCHIVE_API];

  const fromEither = async (want: LatLng[]) => {
    for (const endpoint of order) {
      const res = await fetchDaily(endpoint, want, isoDate);
      if (res) return res;
    }
    return null;
  };

  // A long day asks about two dozen places at once. If that is ever refused —
  // a limit on how many coordinates one request may carry, a URL grown too
  // long — the day should lose its wind detail, not its temperature: falling
  // back to the middle alone is exactly what this used to do for every day.
  const all = (await fromEither(sites)) ?? (sites.length > 1 ? await fromEither(sites.slice(0, 1)) : null);
  if (!all) return null;
  // The day's temperature, rain and icon stay one number for the day, taken at
  // the site the caller put first — spreading those over the route would only
  // raise the question of which one the day card should show.
  const res = all[0];
  const d = res.daily!;
  return {
    tempMaxC: d.temperature_2m_max?.[0] ?? null,
    tempMinC: d.temperature_2m_min?.[0] ?? null,
    precipitationMm: d.precipitation_sum?.[0] ?? null,
    windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
    windFromDeg: d.wind_direction_10m_dominant?.[0] ?? null,
    weatherCode: d.weather_code?.[0] ?? null,
    hourlyWind: toHourlyWind(res.hourly),
    // Just the coordinates: the sample sites arrive as track points, and an
    // altitude and a timestamp per site would be stored on every day and
    // shipped to every reader for nothing.
    windSites: all
      .map((site, i) => ({
        lat: sites[i].lat,
        lng: sites[i].lng,
        hourly: toHourlyWind(site.hourly),
      }))
      .filter((site): site is WeatherSite => site.hourly !== null),
  };
}

type WeatherName = keyof Messages["weather"];

/** WMO code floor, emoji, and the key its wording lives under. */
const WEATHER_ICONS: [number, string, WeatherName][] = [
  [0, "☀️", "clear"],
  [1, "🌤️", "mostlyClear"],
  [2, "⛅", "partlyCloudy"],
  [3, "☁️", "overcast"],
  [45, "🌫️", "fog"],
  [51, "🌦️", "drizzle"],
  [61, "🌧️", "rain"],
  [71, "🌨️", "snow"],
  [80, "🌧️", "showers"],
  [95, "⛈️", "thunderstorm"],
];

export function weatherIcon(
  code: number | null,
  locale: Locale = DEFAULT_LOCALE,
): { icon: string; label: string } {
  if (code === null) return { icon: "", label: "" };
  let best = WEATHER_ICONS[0];
  for (const entry of WEATHER_ICONS) {
    if (code >= entry[0]) best = entry;
  }
  return { icon: best[1], label: messages(locale).weather[best[2]] };
}

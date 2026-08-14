import { DEFAULT_LOCALE, messages, type Locale, type Messages } from "./i18n";

/**
 * The day's wind, hour by hour, as it was where the route ran.
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
export interface HourlyWind {
  /** Epoch milliseconds, one per hour, ascending. */
  time: number[];
  /** Wind speed at 10 m, km/h. */
  speedKmh: (number | null)[];
  /** Direction the wind comes from, degrees clockwise from north. */
  fromDeg: (number | null)[];
  /** Gusts at 10 m, km/h. */
  gustKmh: (number | null)[];
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
   * Optional because rows cached before the wind rose existed do not have it.
   * `/refreshweather` fills them in; everything reading this must cope with a
   * day that simply has no wind detail rather than assume the field is there.
   */
  hourlyWind?: HourlyWind | null;
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
  };
}

async function fetchDaily(
  endpoint: string,
  lat: number,
  lng: number,
  isoDate: string,
): Promise<DailyResponse | null> {
  const url = new URL(endpoint);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("start_date", isoDate);
  url.searchParams.set("end_date", isoDate);
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,weather_code",
  );
  url.searchParams.set("hourly", "wind_speed_10m,wind_direction_10m,wind_gusts_10m");
  url.searchParams.set("timezone", "auto");
  // `auto` keeps the daily figures bounded by the *local* day, which is what a
  // max temperature should mean — but it would also hand back hourly stamps as
  // wall-clock strings with no offset attached, and matching those against a
  // track's epoch timestamps needs the offset. Unix time sidesteps the whole
  // question: the daily aggregation stays local, the hourly stamps are absolute.
  url.searchParams.set("timeformat", "unixtime");

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as DailyResponse;
  // A day inside the window has every array populated; one it doesn't cover
  // comes back with the arrays present but full of nulls.
  return data.daily?.temperature_2m_max?.[0] != null ? data : null;
}

/** Only worth storing if at least one hour actually has a wind in it. */
function toHourlyWind(hourly: DailyResponse["hourly"]): HourlyWind | null {
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
  lat: number,
  lng: number,
  isoDate: string,
): Promise<DayWeather | null> {
  const ageDays = (Date.now() - Date.parse(isoDate + "T00:00:00Z")) / 86400000;
  const [first, second] =
    ageDays > ARCHIVE_LAG_DAYS ? [ARCHIVE_API, FORECAST_API] : [FORECAST_API, ARCHIVE_API];

  const res =
    (await fetchDaily(first, lat, lng, isoDate)) ?? (await fetchDaily(second, lat, lng, isoDate));
  if (!res) return null;
  const d = res.daily!;
  return {
    tempMaxC: d.temperature_2m_max?.[0] ?? null,
    tempMinC: d.temperature_2m_min?.[0] ?? null,
    precipitationMm: d.precipitation_sum?.[0] ?? null,
    windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
    windFromDeg: d.wind_direction_10m_dominant?.[0] ?? null,
    weatherCode: d.weather_code?.[0] ?? null,
    hourlyWind: toHourlyWind(res.hourly),
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

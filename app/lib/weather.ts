import { DEFAULT_LOCALE, messages, type Locale, type Messages } from "./i18n";

export interface DayWeather {
  tempMaxC: number | null;
  tempMinC: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
}

interface DailyResponse {
  daily?: {
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    precipitation_sum?: (number | null)[];
    wind_speed_10m_max?: (number | null)[];
    weather_code?: (number | null)[];
  };
}

async function fetchDaily(
  endpoint: string,
  lat: number,
  lng: number,
  isoDate: string,
): Promise<DailyResponse["daily"] | null> {
  const url = new URL(endpoint);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("start_date", isoDate);
  url.searchParams.set("end_date", isoDate);
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code",
  );
  url.searchParams.set("timezone", "auto");

  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as DailyResponse;
  // A day inside the window has every array populated; one it doesn't cover
  // comes back with the arrays present but full of nulls.
  return data.daily?.temperature_2m_max?.[0] != null ? data.daily : null;
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

  const d =
    (await fetchDaily(first, lat, lng, isoDate)) ?? (await fetchDaily(second, lat, lng, isoDate));
  if (!d) return null;
  return {
    tempMaxC: d.temperature_2m_max?.[0] ?? null,
    tempMinC: d.temperature_2m_min?.[0] ?? null,
    precipitationMm: d.precipitation_sum?.[0] ?? null,
    windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
    weatherCode: d.weather_code?.[0] ?? null,
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

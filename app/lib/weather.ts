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

/**
 * Daily weather at a point for one date. Free, no API key.
 *
 * The forecast endpoint only keeps a short rolling window of past days
 * alongside its forecast — plenty for weather cached live as a trip happens,
 * but empty for a day backfilled well after the fact (a bulk-imported or
 * long-finished trip). The historical endpoint covers those older dates
 * instead, so a day uploaded late still gets its weather.
 */
export async function fetchDayWeather(
  lat: number,
  lng: number,
  isoDate: string,
): Promise<DayWeather | null> {
  const d =
    (await fetchDaily("https://api.open-meteo.com/v1/forecast", lat, lng, isoDate)) ??
    (await fetchDaily("https://archive-api.open-meteo.com/v1/archive", lat, lng, isoDate));
  if (!d) return null;
  return {
    tempMaxC: d.temperature_2m_max?.[0] ?? null,
    tempMinC: d.temperature_2m_min?.[0] ?? null,
    precipitationMm: d.precipitation_sum?.[0] ?? null,
    windMaxKmh: d.wind_speed_10m_max?.[0] ?? null,
    weatherCode: d.weather_code?.[0] ?? null,
  };
}

const WEATHER_ICONS: [number, string, string][] = [
  [0, "☀️", "Clear"],
  [1, "🌤️", "Mostly clear"],
  [2, "⛅", "Partly cloudy"],
  [3, "☁️", "Overcast"],
  [45, "🌫️", "Fog"],
  [51, "🌦️", "Drizzle"],
  [61, "🌧️", "Rain"],
  [71, "🌨️", "Snow"],
  [80, "🌧️", "Showers"],
  [95, "⛈️", "Thunderstorm"],
];

export function weatherIcon(code: number | null): { icon: string; label: string } {
  if (code === null) return { icon: "", label: "" };
  let best: [number, string, string] = WEATHER_ICONS[0];
  for (const entry of WEATHER_ICONS) {
    if (code >= entry[0]) best = entry;
  }
  return { icon: best[1], label: best[2] };
}

export interface DayWeather {
  tempMaxC: number | null;
  tempMinC: number | null;
  precipitationMm: number | null;
  windMaxKmh: number | null;
  weatherCode: number | null;
}

/** Open-Meteo daily weather at a point for one date. Free, no API key. */
export async function fetchDayWeather(
  lat: number,
  lng: number,
  isoDate: string,
): Promise<DayWeather | null> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
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
  const data = (await res.json()) as {
    daily?: {
      temperature_2m_max?: (number | null)[];
      temperature_2m_min?: (number | null)[];
      precipitation_sum?: (number | null)[];
      wind_speed_10m_max?: (number | null)[];
      weather_code?: (number | null)[];
    };
  };
  const d = data.daily;
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

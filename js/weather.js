// Forecast and geocoding via Open-Meteo, with a small on-device cache.
// The public Open-Meteo API is for non-commercial use: a monetized launch needs a paid
// plan (see README). Keep provider details in this file so it can be swapped.
import { store } from './store.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FIELDS = 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m';

const FRESH_MS = 30 * 60 * 1000;
const STALE_LIMIT_MS = 24 * 60 * 60 * 1000;
const CACHE_PLACES = 5;
const TIMEOUT_MS = 8000;

const round2 = n => Math.round(n * 100) / 100;
const cacheKey = (lat, lon) => `${round2(lat)},${round2(lon)}`;

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function normalize(data) {
  const h = data.hourly;
  return {
    timeZone: data.timezone,
    fetchedAt: Date.now(),
    hourly: h.time.map((t, i) => ({
      t,
      temp: h.temperature_2m[i],
      apparent: h.apparent_temperature[i],
      precipProb: h.precipitation_probability[i],
      precipMm: h.precipitation[i],
      code: h.weather_code[i],
      wind: h.wind_speed_10m[i],
      gusts: h.wind_gusts_10m[i],
    })),
  };
}

function remember(key, forecast) {
  const cache = store.get('forecasts', {});
  cache[key] = forecast;
  const newestFirst = Object.entries(cache).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
  store.set('forecasts', Object.fromEntries(newestFirst.slice(0, CACHE_PLACES)));
}

/** A cached forecast, if one exists that is recent enough to show at all. */
export function cachedForecast(lat, lon) {
  const hit = store.get('forecasts', {})[cacheKey(lat, lon)];
  if (!hit || Date.now() - hit.fetchedAt > STALE_LIMIT_MS) return null;
  return { ...hit, fresh: Date.now() - hit.fetchedAt < FRESH_MS };
}

/** Coordinates are rounded to about 1 km before leaving the device. */
export async function fetchForecast(lat, lon) {
  const params = new URLSearchParams({
    latitude: round2(lat),
    longitude: round2(lon),
    hourly: FIELDS,
    forecast_days: 3,
    timezone: 'auto',
    timeformat: 'unixtime',
  });
  const forecast = normalize(await getJson(`${FORECAST_URL}?${params}`));
  remember(cacheKey(lat, lon), forecast);
  return { ...forecast, fresh: true };
}

// The geocoder only matches names in the language it's asked for, so "ירושלים" finds
// nothing with language=en. The script being typed says more than the device language.
const queryLanguage = query => {
  if (/\p{Script=Hebrew}/u.test(query)) return 'he';
  if (/\p{Script=Arabic}/u.test(query)) return 'ar';
  if (/\p{Script=Cyrillic}/u.test(query)) return 'ru';
  return (navigator.language || 'en').slice(0, 2);
};

export async function searchPlaces(query) {
  const params = new URLSearchParams({ name: query, count: 6, format: 'json', language: queryLanguage(query) });
  const data = await getJson(`${GEOCODE_URL}?${params}`);
  return (data.results ?? []).map(r => ({
    type: 'city',
    name: r.name,
    region: [r.admin1 !== r.name ? r.admin1 : null, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      reject,
      { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 10000 },
    );
  });
}

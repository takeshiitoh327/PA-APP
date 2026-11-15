// Today's weather at the phone's location. Coordinates are rounded to about
// 1 km before they leave the phone; only the town name is stored in the log.
// Weather: Open-Meteo (no key). Place name: OpenStreetMap Nominatim.

const CACHE_KEY = "pa-app.weather";
const PLACE_KEY = "pa-app.weather-place";
const LAST_KEY = "pa-app.weather-last";
const DAY_KEY = "pa-app.weather-day";

// Weather is read twice a day: the first time the app is opened in the
// morning, and again the first time after the evening review (20:30).
// Every other opening shows the saved reading without asking for location.
const EVENING = "20:30";

function taipeiNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const slotOf = (time) => (time >= EVENING ? "evening" : "morning");

// Today's saved reading if it is still current: { data, time } or null.
export function isEvening() {
  return slotOf(taipeiNow().time) === "evening";
}

export function savedWeather() {
  try {
    const c = JSON.parse(localStorage.getItem(DAY_KEY) || "null");
    const now = taipeiNow();
    if (!c || c.date !== now.date) return null;
    if (c.slot === "morning" && slotOf(now.time) === "evening") return null;
    return { data: c.data, time: c.time };
  } catch {
    return null;
  }
}

function saveDay(data) {
  try {
    const now = taipeiNow();
    localStorage.setItem(DAY_KEY, JSON.stringify({ date: now.date, time: now.time, slot: slotOf(now.time), data }));
  } catch {}
}

// Used when the phone's location is unavailable, or always when "fixed" is on.
export const CITIES = [
  ["基隆市", 25.13, 121.74], ["臺北市", 25.04, 121.56], ["新北市", 25.01, 121.47], ["桃園市", 24.99, 121.3],
  ["新竹市", 24.81, 120.97], ["新竹縣", 24.84, 121.01], ["苗栗縣", 24.56, 120.82], ["臺中市", 24.15, 120.67],
  ["彰化縣", 24.08, 120.54], ["南投縣", 23.91, 120.68], ["雲林縣", 23.71, 120.43], ["嘉義市", 23.48, 120.45],
  ["嘉義縣", 23.46, 120.25], ["臺南市", 22.99, 120.21], ["高雄市", 22.63, 120.3], ["屏東縣", 22.67, 120.49],
  ["宜蘭縣", 24.75, 121.75], ["花蓮縣", 23.99, 121.6], ["臺東縣", 22.76, 121.15], ["澎湖縣", 23.57, 119.58],
  ["金門縣", 24.43, 118.32], ["連江縣", 26.16, 119.95],
];

export function placeSetting() {
  try {
    return { city: "", fixed: false, ...JSON.parse(localStorage.getItem(PLACE_KEY) || "{}") };
  } catch {
    return { city: "", fixed: false };
  }
}

export function savePlaceSetting(setting) {
  try {
    localStorage.setItem(PLACE_KEY, JSON.stringify(setting));
    sessionStorage.removeItem(CACHE_KEY);
  } catch {}
}

// WMO weather codes used by Open-Meteo.
const WMO = [
  [[0], "☀️", "晴"],
  [[1], "🌤️", "晴時多雲"],
  [[2], "⛅", "多雲"],
  [[3], "☁️", "陰"],
  [[45, 48], "🌫️", "霧"],
  [[51, 53, 55, 56, 57], "🌦️", "毛毛雨"],
  [[61, 63, 80, 81], "🌧️", "雨"],
  [[65, 82], "🌧️", "大雨"],
  [[66, 67], "🌧️", "凍雨"],
  [[71, 73, 75, 77, 85, 86], "🌨️", "雪"],
  [[95], "⛈️", "雷雨"],
  [[96, 99], "⛈️", "雷雨冰雹"],
];

export function describe(code) {
  const hit = WMO.find(([codes]) => codes.includes(code));
  return hit ? { icon: hit[1], text: hit[2] } : { icon: "🌡️", text: "—" };
}

// Tells whether the page itself may use location (a server header can turn
// it off) as opposed to the browser or phone denying it.
export function diagnose() {
  try {
    const fp = document.featurePolicy || document.permissionsPolicy;
    if (fp && typeof fp.allowsFeature === "function") return fp.allowsFeature("geolocation") ? "網站允許定位" : "網站主機禁止定位";
  } catch {}
  return "無法判斷";
}

// A position request started straight from a tap. Chrome only shows its
// location prompt while the tap is fresh, so it must not wait on anything.
let pending = null;
export function requestPositionNow() {
  pending = requestPosition();
  pending.catch(() => {});
}

function position() {
  const p = pending || requestPosition();
  pending = null;
  return p;
}

function requestPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("這支手機不支援定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }),
      (e) =>
        reject(
          new Error(
            e.code === 1
              ? `沒有定位權限（診斷：${diagnose()}）`
              : e.code === 3
              ? "取得位置逾時（手機的「位置」功能有開嗎？）"
              : "取得位置失敗（手機的「位置」功能有開嗎？）"
          )
        ),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 }
    );
  });
}

// One retry after a short wait: a phone that just woke up or switched
// between Wi-Fi and mobile data often fails the first request.
async function fetchRetry(url, host) {
  for (let i = 0; ; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } catch {
      if (i >= 1) throw new Error(`連不上 ${host}`);
      await new Promise((r) => setTimeout(r, 2000));
    } finally {
      clearTimeout(timer);
    }
  }
}

// Open-Meteo first; MET Norway (yr.no) when Open-Meteo cannot be reached.
async function forecast(pos) {
  try {
    return await openMeteo(pos);
  } catch (e1) {
    try {
      return { ...(await metNorway(pos)), source: "MET Norway" };
    } catch (e2) {
      throw new Error(`兩個天氣來源都連不上（${e1.message}；${e2.message}）。網路不通，或 VPN／廣告阻擋擋住了它們`);
    }
  }
}

async function openMeteo({ lat, lon }) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FTaipei&forecast_days=1";
  const res = await fetchRetry(url, "Open-Meteo");
  if (!res.ok) throw new Error(`Open-Meteo 回應 ${res.status}`);
  const d = await res.json();
  return {
    now: Math.round(d.current.temperature_2m),
    nowCode: d.current.weather_code,
    code: d.daily.weather_code[0],
    max: Math.round(d.daily.temperature_2m_max[0]),
    min: Math.round(d.daily.temperature_2m_min[0]),
    rain: d.daily.precipitation_probability_max[0],
  };
}

// MET Norway symbol codes (without _day/_night) as WMO codes, so the rest of
// the app can treat both sources alike.
const MET_SYMBOLS = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 66, sleet: 66, heavysleet: 67, lightsleetshowers: 66, sleetshowers: 66, heavysleetshowers: 67,
  lightsnow: 71, snow: 73, heavysnow: 75, lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
};

export function metCode(symbol) {
  const base = String(symbol || "").replace(/_(day|night|polartwilight)$/, "");
  if (base.includes("thunder")) return 95;
  return MET_SYMBOLS[base] ?? null;
}

// Rough severity, so the day shows its worst weather (rain over cloud).
const SEVERITY = [0, 1, 2, 3, 45, 51, 61, 80, 63, 81, 65, 82, 66, 67, 71, 85, 73, 86, 75, 95];
const worse = (a, b) => (a === null ? b : b === null ? a : SEVERITY.indexOf(b) > SEVERITY.indexOf(a) ? b : a);

const taipeiDate = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date(iso));

// Turns a MET Norway "complete" forecast into the same shape as openMeteo().
// Only the rest of today is in the forecast, so min/max cover the hours left.
export function fromMet(json, today = taipeiNow().date) {
  const series = (json && json.properties && json.properties.timeseries) || [];
  if (!series.length) throw new Error("MET Norway 沒有資料");
  const first = series[0].data;
  const todays = series.filter((t) => taipeiDate(t.time) === today);
  const use = todays.length ? todays : [series[0]];
  const temps = use.map((t) => t.data.instant.details.air_temperature).filter((v) => typeof v === "number");
  let code = null;
  let rain = null;
  for (const t of use) {
    const next = t.data.next_1_hours || t.data.next_6_hours;
    if (!next) continue;
    code = worse(code, metCode(next.summary && next.summary.symbol_code));
    const p = next.details && next.details.probability_of_precipitation;
    if (typeof p === "number") rain = Math.max(rain ?? 0, p);
  }
  const nowNext = first.next_1_hours || first.next_6_hours || {};
  const nowCode = metCode(nowNext.summary && nowNext.summary.symbol_code);
  return {
    now: Math.round(first.instant.details.air_temperature),
    nowCode: nowCode ?? code,
    code: code ?? nowCode,
    max: Math.round(Math.max(...temps)),
    min: Math.round(Math.min(...temps)),
    rain: rain === null ? null : Math.round(rain),
  };
}

async function metNorway({ lat, lon }) {
  const res = await fetchRetry(`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat}&lon=${lon}`, "MET Norway");
  if (!res.ok) throw new Error(`MET Norway 回應 ${res.status}`);
  return fromMet(await res.json());
}

async function placeName({ lat, lon }) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=zh-TW`,
      { referrerPolicy: "origin" }
    );
    const a = (await res.json()).address || {};
    const county = a.city || a.county || a.state || "";
    const town = a.town || a.suburb || a.city_district || a.village || "";
    return county + (town && town !== county ? town : "") || "目前位置";
  } catch {
    return "目前位置";
  }
}


function lastPlace() {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) || "null");
  } catch {
    return null;
  }
}

// "granted", "prompt" or "denied". Chrome quietly blocks location requests
// that do not come from a tap, so "prompt" needs a button first.
export async function locationPermission() {
  try {
    return (await navigator.permissions.query({ name: "geolocation" })).state;
  } catch {
    return "prompt";
  }
}

// useCity: skip the phone's location and use the city from the settings.
export async function todayWeather({ useCity = false, force = false } = {}) {
  if (!force) {
    const saved = savedWeather();
    if (saved) return saved.data;
  }
  const { city, fixed } = placeSetting();
  const entry = CITIES.find(([name]) => name === city);
  let data;
  if (entry && (useCity || fixed)) {
    data = { ...(await forecast({ lat: entry[1], lon: entry[2] })), place: entry[0] };
  } else {
    let pos;
    let place;
    try {
      pos = await position();
    } catch (e) {
      // Fall back to the last place that worked (an ad blocker can block
      // location on some days), then to the city from the settings.
      const last = lastPlace();
      if (last) {
        data = { ...(await forecast(last)), place: last.place, fallback: "上次位置" };
      } else if (entry) {
        return todayWeather({ useCity: true });
      } else {
        throw e;
      }
    }
    if (pos) {
      const [w, name] = await Promise.all([forecast(pos), placeName(pos)]);
      place = name;
      data = { ...w, place };
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ ...pos, place }));
      } catch {}
    }
  }
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {}
  saveDay(data);
  return data;
}

// The line stored under the day's heading in logs/YYYY-MM.md.
export function weatherLine(w, time, evening = false) {
  const rain = w.rain === null || w.rain === undefined ? "" : `・降雨 ${w.rain}%`;
  return `> ${evening ? "晚上天氣" : "天氣"}：${w.place}${w.fallback ? `（${w.fallback}）` : ""}・${describe(w.code).text}・${w.min}–${w.max}°C${rain}${evening ? `・當時 ${w.now}°C` : ""}（${time} 記錄）`;
}

// Which hosts the phone can reach at all. "no-cors" ignores the reply's
// headers, so a failure here means the connection itself was blocked.
const PROBES = [
  ["GitHub", "https://api.github.com/"],
  ["Open-Meteo", "https://api.open-meteo.com/v1/forecast?latitude=25&longitude=121&current=temperature_2m"],
  ["MET Norway", "https://api.met.no/weatherapi/locationforecast/2.0/status"],
  ["OpenStreetMap", "https://nominatim.openstreetmap.org/status"],
  ["Google", "https://www.google.com/generate_204"],
];

export async function probeHosts() {
  return Promise.all(
    PROBES.map(async ([name, url]) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const t0 = performance.now();
      try {
        await fetch(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
        return { name, ok: true, ms: Math.round(performance.now() - t0) };
      } catch (e) {
        return { name, ok: false, why: e.name === "AbortError" ? "逾時" : "被擋" };
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

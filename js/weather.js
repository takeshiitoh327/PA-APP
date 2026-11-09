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

async function forecast({ lat, lon }) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FTaipei&forecast_days=1";
  const res = await fetch(url);
  if (!res.ok) throw new Error("天氣服務暫時無法使用");
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
export function weatherLine(w, time) {
  const rain = w.rain === null || w.rain === undefined ? "" : `・降雨 ${w.rain}%`;
  return `> 天氣：${w.place}${w.fallback ? `（${w.fallback}）` : ""}・${describe(w.code).text}・${w.min}–${w.max}°C${rain}（${time} 記錄）`;
}

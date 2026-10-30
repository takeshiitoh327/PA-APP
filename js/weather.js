// Today's weather at the phone's location. Coordinates are rounded to about
// 1 km before they leave the phone; only the town name is stored in the log.
// Weather: Open-Meteo (no key). Place name: OpenStreetMap Nominatim.

const CACHE_KEY = "pa-app.weather";
const PLACE_KEY = "pa-app.weather-place";

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
const CACHE_MINUTES = 30;

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

function position() {
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

function cached() {
  try {
    const c = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    return c && Date.now() - c.at < CACHE_MINUTES * 60 * 1000 ? c.data : null;
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
export async function todayWeather({ useCity = false } = {}) {
  const hit = cached();
  if (hit) return hit;
  const { city, fixed } = placeSetting();
  const entry = CITIES.find(([name]) => name === city);
  let data;
  if (entry && (useCity || fixed)) {
    data = { ...(await forecast({ lat: entry[1], lon: entry[2] })), place: entry[0] };
  } else {
    let pos;
    try {
      pos = await position();
    } catch (e) {
      if (!entry) throw e;
      return todayWeather({ useCity: true });
    }
    const [w, place] = await Promise.all([forecast(pos), placeName(pos)]);
    data = { ...w, place };
  }
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
  } catch {}
  return data;
}

// The line stored under the day's heading in logs/YYYY-MM.md.
export function weatherLine(w, time) {
  const rain = w.rain === null || w.rain === undefined ? "" : `・降雨 ${w.rain}%`;
  return `> 天氣：${w.place}・${describe(w.code).text}・${w.min}–${w.max}°C${rain}（${time} 記錄）`;
}

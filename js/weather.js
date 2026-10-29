// Today's weather at the phone's location. Coordinates are rounded to about
// 1 km before they leave the phone; only the town name is stored in the log.
// Weather: Open-Meteo (no key). Place name: OpenStreetMap Nominatim.

const CACHE_KEY = "pa-app.weather";
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

function position() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("這支手機不支援定位"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 100) / 100, lon: Math.round(p.coords.longitude * 100) / 100 }),
      (e) => reject(new Error(e.code === 1 ? "沒有定位權限" : "取得位置失敗")),
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

export async function todayWeather() {
  const hit = cached();
  if (hit) return hit;
  const pos = await position();
  const [w, place] = await Promise.all([forecast(pos), placeName(pos)]);
  const data = { ...w, place };
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

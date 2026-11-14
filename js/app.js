import { Repo, loadSettings, saveSettings, clearSettings } from "./gh.js";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  EXERCISES,
  PHASES,
  CREW_PHASES,
  PHASE_GROUPS,
  PHASE_GROUP,
  crewOf,
  withCrew,
  parseMonth,
  monthPath,
  buildEntryLine,
  normalizeTag,
  addEntry,
  replaceEntry,
  setMood,
  setWeather,
  formatDuration,
} from "./logfmt.js";
import * as outbox from "./outbox.js";
import { MUSCLES, FRONT, BACK } from "./muscles.js";
import { FIELDS as REPAIR_FIELDS, parseRepairs, repairPath, addRepair } from "./repairs.js";
import { todayWeather, savedWeather, isEvening, weatherLine, describe, locationPermission, diagnose, requestPositionNow, CITIES, placeSetting, savePlaceSetting } from "./weather.js";

// Version shown to the user, V0.NN (V0.33 was v33).
const APP_VERSION = "V0.53";
import { summarize, projectSummary, resolveRange, previousRange, openCommitments, addDays, daysBetween } from "./stats.js";
import { pushSupported, currentSubscription, enablePush, disablePush, showLocalTest } from "./push.js";

const TZ = "Asia/Taipei";
const view = document.getElementById("view");
const titleEl = document.getElementById("title");
let settings = loadSettings();
let repo = new Repo(settings);

// Months are fetched lazily and kept for the session; ↻ clears them.
const cache = { months: new Map(), monthList: null, files: new Map() };

// Fixed category -> color slot, so a category keeps its color in every chart.
const SERIES = ["work", "meeting", "exercise", "health", "life", "family", "social", "finance"];
const seriesVar = (c) => (SERIES.includes(c) ? `var(--series-${SERIES.indexOf(c) + 1})` : "var(--series-other)");

// ---------- helpers ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function todayTaipei() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

function nowTaipei(step = 5) {
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const [h, m] = t.split(":").map(Number);
  const rounded = Math.floor(m / step) * step;
  return `${String(h % 24).padStart(2, "0")}:${String(rounded).padStart(2, "0")}`;
}

const ZH_WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
function zhDate(date, withYear = true) {
  const [y, m, d] = date.split("-").map(Number);
  const w = ZH_WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${withYear ? `${y} 年 ` : ""}${m} 月 ${d} 日（${w}）`;
}

const fmtH = (h) => (h >= 10 ? h.toFixed(0) : (Math.round(h * 10) / 10).toString()) + "h";

function endTime(start, hours) {
  if (!hours) return null;
  const [h, m] = start.split(":").map(Number);
  const total = h * 60 + m + Math.round(hours * 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderMarkdown(md) {
  const body = md.replace(/^# .*\n+/, "");
  return window.DOMPurify.sanitize(window.marked.parse(body));
}

let toastTimer;
let queuedNotice = false;
function toast(msg, isError = false) {
  if (queuedNotice && !isError) msg = "📴 沒有網路：已先存在手機（⏳），恢復連線後自動上傳";
  queuedNotice = false;
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), isError ? 6000 : 2500);
}

function errorText(e) {
  if (e.status === 401) return "Token 無效或已過期，請到設定更新";
  if (e.status === 403) return "Token 權限不足（需要 Contents 讀寫）或已達 API 上限";
  if (e.offline || e instanceof TypeError) return "沒有網路連線，請稍後再試";
  if (e.status === 409 || e.status === 422) return "GitHub 還在更新剛剛的資料，請等幾秒再按一次儲存";
  return e.message || String(e);
}

function loading(msg = "讀取中…") {
  view.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(msg)}</div>`;
}

// ---------- data ----------

// Briefs and reviews appear during the day, so a file that was missing is
// looked up again next time instead of being remembered as missing.
async function getText(path) {
  if (!cache.files.has(path)) cache.files.set(path, remoteText(path));
  const text = await cache.files.get(path);
  if (text === null) cache.files.delete(path);
  return text;
}

// Set when a request fails for lack of network, so the next minute of
// reads use the phone's copies at once instead of waiting for a timeout.
let offlineUntil = 0;
const seemsOffline = () => navigator.onLine === false || Date.now() < offlineUntil;
function noteOffline(e) {
  if (e && e.offline) offlineUntil = Date.now() + 60000;
}

// A file from GitHub; offline, the last copy read on this phone.
async function remoteText(path) {
  if (seemsOffline()) {
    const copy = outbox.loadCopy(path);
    if (copy !== undefined) return copy;
  }
  try {
    const f = await repo.getFile(path);
    const text = f ? f.text : null;
    outbox.saveCopy(path, text);
    return text;
  } catch (e) {
    noteOffline(e);
    const copy = outbox.loadCopy(path);
    if (e.offline && copy !== undefined) return copy;
    if (e.offline && outbox.waitingPaths(path).length) return null;
    throw e;
  }
}

async function remoteList(dir) {
  const key = `${dir}/`;
  if (seemsOffline() && outbox.loadCopy(key)) return outbox.loadCopy(key);
  try {
    const names = (await repo.listDir(dir)).map((f) => f.name);
    outbox.saveCopy(key, names);
    return names;
  } catch (e) {
    noteOffline(e);
    if (e.offline) return outbox.loadCopy(key) || [];
    throw e;
  }
}

async function getMonth(month) {
  if (!cache.months.has(month)) {
    const path = `logs/${month}.md`;
    cache.months.set(
      month,
      remoteText(path).then((remote) => {
        const text = outbox.overlay(path, remote);
        const days = parseMonth(text || "");
        const waiting = outbox.waitingLines();
        for (const day of days.values()) for (const e of day.entries) e.waiting = waiting.has(e.line);
        return { text, days };
      })
    );
  }
  return cache.months.get(month);
}

async function allLogs() {
  if (!cache.monthList) {
    cache.monthList = remoteList("logs").then((names) =>
      [...new Set([...names, ...outbox.waitingPaths("logs/").map((p) => p.slice(5))])]
        .filter((n) => /^\d{4}-\d{2}\.md$/.test(n))
        .map((n) => n.slice(0, 7))
        .sort()
    );
  }
  const months = await cache.monthList;
  const parsed = await Promise.all(months.map(getMonth));
  const days = new Map();
  const entries = [];
  for (const p of parsed) {
    for (const [d, day] of p.days) {
      days.set(d, day);
      entries.push(...day.entries);
    }
  }
  return { days, entries };
}

// ---------- saving, with an offline outbox ----------

function forget(op) {
  if (op.kind === "repair") cache.repairs = null;
  else {
    cache.months.delete(op.date.slice(0, 7));
    cache.monthList = null;
  }
}

function runOp(op) {
  return repo.updateFile(outbox.pathOf(op), outbox.transformOf(op), outbox.messageOf(op));
}

// Saves a change to GitHub. Without network it waits in the outbox, and
// while older changes are waiting, new ones queue behind them.
async function save(op) {
  if (outbox.count() === 0 && !seemsOffline()) {
    try {
      await runOp(op);
      forget(op);
      return "saved";
    } catch (e) {
      noteOffline(e);
      if (!e.offline) throw e;
    }
  }
  outbox.add(op);
  forget(op);
  queuedNotice = op.a !== "weather";
  updateOutboxButton();
  if (!seemsOffline()) flushOutbox();
  return "queued";
}

function writeLog(date, change) {
  return save({ kind: "log", date, ...change });
}

let flushing = null;
// Uploads waiting changes in order; stops at the first network failure.
function flushOutbox() {
  if (flushing || !outbox.count() || !settings.token) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const op of outbox.list()) {
      try {
        await runOp(op);
        offlineUntil = 0;
        outbox.remove(op.id);
        forget(op);
        sent++;
      } catch (e) {
        noteOffline(e);
        if (e.offline) break;
        outbox.setError(op.id, errorText(e));
      }
    }
    updateOutboxButton();
    if (sent) {
      toast(`⏳ 已上傳 ${sent} 筆離線紀錄`);
      const a = document.activeElement;
      if (!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) route();
    }
  })().finally(() => (flushing = null));
  return flushing;
}

function updateOutboxButton() {
  const n = outbox.count();
  const btn = document.getElementById("outbox-btn");
  btn.hidden = n === 0;
  btn.textContent = `⏳ ${n}`;
  btn.classList.toggle("has-error", outbox.list().some((o) => o.error));
}

async function viewOutbox() {
  titleEl.textContent = "待上傳";
  const ops = outbox.list();
  view.innerHTML = `<section class="card">
    <h2>⏳ 待上傳 ${ops.length} 筆</h2>
    <p class="muted">沒有網路時存的紀錄先放在這支手機，恢復連線或打開 app 時會自動依序上傳到 GitHub。</p>
    ${
      ops.length
        ? `<ul class="outbox-list">${ops
            .map(
              (o) => `<li data-id="${esc(o.id)}"><div class="outbox-text">${esc(outbox.describe(o))}${
                o.error ? `<p class="outbox-error">上傳失敗：${esc(o.error)}</p>` : ""
              }</div><button type="button" class="btn small ghost danger" data-del>刪除</button></li>`
            )
            .join("")}</ul>
      <div class="form-actions"><button type="button" class="btn primary" id="outbox-send">立即上傳</button></div>`
        : `<p>全部都上傳了。</p>`
    }
  </section>`;
  view.querySelector(".outbox-list")?.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-del]");
    if (!b) return;
    const id = b.closest("li").dataset.id;
    const op = outbox.list().find((o) => o.id === id);
    if (!op || !confirm(`刪除這筆還沒上傳的紀錄？\n\n${outbox.describe(op)}`)) return;
    outbox.remove(id);
    forget(op);
    updateOutboxButton();
    viewOutbox();
  });
  document.getElementById("outbox-send")?.addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    await flushOutbox();
    if (outbox.count()) toast(navigator.onLine === false ? "還是沒有網路，稍後會自動再試" : "有些紀錄還沒上傳，請看上面的說明", true);
    viewOutbox();
  });
}

// ---------- views ----------

const routes = {
  doms: viewDoms,
  outbox: viewOutbox,
  projects: viewProjects,
  repairs: viewRepairs,
  today: viewToday,
  brief: (d) => viewToday(d, "brief"),
  review: (d) => viewToday(d, "review"),
  log: viewLog,
  stats: viewStats,
  settings: viewSettings,
};

async function route() {
  const [, name = "today", arg] = location.hash.split("/");
  const handler = routes[name] || viewToday;
  document.querySelectorAll("nav.tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (name === "brief" || name === "review" ? "today" : name === "projects" ? "stats" : name)));
  if (!settings.token && name !== "settings") return viewSettings(null, true);
  try {
    await handler(arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : null);
  } catch (e) {
    view.innerHTML = `<div class="card error-card"><h2>出錯了</h2><p>${esc(errorText(e))}</p><button class="btn" id="retry">重試</button></div>`;
    document.getElementById("retry").addEventListener("click", () => document.getElementById("refresh").click());
  }
}

function dateNav(date, base) {
  const today = todayTaipei();
  return `<div class="datenav">
    <a class="icon-btn" href="#/${base}/${addDays(date, -1)}" aria-label="前一天">‹</a>
    <div class="datenav-label"><strong>${zhDate(date)}</strong>${date === today ? '<span class="pill">今天</span>' : `<a class="pill link" href="#/${base}/${today}">回到今天</a>`}</div>
    <a class="icon-btn" href="#/${base}/${addDays(date, 1)}" aria-label="後一天">›</a>
  </div>`;
}

function entryRow(e, { actions = false } = {}) {
  const end = endTime(e.time, e.hours);
  const tags = e.tags.filter((t) => !["done", "dropped", "moved"].includes(t));
  // sleep_q and doms_* are already spelled out in the text.
  const metrics = Object.entries(e.metrics).filter(([k]) => k !== "sleep_q" && !k.startsWith("doms_"));
  const status = e.category === "plan" ? (e.status === "done" ? "✓ 完成" : e.status === "dropped" ? "✗ 取消" : e.due ? `到期 ${e.due.slice(5).replace("-", "/")}` : "") : "";
  return `<li class="entry ${e.category === "plan" ? `plan ${e.status}` : ""}">
    <div class="entry-time">${e.time}${end ? `<i class="time-line" aria-hidden="true"></i><span><span class="sr-only">至 </span>${end}</span>` : ""}</div>
    <div class="entry-body">
      <div class="entry-text">${e.waiting ? `<span class="waiting" title="還沒上傳">⏳</span> ` : ""}${linkify(e.plain)}</div>
      <div class="entry-meta">
        <span class="cat"><i style="background:${seriesVar(e.category)}"></i>${esc(CATEGORY_LABEL[e.category] || e.category)}</span>
        ${e.hours ? `<span>${formatDuration(e.hours)}</span>` : ""}
        ${status ? `<span>${status}</span>` : ""}
        ${metrics.map(([k, v]) => `<span class="metric">${k === "crew" ? `👥 ${v} 人` : `${esc(k)} ${v}`}</span>`).join("")}
        ${tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}
      </div>
      ${
        actions
          ? `<div class="entry-actions">
          ${e.category === "plan" && e.status === "open" ? `<button class="link-btn" data-act="done">完成</button><button class="link-btn" data-act="dropped">取消計畫</button>` : ""}
          <button class="link-btn" data-act="edit">編輯</button><button class="link-btn danger" data-act="delete">刪除</button></div>`
          : ""
      }
    </div>
  </li>`;
}

// Escapes text and turns https links (Google Drive folders and files) into
// short tappable links.
function linkify(text) {
  return String(text)
    .split(/(https:\/\/[^\s，；、]+)/)
    .map((part, i) =>
      i % 2 ? `<a class="drive-link" href="${esc(part)}" target="_blank" rel="noopener">📁 雲端</a>` : esc(part)
    )
    .join("");
}

// Sleep quality, stored as [sleep_q=N] on the sleep entry.
const SLEEP_QUALITY = [["1", "佳"], ["2", "普通"], ["3", "差"]];
function sleepQualityLabel(v) {
  const hit = SLEEP_QUALITY.find(([k]) => k === String(v));
  return hit ? hit[1] : "";
}

function dayTotals(entries) {
  const by = {};
  let sleep = 0;
  let quality = "";
  for (const e of entries) {
    if (e.category === "sleep" && e.metrics && e.metrics.sleep_q) quality = sleepQualityLabel(e.metrics.sleep_q);
    if (!e.hours) continue;
    if (e.category === "sleep") sleep += e.hours;
    else by[e.category] = (by[e.category] || 0) + e.hours;
  }
  const parts = Object.entries(by).map(([c, h]) => `${CATEGORY_LABEL[c] || c} ${formatDuration(h)}`);
  const total = parts.length ? `合計：${parts.join("、")}` : "";
  return [total, sleep ? `昨晚睡眠 ${formatDuration(sleep)}${quality ? `（${quality}）` : ""}` : ""].filter(Boolean).join("・");
}

const EXERCISE_LABEL = Object.fromEntries(EXERCISES);

function minutesBetween(a, b) {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return (bh * 60 + bm - (ah * 60 + am) + 24 * 60) % (24 * 60);
}

async function viewToday(date, focus) {
  date = date || todayTaipei();
  titleEl.textContent = "今天";
  loading();
  const [brief, review, month, all] = await Promise.all([
    getText(`briefs/${date}.md`),
    getText(`reviews/${date}.md`),
    getMonth(date.slice(0, 7)),
    allLogs().catch(() => ({ entries: [] })),
  ]);
  const day = month.days.get(date);
  const entries = day ? day.entries : [];
  const work = entries.filter((e) => e.category !== "plan");
  const plans = openCommitments(all.entries, date);
  const isToday = date === todayTaipei();

  view.innerHTML = `${dateNav(date, "today")}
  ${
    isToday
      ? `<section class="card weather" id="weather-card"><p class="muted">取得天氣中…</p></section>`
      : day && (day.weather || day.weatherEvening)
      ? `<section class="card weather">${day.weather ? `<p class="weather-saved">早上：${esc(day.weather)}</p>` : ""}${
          day.weatherEvening ? `<p class="weather-saved">晚上：${esc(day.weatherEvening)}</p>` : ""
        }</section>`
      : ""
  }
  <section class="card" id="sec-log">
    <div class="card-head"><h2>今天完成的事</h2><a class="btn small" href="#/log/${date}">＋ 記錄</a></div>
    ${
      work.length
        ? `<ul class="entries">${work.map((e) => entryRow(e)).join("")}</ul><p class="muted totals">${esc(dayTotals(work))}${day && day.mood ? `・心情 ${day.mood}` : ""}</p>`
        : `<p class="muted">${isToday ? "今天還沒有紀錄。" : "這天沒有紀錄。"}</p>`
    }
  </section>
  ${
    plans.length
      ? `<section class="card"><h2>追問</h2><ul class="plain">${plans
          .map((p) => `<li>說好 ${p.due.slice(5).replace("-", "/")} 要${esc(p.plain)}，做了嗎？ <a href="#/log/${p.date}">去更新</a></li>`)
          .join("")}</ul></section>`
      : ""
  }
  <section class="card md" id="sec-brief">
    <h2>晨報</h2>
    ${brief ? renderMarkdown(brief) : `<p class="muted">${isToday ? "今天的晨報還沒產生（每天 07:40 後）。" : "這天沒有晨報。"}</p>`}
  </section>
  <section class="card md" id="sec-review">
    <h2>晚上回顧</h2>
    ${review ? renderMarkdown(review) : `<p class="muted">${isToday ? "晚上回顧還沒產生（每天 20:30 後）。" : "這天沒有晚上回顧。"}</p>`}
  </section>`;
  if (focus) document.getElementById(`sec-${focus}`)?.scrollIntoView({ block: "start" });
  if (isToday) loadWeather(date, day);
}

// Shows today's weather and, the first time each day, writes it to the log.
async function loadWeather(date, day, tapped = false, force = false) {
  const card = document.getElementById("weather-card");
  const place = placeSetting();
  const saved = force ? null : savedWeather();
  const permission = saved || (place.fixed && place.city) ? "granted" : await locationPermission();
  if (!tapped && permission === "prompt") {
    card.innerHTML = `<div class="weather-ask"><p class="muted">按一下取得目前位置的天氣，之後每天打開會自動顯示。</p>
      <button type="button" class="btn primary" id="weather-ask">📍 取得今天天氣</button></div>`;
    document.getElementById("weather-ask").addEventListener("click", () => {
      requestPositionNow();
      card.innerHTML = `<p class="muted">取得天氣中…</p>`;
      loadWeather(date, day, true);
    });
    return;
  }
  try {
    const w = await todayWeather({ useCity: permission === "denied" && !tapped, force });
    const readAt = (savedWeather() || {}).time;
    if (!card.isConnected) return;
    const today = describe(w.code);
    const now = describe(w.nowCode);
    card.innerHTML = `<div class="weather-row">
      <div class="weather-icon" aria-hidden="true">${now.icon}</div>
      <div class="weather-main"><strong>${w.now}°C</strong><span>${esc(w.place)}${w.fallback ? `（${esc(w.fallback)}）` : ""}・現在${esc(now.text)}</span></div>
      <div class="weather-day"><span>${today.icon} ${esc(today.text)}</span><span>${w.min}–${w.max}°C</span>${
        w.rain !== null && w.rain !== undefined ? `<span>降雨 ${w.rain}%</span>` : ""
      }</div>
    </div>${w.rain >= 50 ? `<p class="weather-tip">☂️ 今天降雨機率高，記得帶傘</p>` : ""}
    <p class="muted weather-when">${readAt ? `${readAt} 讀取・早上和晚上 20:30 後各更新一次` : ""}<button type="button" class="link-btn" id="weather-refresh">立即更新</button></p>`;
    document.getElementById("weather-refresh").addEventListener("click", () => {
      requestPositionNow();
      card.innerHTML = `<p class="muted">取得天氣中…</p>`;
      loadWeather(date, day, true, true);
    });
    // One log line in the morning, one in the evening (after 20:30).
    const evening = isEvening();
    if (!day || !(evening ? day.weatherEvening : day.weather)) {
      if (navigator.onLine !== false) await writeLog(date, { a: "weather", line: weatherLine(w, nowTaipei(1), evening) });
    }
  } catch (e) {
    if (card.isConnected && day && (day.weatherEvening || day.weather)) {
      card.innerHTML = `<p class="weather-saved">${esc(day.weatherEvening || day.weather)}</p><p class="muted diag">目前抓不到位置，顯示今天稍早記錄的天氣</p>`;
      return;
    }
    if (card.isConnected) {
      const state = await locationPermission();
      card.innerHTML = `<p class="muted">天氣：${esc(e.message || "無法取得")}${
        /權限/.test(e.message) ? "。可以到設定 → 天氣地點選一個城市，定位不能用時改顯示那裡的天氣。" : ""
      }</p><p class="muted diag">${APP_VERSION}・${esc(diagnose())}・權限狀態 ${esc(state)}</p><div class="form-actions"><button type="button" class="btn small" id="weather-retry">重試</button></div>`;
      document.getElementById("weather-retry").addEventListener("click", () => {
        requestPositionNow();
        card.innerHTML = `<p class="muted">取得天氣中…</p>`;
        loadWeather(date, day, true);
      });
    }
  }
}

async function viewLog(date) {
  date = date || todayTaipei();
  titleEl.textContent = "日誌";
  loading();
  const [month, all] = await Promise.all([getMonth(date.slice(0, 7)), allLogs()]);
  const day = month.days.get(date);
  const entries = day ? day.entries : [];

  const tagCount = {};
  for (const e of all.entries) for (const t of e.tags) if (!["done", "dropped", "moved"].includes(t)) tagCount[t] = (tagCount[t] || 0) + 1;
  const recentTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([t]) => t);
  const metricNames = [...new Set(all.entries.flatMap((e) => Object.keys(e.metrics)))].filter((k) => k !== "sleep_q");

  view.innerHTML = `${dateNav(date, "log")}
  <section class="card">
    <div class="card-head"><h2>這天的紀錄</h2><span class="muted">${entries.length} 筆</span></div>
    ${entries.length ? `<ul class="entries">${entries.map((e) => entryRow(e, { actions: true })).join("")}</ul><p class="muted totals">${esc(dayTotals(entries))}</p>` : `<p class="muted">還沒有紀錄。</p>`}
    <div class="mood"><span>心情</span>${[1, 2, 3, 4, 5]
      .map((n) => `<button class="mood-btn ${day && day.mood === n ? "on" : ""}" data-mood="${n}" aria-label="心情 ${n}">${n}</button>`)
      .join("")}</div>
  </section>
  <section class="card" id="quick-card">
    <h2>快速記錄</h2>
    <div class="chips">
      <button type="button" class="chip" data-quick="sleep">😴 睡眠</button>
      <button type="button" class="chip" data-quick="exercise">🏃 運動</button>
      <a class="chip" href="#/repairs/${date}">🔧 維修</a>
      <a class="chip" href="#/doms/${date}">💪 痠痛</a>
    </div>
    <form id="sleep-form" class="quick-form" hidden autocomplete="off">
      <p class="muted hint">睡眠記在起床的這一天（${zhDate(date, false)}）。</p>
      <div class="row">
        <label>就寢<input type="time" name="bed" required value="23:00"></label>
        <label>起床<input type="time" name="wake" required value="06:30"></label>
      </div>
      <p class="muted hint" id="sleep-length"></p>
      <label>睡眠狀況
        <div class="chips">${SLEEP_QUALITY.map(([v, l]) => `<label class="chip radio"><input type="radio" name="q" value="${v}">${l}</label>`).join("")}</div>
      </label>
      <div class="form-actions"><button type="submit" class="btn primary">儲存睡眠</button></div>
    </form>
    <form id="exercise-form" class="quick-form" hidden autocomplete="off">
      <label>項目
        <div class="chips" id="ex-chips">${EXERCISES.map(
          ([v, l], i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-ex="${v}">${l}</button>`
        ).join("")}</div>
      </label>
      <label id="ex-other-row" hidden>運動名稱<input type="text" name="other" placeholder="例如：爬山"></label>
      <div class="row">
        <label>開始<input type="time" name="start" required value="${nowTaipei()}"></label>
        <label>距離（公里，可不填）<input type="number" name="km" step="any" min="0" inputmode="decimal"></label>
      </div>
      <div class="row">
        <label>時長（小時）<input type="number" name="dh" min="0" max="24" step="1" inputmode="numeric" placeholder="0"></label>
        <label>（分鐘）<input type="number" name="dm" min="0" max="59" step="5" inputmode="numeric" value="30"></label>
      </div>
      <div class="form-actions"><button type="submit" class="btn primary">儲存運動</button></div>
    </form>
  </section>
  <section class="card" id="form-card">
    <h2 id="form-title">新增紀錄</h2>
    <form id="entry-form" autocomplete="off">
      <div class="row">
        <label>開始<input type="time" name="start" required value="${nowTaipei()}"></label>
        <label>結束<input type="time" name="end"></label>
      </div>
      <div class="row">
        <label>或時長（小時）<input type="number" name="dh" min="0" max="24" step="1" inputmode="numeric" placeholder="0"></label>
        <label>（分鐘）<input type="number" name="dm" min="0" max="59" step="5" inputmode="numeric" placeholder="0"></label>
      </div>
      <label>分類
        <div class="chips" id="cat-chips">${CATEGORIES.map(
          ([v, l], i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-cat="${v}"><i style="background:${seriesVar(v)}"></i>${l}</button>`
        ).join("")}</div>
      </label>
      <label>內容<textarea name="text" rows="2" required placeholder="例如：製作控制盤，兩盤"></textarea></label>
      <div id="project-row">
        <label>專案（不含維修）<input type="text" name="project" list="project-names" placeholder="例如 迎廣50T"></label>
        <datalist id="project-names">${[...new Set(all.entries.map((e) => e.project).filter(Boolean))].map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
        <div class="chips" id="phase-chips">${PHASES.map(([v, l]) => `<button type="button" class="chip" data-phase="${v}">${l}</button>`).join("")}</div>
        <div id="crew-row" hidden><span class="muted crew-label">人數（算人工時）</span>
          <div class="chips">${[1, 2, 3].map((n) => `<button type="button" class="chip" data-crew="${n}">${n} 人</button>`).join("")}</div>
        </div>
      </div>
      <label id="due-row" hidden>到期日<input type="date" name="due" value="${addDays(date, 1)}"></label>
      <label>標籤（客戶、專案；用空格分開）<input type="text" name="tags" placeholder="例如：客戶名 panel"></label>
      ${recentTags.length ? `<div class="chips small" id="tag-chips">${recentTags.map((t) => `<button type="button" class="chip" data-tag="${esc(t)}">#${esc(t)}</button>`).join("")}</div>` : ""}
      <div class="row">
        <label>數量名稱<input type="text" name="mname" list="metric-names" placeholder="例如 panels"></label>
        <label>數量<input type="number" name="mval" step="any" inputmode="decimal" placeholder="2"></label>
      </div>
      <datalist id="metric-names">${metricNames.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      <div class="form-actions">
        <button type="button" class="btn ghost" id="cancel-edit" hidden>取消編輯</button>
        <button type="submit" class="btn primary" id="save-btn">儲存</button>
      </div>
    </form>
  </section>`;

  const form = document.getElementById("entry-form");
  let category = "work";
  let editing = null;
  let phase = null;
  let crew = 1;
  const setCrew = (n) => {
    crew = n;
    document.querySelectorAll("#crew-row .chip").forEach((b) => b.classList.toggle("on", Number(b.dataset.crew) === n));
  };
  const setPhase = (p) => {
    phase = p;
    document.querySelectorAll("#phase-chips .chip").forEach((b) => b.classList.toggle("on", b.dataset.phase === p));
    document.getElementById("crew-row").hidden = !CREW_PHASES.includes(p);
    if (!CREW_PHASES.includes(p)) setCrew(1);
    else setCrew(crew);
  };
  document.getElementById("crew-row").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-crew]");
    if (b) setCrew(Number(b.dataset.crew));
  });
  document.getElementById("phase-chips").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-phase]");
    if (b) setPhase(phase === b.dataset.phase ? null : b.dataset.phase);
  });

  const setCategory = (c) => {
    category = c;
    document.querySelectorAll("#cat-chips .chip").forEach((b) => b.classList.toggle("on", b.dataset.cat === c));
    document.getElementById("due-row").hidden = c !== "plan";
    document.getElementById("project-row").hidden = !["work", "meeting"].includes(c);
  };
  document.getElementById("cat-chips").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-cat]");
    if (b) setCategory(b.dataset.cat);
  });
  document.getElementById("tag-chips")?.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-tag]");
    if (!b) return;
    const tags = form.tags.value.split(/\s+/).filter(Boolean);
    const i = tags.indexOf(b.dataset.tag);
    if (i >= 0) tags.splice(i, 1);
    else tags.push(b.dataset.tag);
    form.tags.value = tags.join(" ");
    b.classList.toggle("on", i < 0);
  });

  const resetForm = () => {
    editing = null;
    form.reset();
    form.start.value = nowTaipei();
    form.due.value = addDays(date, 1);
    setCategory("work");
    document.querySelectorAll("#tag-chips .chip").forEach((b) => b.classList.remove("on"));
    document.getElementById("form-title").textContent = "新增紀錄";
    document.getElementById("save-btn").textContent = "儲存";
    document.getElementById("cancel-edit").hidden = true;
  };
  document.getElementById("cancel-edit").addEventListener("click", resetForm);

  const busy = async (btn, fn) => {
    btn.disabled = true;
    const label = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span>同步中`;
    try {
      await fn();
      return true;
    } catch (e) {
      toast(errorText(e), true);
      return false;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  const sleepForm = document.getElementById("sleep-form");
  const exForm = document.getElementById("exercise-form");
  let exercise = EXERCISES[0][0];
  document.getElementById("quick-card").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-quick]");
    if (!b) return;
    const kind = b.dataset.quick;
    const forms = { sleep: sleepForm, exercise: exForm };
    for (const [k, f] of Object.entries(forms)) f.hidden = k !== kind || !f.hidden;
    document.querySelectorAll("[data-quick]").forEach((c) => c.classList.toggle("on", c === b && !forms[kind].hidden));
  });
  const showSleep = () => {
    const mins = minutesBetween(sleepForm.bed.value, sleepForm.wake.value);
    document.getElementById("sleep-length").textContent = mins ? `共 ${formatDuration(mins / 60)}` : "";
  };
  sleepForm.addEventListener("input", showSleep);
  showSleep();
  sleepForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const mins = minutesBetween(sleepForm.bed.value, sleepForm.wake.value);
    if (!mins) return toast("就寢和起床時間不能一樣", true);
    const q = sleepForm.q.value;
    const line = buildEntryLine({
      time: sleepForm.bed.value,
      category: "sleep",
      hours: mins / 60,
      text: q ? `睡眠・${sleepQualityLabel(q)}` : "睡眠",
      metrics: q ? [["sleep_q", q]] : [],
    });
    const ok = await busy(sleepForm.querySelector("button[type=submit]"), () => writeLog(date, { a: "add", line }));
    if (ok) {
      toast("睡眠已記錄");
      viewLog(date);
    }
  });
  document.getElementById("ex-chips").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ex]");
    if (!b) return;
    exercise = b.dataset.ex;
    document.querySelectorAll("#ex-chips .chip").forEach((c) => c.classList.toggle("on", c === b));
    document.getElementById("ex-other-row").hidden = exercise !== "other";
  });
  exForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const hours = (parseFloat(exForm.dh.value) || 0) + (parseFloat(exForm.dm.value) || 0) / 60;
    if (!hours) return toast("請填運動時長", true);
    const name = exercise === "other" ? exForm.other.value.trim() || "運動" : EXERCISE_LABEL[exercise];
    const km = parseFloat(exForm.km.value);
    const line = buildEntryLine({
      time: exForm.start.value,
      category: "exercise",
      hours,
      text: name,
      tags: [exercise],
      metrics: km > 0 ? [["km", km]] : [],
    });
    const ok = await busy(exForm.querySelector("button[type=submit]"), () => writeLog(date, { a: "add", line }));
    if (ok) {
      toast(`${name}已記錄`);
      viewLog(date);
    }
  });

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const start = form.start.value;
    let hours = null;
    if (form.end.value) {
      let mins = daysToMinutes(form.end.value) - daysToMinutes(start);
      if (mins <= 0) mins += 24 * 60;
      hours = mins / 60;
    } else if (form.dh.value || form.dm.value) {
      hours = (parseFloat(form.dh.value) || 0) + (parseFloat(form.dm.value) || 0) / 60;
    }
    if (category === "plan") hours = null;
    const metrics = [];
    if (form.mname.value.trim() && form.mval.value !== "") {
      metrics.push([form.mname.value.trim().toLowerCase().replace(/\s+/g, "_"), parseFloat(form.mval.value)]);
    }
    if (["work", "meeting"].includes(category) && CREW_PHASES.includes(phase) && crew > 1) metrics.push(["crew", crew]);
    const line = buildEntryLine({
      time: start,
      category,
      hours,
      text: form.text.value.trim(),
      tags: [
        ...new Set([
          ...form.tags.value.split(/\s+/).filter(Boolean).map(normalizeTag).filter((t) => !PHASES.some(([k]) => k === t)),
          ...(["work", "meeting"].includes(category) && form.project.value.trim() && phase ? [phase] : []),
        ]),
      ],
      metrics,
      due: category === "plan" ? form.due.value : null,
      project: ["work", "meeting"].includes(category) ? form.project.value : "",
    });
    const old = editing;
    const ok = await busy(document.getElementById("save-btn"), () =>
      writeLog(date, old ? { a: "replace", old, line } : { a: "add", line })
    );
    if (ok) {
      toast(old ? "已更新並同步到 GitHub" : "已儲存並同步到 GitHub");
      viewLog(date);
    }
  });

  view.querySelector(".entries")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const idx = [...view.querySelectorAll(".entries .entry")].indexOf(btn.closest(".entry"));
    const e = entries[idx];
    const act = btn.dataset.act;
    if (act === "edit") {
      editing = e.line;
      form.start.value = e.time;
      form.end.value = endTime(e.time, e.hours) || "";
      form.dh.value = form.dm.value = "";
      form.text.value = e.plain;
      form.tags.value = e.tags.filter((t) => !["done", "dropped", "moved"].includes(t) && !(e.project && PHASES.some(([k]) => k === t))).join(" ");
      form.project.value = e.project || "";
      setPhase(e.project ? (PHASES.find(([k]) => e.tags.includes(k)) || [null])[0] : null);
      const [m] = Object.entries(e.metrics).filter(([k]) => k !== "crew");
      crew = crewOf(e);
      form.mname.value = m ? m[0] : "";
      form.mval.value = m ? m[1] : "";
      if (e.due) form.due.value = e.due;
      setCategory(e.category);
      document.getElementById("form-title").textContent = "編輯紀錄";
      document.getElementById("save-btn").textContent = "更新";
      document.getElementById("cancel-edit").hidden = false;
      document.getElementById("form-card").scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (act === "delete" && !confirm(`刪除這筆紀錄？\n\n${e.time} ${e.plain}`)) return;
    const newLine = act === "delete" ? null : `${e.line} #${act}`;
    const ok = await busy(btn, () => writeLog(date, { a: "replace", old: e.line, line: newLine }));
    if (ok) {
      toast(act === "delete" ? "已刪除" : act === "done" ? "已標為完成" : "已取消計畫");
      viewLog(date);
    }
  });

  view.querySelector(".mood").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-mood]");
    if (!b) return;
    const mood = day && day.mood === Number(b.dataset.mood) ? null : Number(b.dataset.mood);
    const ok = await busy(b, () => writeLog(date, { a: "mood", mood }));
    if (ok) {
      toast(mood ? `心情 ${mood} 已記錄` : "已清除心情");
      viewLog(date);
    }
  });
}

function daysToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// ---------- muscle soreness (DOMS) ----------

// One entry per day: "- HH:MM · health · 肌肉痠痛：胸肌 中、股四頭肌 輕 #doms [doms_chest=2] [doms_quads=1]"
const DOMS_LEVELS = [[1, "輕"], [2, "中"], [3, "重"]];
const MUSCLE_LABEL = Object.fromEntries(MUSCLES);

function domsOf(e) {
  const out = {};
  for (const [k, v] of Object.entries(e.metrics)) if (k.startsWith("doms_") && v > 0) out[k.slice(5)] = Math.min(3, Math.round(v));
  return out;
}

function domsText(levels) {
  return MUSCLES.filter(([k]) => levels[k])
    .map(([k, l]) => `${l} ${DOMS_LEVELS[levels[k] - 1][1]}`)
    .join("、");
}

function muscleSvg(shapes, levels, label, side, hidden) {
  return `<figure class="body-map" data-side="${side}" ${hidden ? "hidden" : ""}><svg viewBox="0 0 100 ${side === "front" ? 200 : 220}" role="group" aria-label="${label}">${shapes
    .map(([k, pts]) =>
      k
        ? `<polygon class="m lv${levels[k] || 0}" data-m="${k}" points="${pts}"><title>${esc(MUSCLE_LABEL[k])}</title></polygon>`
        : `<polygon class="m-off" points="${pts}"/>`
    )
    .join("")}</svg></figure>`;
}

const DOMS_SIDE_KEY = "pa-app.doms-side";
function domsSide() {
  try {
    return localStorage.getItem(DOMS_SIDE_KEY) === "back" ? "back" : "front";
  } catch {
    return "front";
  }
}
const FRONT_KEYS = new Set(FRONT.map(([k]) => k).filter(Boolean));

async function viewDoms(date) {
  date = date || todayTaipei();
  titleEl.textContent = "肌肉痠痛";
  loading();
  const [month, all] = await Promise.all([getMonth(date.slice(0, 7)), allLogs()]);
  const day = month.days.get(date);
  const existing = day ? day.entries.find((e) => e.tags.includes("doms")) : null;
  const levels = existing ? domsOf(existing) : {};
  const gym = all.entries
    .filter((e) => e.category === "exercise" && e.tags.includes("gym") && e.date <= date)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))[0];
  const history = all.entries
    .filter((e) => e.tags.includes("doms") && e.date !== date)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14);
  const md = (d) => d.slice(5).replace("-", "/");
  const sinceGym = gym ? daysBetween(gym.date, date) : null;

  const render = () => {
    view.querySelectorAll("polygon.m").forEach((p) => (p.className.baseVal = `m lv${levels[p.dataset.m] || 0}`));
    const side = domsSide();
    const n = { front: 0, back: 0 };
    for (const k of Object.keys(levels)) n[FRONT_KEYS.has(k) ? "front" : "back"]++;
    view.querySelectorAll("#doms-sides button").forEach((b) => {
      b.classList.toggle("on", b.dataset.side === side);
      b.textContent = `${b.dataset.side === "front" ? "正面" : "背面"}${n[b.dataset.side] ? `（${n[b.dataset.side]}）` : ""}`;
    });
    view.querySelectorAll(".body-map").forEach((f) => (f.hidden = f.dataset.side !== side));
    document.getElementById("doms-side-hint").textContent =
      side === "front" ? "正面像照鏡子：圖的左邊是你的右側" : "背面：圖的左邊就是你的左側";
    const text = domsText(levels);
    document.getElementById("doms-list").innerHTML = text
      ? MUSCLES.filter(([k]) => levels[k])
          .map(([k, l]) => `<button type="button" class="chip doms-chip lv${levels[k]}" data-m="${k}">${l}・${DOMS_LEVELS[levels[k] - 1][1]}</button>`)
          .join("")
      : `<span class="muted">點圖上的肌肉：點一下「輕」，再點「中」、「重」，第四下取消。</span>`;
  };

  view.innerHTML = `${dateNav(date, "doms")}
  <section class="card doms-card">
    <div class="segmented" id="doms-sides"><button type="button" data-side="front">正面</button><button type="button" data-side="back">背面</button></div>
    <p class="muted hint doms-side" id="doms-side-hint"></p>
    <div class="body-maps">${muscleSvg(FRONT, levels, "正面", "front", domsSide() !== "front")}${muscleSvg(BACK, levels, "背面", "back", domsSide() !== "back")}</div>
    <div class="doms-legend">${DOMS_LEVELS.map(([v, l]) => `<span><i class="lv${v}"></i>${l}</span>`).join("")}</div>
    <div class="chips" id="doms-list"></div>
    <div class="form-actions">
      ${existing ? `<button type="button" class="btn ghost danger" id="doms-clear">刪除這天的紀錄</button>` : ""}
      <button type="button" class="btn primary" id="doms-save">儲存</button>
    </div>
    <p class="muted doms-gym">${existing ? "這天已記錄・" : ""}${
      gym ? (sinceGym === 0 ? `今天有重訓（${esc(gym.plain)}）` : `距上次重訓 ${sinceGym} 天（${md(gym.date)} ${esc(gym.plain)}）`) : "還沒有重訓紀錄（日誌 → 快速記錄 → 🏃 運動 → 重訓）"
    }</p>
  </section>
  ${
    history.length
      ? `<section class="card"><h2>最近的痠痛紀錄</h2><ul class="doms-history">${history
          .map((e) => `<li><a href="#/doms/${e.date}">${md(e.date)}</a> ${esc(domsText(domsOf(e)))}</li>`)
          .join("")}</ul></section>`
      : ""
  }`;
  render();

  const bump = (k) => {
    levels[k] = ((levels[k] || 0) + 1) % 4;
    if (!levels[k]) delete levels[k];
    render();
  };
  view.querySelector(".body-maps").addEventListener("click", (ev) => {
    const p = ev.target.closest("polygon.m");
    if (p) bump(p.dataset.m);
  });
  const setSide = (side) => {
    try {
      localStorage.setItem(DOMS_SIDE_KEY, side);
    } catch {}
    render();
  };
  document.getElementById("doms-sides").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-side]");
    if (b) setSide(b.dataset.side);
  });
  // Swipe sideways on the map to turn the body around.
  let touchX = null;
  const maps = view.querySelector(".body-maps");
  maps.addEventListener("touchstart", (ev) => (touchX = ev.touches[0].clientX), { passive: true });
  maps.addEventListener("touchend", (ev) => {
    if (touchX === null) return;
    const dx = ev.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 60) setSide(domsSide() === "front" ? "back" : "front");
  });
  document.getElementById("doms-list").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-m]");
    if (b) bump(b.dataset.m);
  });
  const finish = async (btn, change, done) => {
    btn.disabled = true;
    try {
      await writeLog(date, change);
      toast(done);
      viewDoms(date);
    } catch (e) {
      toast(errorText(e), true);
      btn.disabled = false;
    }
  };
  document.getElementById("doms-save").addEventListener("click", (ev) => {
    const text = domsText(levels);
    if (!text) {
      if (existing) return finish(ev.target, { a: "replace", old: existing.line, line: null }, "已清除這天的痠痛紀錄");
      return toast("還沒有選肌肉", true);
    }
    const line = buildEntryLine({
      time: existing ? existing.time : nowTaipei(1),
      category: "health",
      text: `肌肉痠痛：${text}`,
      tags: ["doms"],
      metrics: MUSCLES.filter(([k]) => levels[k]).map(([k]) => [`doms_${k}`, levels[k]]),
    });
    finish(ev.target, existing ? { a: "replace", old: existing.line, line } : { a: "add", line }, "痠痛已記錄");
  });
  document.getElementById("doms-clear")?.addEventListener("click", (ev) => {
    if (confirm("刪除這天的痠痛紀錄？")) finish(ev.target, { a: "replace", old: existing.line, line: null }, "已刪除");
  });
}

// ---------- repairs ----------

async function allRepairs() {
  if (!cache.repairs) {
    cache.repairs = remoteList("field/repairs").then(async (names) => {
      const paths = [
        ...new Set([...names.filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).map((n) => `field/repairs/${n}`), ...outbox.waitingPaths("field/repairs/")]),
      ];
      const texts = await Promise.all(paths.map(async (p) => outbox.overlay(p, await remoteText(p))));
      const waiting = new Set(outbox.waitingRepairs());
      return texts
        .flatMap((t) => parseRepairs(t || ""))
        .map((x) => ({ ...x, waiting: waiting.has(`${x.date}|${x.customer}|${x.machine}`) }))
        .sort((a, b) => b.date.localeCompare(a.date));
    });
  }
  return cache.repairs;
}

let repairQuery = "";
const REPAIR_ORDER_KEY = "pa-app.repair-order";
function repairOrder() {
  try {
    return localStorage.getItem(REPAIR_ORDER_KEY) || "old";
  } catch {
    return "old";
  }
}

// One checklist row: a tick box, then a text box. Typing ticks the box.
function checkRow(name, label, value = "", placeholder = "") {
  return `<li class="check-row">
    <input type="checkbox" class="check-box" ${value ? "checked" : ""} aria-label="${esc(label)}">
    ${label ? `<span class="check-label">${esc(label)}</span>` : ""}
    <input type="text" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" list="dl-${name}">
  </li>`;
}

function repairFormHtml(date) {
  return `<form id="repair-form" autocomplete="off">
    <label>日期<input type="date" name="date" required value="${date}"></label>
    <h3 class="form-sub">對象</h3>
    <ul class="checklist">
      ${checkRow("direct", "直接客戶", "", "例如 屏東傑生工業")}
      ${checkRow("client", "客戶", "", "例如 田豐")}
      ${checkRow("owner", "業主", "", "例如 奕郝")}
    </ul>
    <h3 class="form-sub">機台與維修</h3>
    <ul class="checklist">
      ${checkRow("machine", "機台名稱", "", "例如 打包機")}
    </ul>
    <p class="check-group">故障原因</p>
    <ul class="checklist" data-list="cause">${checkRow("cause", "", "", "例如 PLC 輸出點損壞")}</ul>
    <button type="button" class="btn small" data-add="cause">＋ 再加一項原因</button>
    <p class="check-group">維修內容</p>
    <ul class="checklist" data-list="fix">${checkRow("fix", "", "", "例如 更換 PLC FBs-24MAR2-AC")}</ul>
    <button type="button" class="btn small" data-add="fix">＋ 再加一項維修內容</button>
    <details class="more">
      <summary>更多欄位（地點、年份、零件、雲端資料夾、工時）</summary>
      <label>地點<input type="text" name="place" list="dl-place" placeholder="例如 南投市南崗工業區"></label>
      <label>年份<input type="text" name="year" placeholder="西元年，例如 2014、未知"></label>
      <label>製造（機台／電控）<input type="text" name="build" placeholder="例如 機台 田豐；電控 中信"></label>
      <label>故障現象<input type="text" name="symptom"></label>
      <label>更換零件（用「；」分開）<input type="text" name="parts" placeholder="例如 FBs-24MAR2-AC；CU-11 380V"></label>
      <label>雲端資料夾連結<input type="url" name="folder" inputmode="url" placeholder="https://drive.google.com/drive/folders/…"></label>
      <p class="muted hint">工時（填了才會同時記一筆日誌）</p>
      <div class="row">
        <label>開始<input type="time" name="start"></label>
        <label>結束<input type="time" name="end"></label>
      </div>
    </details>
    ${["direct", "client", "owner", "machine", "place"].map((k) => `<datalist id="dl-${k}"></datalist>`).join("")}
    <div class="form-actions"><button type="submit" class="btn primary">儲存維修紀錄</button></div>
  </form>`;
}

function repairCard(x) {
  const who = [
    x.direct && `直接客戶 ${x.direct}`,
    x.client && `客戶 ${x.client}`,
    x.owner && `業主 ${x.owner}`,
  ].filter(Boolean);
  const sub = [x.place && `📍 ${x.place}`, x.year, x.build].filter(Boolean);
  const list = (v) => `<ul class="bullets">${String(v).split("；").filter(Boolean).map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  return `<section class="card repair">
    <div class="card-head"><h2>${x.waiting ? `<span class="waiting" title="還沒上傳">⏳</span> ` : ""}${esc(x.customer)}・${esc(x.machine)}</h2><span class="muted">${esc(x.date)}</span></div>
    ${who.length ? `<p class="repair-who">${esc(who.join("・"))}</p>` : ""}
    ${sub.length ? `<p class="muted repair-sub">${esc(sub.join("・"))}</p>` : ""}
    <dl class="kv repair-kv">${REPAIR_FIELDS.filter(([k]) => ["symptom", "cause", "fix", "parts"].includes(k) && x[k])
      .map(([k, l]) => `<dt>${l}</dt><dd>${["cause", "fix"].includes(k) ? list(x[k]) : esc(x[k])}</dd>`)
      .join("")}</dl>
    ${/^https:\/\//.test(x.folder || "") ? `<a class="btn small" href="${esc(x.folder)}" target="_blank" rel="noopener">📁 打開雲端資料夾</a>` : ""}
  </section>`;
}

async function viewRepairs(openDate) {
  titleEl.textContent = "維修紀錄";
  loading();
  const list = await allRepairs();
  const render = () => {
    const q = repairQuery.trim().toLowerCase();
    const hits = (q ? list.filter((x) => REPAIR_FIELDS.map(([k]) => x[k]).concat(x.customer, x.machine, x.date).join(" ").toLowerCase().includes(q)) : list.slice()).sort((a, b) =>
      repairOrder() === "old" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)
    );
    document.querySelectorAll("#repair-order button").forEach((btn) => btn.classList.toggle("on", btn.dataset.order === repairOrder()));
    document.getElementById("repair-list").innerHTML = hits.length
      ? hits.map(repairCard).join("")
      : `<section class="card"><p class="muted">${q ? "找不到符合的維修紀錄。" : "還沒有維修紀錄，按上面的「＋ 新增維修紀錄」。"}</p></section>`;
  };
  view.innerHTML = `<section class="card">
    <details id="repair-new" ${openDate ? "open" : ""}>
      <summary class="new-summary">＋ 新增維修紀錄</summary>
      ${repairFormHtml(openDate || todayTaipei())}
    </details>
  </section>
  <label class="search">搜尋（客戶、業主、地點、機台、零件…）<input type="search" id="repair-q" value="${esc(repairQuery)}" placeholder="例如 田豐、奕郝、FBs"></label>
  <div class="list-head"><p class="muted range-label">共 ${list.length} 筆</p>
    <div class="segmented" id="repair-order"><button type="button" data-order="old">舊→新</button><button type="button" data-order="new">新→舊</button></div>
  </div>
  <div id="repair-list"></div>`;
  render();
  document.getElementById("repair-order").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-order]");
    if (!btn) return;
    try {
      localStorage.setItem(REPAIR_ORDER_KEY, btn.dataset.order);
    } catch {}
    render();
  });
  document.getElementById("repair-q").addEventListener("input", (ev) => {
    repairQuery = ev.target.value;
    render();
  });

  const f = document.getElementById("repair-form");
  for (const k of ["direct", "client", "owner", "machine", "place"]) {
    const vals = [...new Set(list.map((x) => (k === "machine" ? x.machine : x[k])).filter(Boolean))];
    document.getElementById(`dl-${k}`).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join("");
  }
  f.addEventListener("input", (ev) => {
    const row = ev.target.closest(".check-row");
    if (row && ev.target.type === "text") row.querySelector(".check-box").checked = ev.target.value.trim() !== "";
  });
  f.addEventListener("click", (ev) => {
    const add = ev.target.closest("[data-add]");
    if (!add) return;
    const ul = f.querySelector(`[data-list="${add.dataset.add}"]`);
    ul.insertAdjacentHTML("beforeend", checkRow(add.dataset.add));
    ul.lastElementChild.querySelector("input[type=text]").focus();
  });
  // Values of the ticked rows with this name.
  const ticked = (name) =>
    [...f.querySelectorAll(`.check-row input[name="${name}"]`)]
      .filter((i) => i.closest(".check-row").querySelector(".check-box").checked)
      .map((i) => i.value.trim())
      .filter(Boolean);
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const date = f.date.value;
    const [direct] = ticked("direct");
    const [client] = ticked("client");
    const [owner] = ticked("owner");
    const [machine] = ticked("machine");
    const cause = ticked("cause");
    const fix = ticked("fix");
    if (!direct && !client) return toast("請勾選「直接客戶」或「客戶」並填名稱", true);
    if (!machine) return toast("請勾選並填「機台名稱」", true);
    if (!fix.length) return toast("請至少填一項「維修內容」", true);
    const folder = f.folder.value.trim();
    if (folder && !/^https:\/\//.test(folder)) return toast("雲端連結要以 https:// 開頭", true);
    const rec = {
      date,
      customer: direct || client,
      machine,
      direct: direct || "",
      client: client || "",
      owner: owner || "",
      place: f.place.value.trim(),
      year: f.year.value.trim(),
      build: f.build.value.trim(),
      symptom: f.symptom.value.trim(),
      cause: cause.join("；"),
      fix: fix.join("；"),
      parts: f.parts.value.trim(),
      folder,
    };
    let logLine = null;
    if (f.start.value && f.end.value) {
      const mins = minutesBetween(f.start.value, f.end.value);
      const who = owner ? `${owner}${machine}維修（${rec.customer}）` : `${rec.customer}${machine}維修`;
      logLine = buildEntryLine({
        time: f.start.value,
        category: "work",
        hours: mins / 60,
        text: `${who}：${rec.fix}${folder ? " " + folder : ""}`,
        tags: [...new Set([rec.customer, owner].filter(Boolean).map(normalizeTag)), "repair"],
      });
    }
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await save({ kind: "repair", date, rec });
      if (logLine) await writeLog(date, { a: "add", line: logLine });
      toast(logLine ? "維修紀錄和日誌都已儲存" : "維修紀錄已儲存");
      repairQuery = "";
      location.hash = "#/repairs";
      if (!openDate) viewRepairs();
    } catch (e) {
      toast(errorText(e), true);
      btn.disabled = false;
    }
  });
}

// ---------- stats ----------

let statsRange = { kind: "week", from: null, to: null };

function statsSwitch(on) {
  return `<div class="segmented stats-switch">
    <a href="#/stats" class="${on === "stats" ? "on" : ""}">時間統計</a>
    <a href="#/projects" class="${on === "projects" ? "on" : ""}">🏗️ 專案工時</a>
  </div>`;
}

let projectRange = "all";

async function viewProjects() {
  titleEl.textContent = "專案工時";
  loading();
  const { entries } = await allLogs();
  const today = todayTaipei();
  const [start, end] = projectRange === "all" ? ["0000-01-01", "9999-12-31"] : resolveRange(projectRange, today);
  const s = projectSummary(entries, start, end, PHASES);
  const ranges = [["month", "本月"], ["year", "今年"], ["all", "全部"]];
  const phaseLabel = Object.fromEntries(PHASES);
  const md = (d) => d.slice(5).replace("-", "/");
  view.innerHTML = `${statsSwitch("projects")}
  <div class="segmented">${ranges.map(([k, l]) => `<button class="${projectRange === k ? "on" : ""}" data-prange="${k}">${l}</button>`).join("")}</div>
  <p class="range-label muted">專案共 ${fmtH(s.total)}（${PHASE_GROUPS.map(([g, gl]) => `${gl} ${fmtH(
    s.list.reduce((a, p) => a + Object.entries(p.phases).filter(([k]) => PHASE_GROUP[k] === g).reduce((b, [, h]) => b + h, 0), 0)
  )}`).join("・")}）・${s.list.length} 個專案（維修不算在內）</p>
  ${
    s.list.length
      ? s.list
          .map((p) => {
            const rows = PHASES.filter(([k]) => p.phases[k]);
            const phaseRow = (k, l) => {
          const list = p.entries.filter((e) => e.phase === k);
          // 細項: entries with the same text added up, largest first.
          const items = Object.values(
            list.reduce((acc, e) => {
              const key = e.plain.replace(/\s+/g, "");
              (acc[key] = acc[key] || { text: e.plain, h: 0, n: 0, entries: [] }).h += e.hours;
              acc[key].n++;
              acc[key].entries.push(e);
              return acc;
            }, {})
          ).sort((x, y) => y.h - x.h);
          return `<details class="phase-detail" data-key="${esc(p.name)}|${k}"><summary class="phase-row"><span class="phase-name">${l}</span>
          <span class="phase-bar"><i style="width:${Math.max(3, (p.phases[k] / p.hours) * 100)}%"></i></span>
          <span class="phase-h">${fmtH(p.phases[k])}<small>${Math.round((p.phases[k] / p.hours) * 100)}%</small></span></summary>
          ${CREW_PHASES.includes(k) ? `<p class="crew-total">👥 人工時 ${fmtH(p.personPhases[k])}</p>` : ""}
          <div class="phase-body">
            <p class="phase-sub">細項</p>
            <ul class="phase-items">${items
              .map(
                (it) => `<li><details class="item-detail" data-key="${esc(p.name)}|${k}|${esc(it.text)}"><summary><span>${esc(it.text)}${it.n > 1 ? `<small>×${it.n}</small>` : ""}</span><span>${fmtH(it.h)}</span></summary>
              <div class="phase-entries-wrap">
                <p class="phase-sub">明細（${it.entries.length} 筆）</p>
                <ul class="phase-entries">${it.entries
                  .map(
                    (e) => `<li><a href="#/log/${e.date}">${md(e.date)}</a> ${formatDuration(e.hours)}${
                      CREW_PHASES.includes(k) && crewOf(e) > 1 ? `<small class="crew-calc"> × ${crewOf(e)} 人 = ${formatDuration(e.hours * crewOf(e))}</small>` : ""
                    }<br><span class="muted">${e.time}${endTime(e.time, e.hours) ? `–${endTime(e.time, e.hours)}` : ""}</span>${
                      CREW_PHASES.includes(k)
                        ? `<div class="crew-pick" data-line="${esc(e.line)}" data-date="${e.date}">${[1, 2, 3]
                            .map((n) => `<button type="button" class="chip small-chip ${crewOf(e) === n ? "on" : ""}" data-crew="${n}">${n} 人</button>`)
                            .join("")}</div>`
                        : ""
                    }</li>`
                  )
                  .join("")}</ul>
              </div></details></li>`
              )
              .join("")}</ul>
          </div></details>`;
            };
            return `<section class="card project">
      <div class="card-head"><h2>${esc(p.name)}</h2><strong class="project-total">${fmtH(p.hours)}</strong></div>
      <p class="muted project-span">${p.first === p.last ? md(p.first) : `${md(p.first)} – ${md(p.last)}`}・${p.entries.length} 筆${
        p.personHours - p.hours > 0.01 ? `・👥 人工時 ${fmtH(p.personHours)}` : ""
      }</p>
      <p class="group-split">${PHASE_GROUPS.map(([g, gl]) => `${gl} <strong>${fmtH(rows.filter(([k]) => PHASE_GROUP[k] === g).reduce((a, [k]) => a + p.phases[k], 0))}</strong>`).join("・")}</p>
      ${PHASE_GROUPS.map(([g, gl]) => {
        const gRows = rows.filter(([k]) => PHASE_GROUP[k] === g);
        if (!gRows.length) return "";
        const gh = gRows.reduce((a, [k]) => a + p.phases[k], 0);
        const gp = gRows.reduce((a, [k]) => a + (p.personPhases[k] || 0), 0);
        return `<div class="phase-group"><div class="phase-group-head"><span>${gl}</span><strong>${fmtH(gh)}${
          gp - gh > 0.01 ? `<small>・👥 人工時 ${fmtH(gp)}</small>` : ""
        }</strong></div>
      <div class="phase-bars">${gRows.map(([k, l]) => phaseRow(k, l)).join("")}</div></div>`;
      }).join("")}
      <p class="muted hint">點工作項目看細項，再點細項看明細</p>
      <details class="project-entries"><summary>明細</summary><ul>${p.entries
        .map((e) => `<li><a href="#/log/${e.date}">${md(e.date)}</a> ${e.time}・${esc(phaseLabel[e.phase])}・${formatDuration(e.hours)}<br><span class="muted">${esc(e.plain)}</span></li>`)
        .join("")}</ul></details>
    </section>`;
          })
          .join("")
      : `<section class="card"><p class="muted">這段期間還沒有標上專案的工作紀錄。</p></section>`
  }
  ${
    s.untrackedCount
      ? `<section class="card project untracked">
      <div class="card-head"><h2>未歸類的工作</h2><strong class="project-total">${fmtH(s.untracked)}</strong></div>
      <p class="muted project-span">${s.untrackedCount} 筆沒有標專案，不算在上面的專案裡。點日期到日誌編輯，填「專案」並選工作項目即可歸類。</p>
      <ul class="untracked-list">${s.untrackedEntries
        .map((e) => `<li><a href="#/log/${e.date}">${md(e.date)}</a> ${e.time}・${formatDuration(e.hours)}<br><span>${esc(e.plain)}</span></li>`)
        .join("")}</ul>
    </section>`
      : ""
  }`;
  view.querySelector(".segmented:not(.stats-switch)").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-prange]");
    if (!b) return;
    projectRange = b.dataset.prange;
    viewProjects();
  });
  // Crew size on site entries: rewrite the entry's [crew=N].
  // Attached to this render's cards only, so handlers never pile up on the shared view.
  const onCrew = async (ev) => {
    const b = ev.target.closest(".crew-pick [data-crew]");
    if (!b || b.classList.contains("on")) return;
    const box = b.closest(".crew-pick");
    const old = box.dataset.line;
    const open = [...view.querySelectorAll("details[open]")].map((d) => d.dataset.key).filter(Boolean);
    box.querySelectorAll("button").forEach((x) => (x.disabled = true));
    try {
      await writeLog(box.dataset.date, { a: "replace", old, line: withCrew(old, Number(b.dataset.crew)) });
      toast(`已設為 ${b.dataset.crew} 人`);
      await viewProjects();
      for (const key of open) view.querySelector(`details[data-key="${CSS.escape(key)}"]`)?.setAttribute("open", "");
    } catch (e) {
      toast(errorText(e), true);
      box.querySelectorAll("button").forEach((x) => (x.disabled = false));
    }
  };
  view.querySelectorAll(".project").forEach((card) => card.addEventListener("click", onCrew));
}

async function viewStats() {
  titleEl.textContent = "統計";
  loading();
  const { days, entries } = await allLogs();
  const today = todayTaipei();
  const [start, end] = resolveRange(statsRange.kind, today, statsRange.from, statsRange.to);
  const s = summarize(days, entries, start, end, today);
  let prev = null;
  if (statsRange.kind !== "all") {
    const [ps, pe] = previousRange(statsRange.kind, start, end);
    prev = summarize(days, entries, ps, pe, today);
  }
  const ranges = [
    ["week", "本週"],
    ["month", "本月"],
    ["year", "今年"],
    ["all", "全部"],
    ["custom", "自訂"],
  ];
  const label = start === "0000-01-01" ? "全部紀錄" : `${zhDate(start, false)} – ${zhDate(end, false)}`;
  const delta = (cur, before, unit = "") => {
    if (!prev || before === 0) return "";
    const d = cur - before;
    if (Math.abs(d) < 0.05) return `<span class="delta">與上期相同</span>`;
    return `<span class="delta">${d > 0 ? "▲" : "▼"} ${Math.abs(Math.round(d * 10) / 10)}${unit} vs 上期</span>`;
  };
  const c = s.commitments;

  view.innerHTML = `${statsSwitch("stats")}
  <div class="segmented" role="tablist">${ranges
    .map(([k, l]) => `<button class="${statsRange.kind === k ? "on" : ""}" data-range="${k}">${l}</button>`)
    .join("")}</div>
  <div class="row custom-range" ${statsRange.kind === "custom" ? "" : "hidden"}>
    <label>從<input type="date" id="from" value="${statsRange.from || addDays(today, -29)}"></label>
    <label>到<input type="date" id="to" value="${statsRange.to || today}"></label>
  </div>
  <p class="range-label muted">${label}</p>
  <div class="tiles">
    <div class="tile"><span>總時數（不含睡眠）</span><strong>${fmtH(s.totalHours)}</strong>${delta(s.totalHours, prev ? prev.totalHours : 0, "h")}</div>
    <div class="tile"><span>紀錄</span><strong>${s.entries}<small> 筆</small></strong>${delta(s.entries, prev ? prev.entries : 0, " 筆")}</div>
    <div class="tile"><span>有記錄的天數</span><strong>${s.daysLogged}${s.daysSoFar !== null ? `<small> / ${s.daysSoFar}</small>` : ""}</strong></div>
    <div class="tile"><span>連續記錄</span><strong>${s.streak}<small> 天</small></strong></div>
  </div>
  ${s.entries === 0 ? `<section class="card"><p class="muted">這段期間沒有紀錄。</p></section>` : ""}
  ${s.hours.length ? `<section class="card"><h2>時間分配</h2>${barList(s.hours.map(([cat, h]) => ({ label: CATEGORY_LABEL[cat] || cat, color: seriesVar(cat), value: h, text: `${fmtH(h)}（${Math.round((h / s.totalHours) * 100)}%）` })))}</section>` : ""}
  ${s.totalHours ? `<section class="card"><h2>每${daysBetween(start, end) > 62 ? "月" : "日"}工時</h2>${dailyChart(s, start, end, today)}</section>` : ""}
  ${s.tags.length ? `<section class="card"><h2>標籤（客戶、專案）</h2>${barList(s.tags.map(([t, n, h]) => ({ label: `#${t}`, color: "var(--series-1)", value: h || 0, text: `${h ? fmtH(h) + "・" : ""}${n} 筆` })))}</section>` : ""}
  ${
    s.metrics.length || s.moodAvg !== null || c.due
      ? `<section class="card"><h2>數量、心情與承諾</h2><dl class="kv">
      ${s.metrics.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${Math.round(v * 100) / 100}</dd>`).join("")}
      ${s.moodAvg !== null ? `<dt>心情平均</dt><dd>${s.moodAvg.toFixed(1)}（${s.moodDays} 天）</dd>` : ""}
      ${c.due ? `<dt>說到做到</dt><dd>${c.done} / ${c.due}${c.dropped ? `・取消 ${c.dropped}` : ""}${c.open ? `・未完成 ${c.open}` : ""}</dd>` : ""}
    </dl></section>`
      : ""
  }
  ${
    s.sleep
      ? `<section class="card"><h2>😴 睡眠</h2><dl class="kv">
      <dt>平均睡眠</dt><dd>${formatDuration(s.sleep.avg)}</dd>
      <dt>平均就寢</dt><dd>${s.sleep.avgBedtime}</dd>
      <dt>記錄天數</dt><dd>${s.sleep.nights} 晚</dd>
      ${s.sleep.rated ? `<dt>睡眠狀況</dt><dd>${SLEEP_QUALITY.map(([v, l]) => `${l} ${s.sleep.quality[v] || 0}`).join("・")}</dd>` : ""}
    </dl></section>`
      : ""
  }
  <section class="card"><h2>💪 肌肉痠痛</h2>${
    s.doms.days
      ? `<p class="muted totals">${s.doms.days} 天有記錄・<a href="#/doms">去記錄</a></p>${barList(
          s.doms.byMuscle.map(([k, n]) => ({ label: MUSCLE_LABEL[k] || k, value: n, text: `${n} 天`, color: "#ef8a3c" }))
        )}`
      : `<p class="muted">這段期間還沒有痠痛紀錄。</p><div class="form-actions"><a class="btn small" href="#/doms">💪 記錄今天的痠痛</a></div>`
  }</section>
  ${
    s.exercise.sessions
      ? `<section class="card"><h2>🏃 運動</h2><p class="muted totals">共 ${s.exercise.sessions} 次・${formatDuration(s.exercise.hours)}</p>${barList(
          Object.entries(s.exercise.byType)
            .sort((a, b) => b[1].h - a[1].h)
            .map(([t, v]) => ({ label: EXERCISE_LABEL[t] || t, color: seriesVar("exercise"), value: v.h, text: `${formatDuration(v.h)}・${v.n} 次` }))
        )}</section>`
      : ""
  }
  <section class="card"><h2>熱力圖（最近一年）</h2>${heatmap(entries, today)}</section>`;

  view.querySelector(".segmented:not(.stats-switch)").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-range]");
    if (!b) return;
    statsRange = { ...statsRange, kind: b.dataset.range };
    if (b.dataset.range === "custom") {
      statsRange.from = statsRange.from || addDays(today, -29);
      statsRange.to = statsRange.to || today;
    }
    viewStats();
  });
  view.querySelectorAll(".custom-range input").forEach((i) =>
    i.addEventListener("change", () => {
      statsRange = { kind: "custom", from: document.getElementById("from").value, to: document.getElementById("to").value };
      viewStats();
    })
  );
  view.querySelectorAll(".heat-scroll, .chart-scroll").forEach((el) => (el.scrollLeft = el.scrollWidth));
  bindTips(view);
}

function barList(rows) {
  const max = Math.max(...rows.map((r) => r.value), 0.0001);
  return `<ul class="bars">${rows
    .map(
      (r) => `<li><div class="bar-label"><span>${esc(r.label)}</span><span class="muted">${esc(r.text)}</span></div>
      <div class="bar-track"><div class="bar" style="width:${Math.max(1.5, (r.value / max) * 100)}%;background:${r.color}"></div></div></li>`
    )
    .join("")}</ul>`;
}

function dailyChart(s, start, end, today) {
  const last = end < today ? end : today;
  const first = start === "0000-01-01" ? Object.keys(s.hoursByDay).sort()[0] : start;
  if (!first) return "";
  const monthly = daysBetween(first, last) > 62;
  const buckets = new Map();
  for (let d = first; d <= last; d = addDays(d, 1)) buckets.set(monthly ? d.slice(0, 7) : d, {});
  for (const [d, cats] of Object.entries(s.hoursByDay)) {
    const k = monthly ? d.slice(0, 7) : d;
    if (!buckets.has(k)) continue;
    const b = buckets.get(k);
    for (const [c, h] of Object.entries(cats)) b[c] = (b[c] || 0) + h;
  }
  const keys = [...buckets.keys()];
  const max = Math.max(...[...buckets.values()].map((b) => Object.values(b).reduce((a, x) => a + x, 0)), 1);
  const W = Math.max(300, keys.length * 22);
  const H = 150;
  const pad = { l: 28, b: 20, t: 8 };
  const bw = Math.min(18, (W - pad.l) / keys.length - 4);
  const step = (W - pad.l) / keys.length;
  const y = (h) => H - pad.b - (h / max) * (H - pad.b - pad.t);
  const ticks = [0, max / 2, max].map((t) => Math.round(t * 10) / 10);
  const cats = SERIES.concat(["other"]);
  const used = new Set();
  let bars = "";
  keys.forEach((k, i) => {
    const b = buckets.get(k);
    let acc = 0;
    const x = pad.l + i * step + (step - bw) / 2;
    const parts = Object.entries(b).sort((a, c) => cats.indexOf(SERIES.includes(a[0]) ? a[0] : "other") - cats.indexOf(SERIES.includes(c[0]) ? c[0] : "other"));
    const total = parts.reduce((a, [, h]) => a + h, 0);
    parts.forEach(([c, h], j) => {
      used.add(SERIES.includes(c) ? c : "other");
      const y0 = y(acc + h);
      const hgt = Math.max(0, y(acc) - y0 - (j < parts.length - 1 ? 2 : 0));
      const top = j === parts.length - 1;
      bars += `<path d="${roundedTop(x, y0, bw, hgt, top ? 3 : 0)}" fill="${seriesVar(c)}"/>`;
      acc += h;
    });
    const label = monthly ? `${parseInt(k.slice(5), 10)} 月` : `${parseInt(k.slice(5, 7), 10)}/${parseInt(k.slice(8), 10)}`;
    const tip = `${label}：${total ? parts.map(([c, h]) => `${CATEGORY_LABEL[c] || c} ${formatDuration(h)}`).join("、") : "沒有工時"}`;
    bars += `<rect class="hit" x="${pad.l + i * step}" y="${pad.t}" width="${step}" height="${H - pad.b - pad.t}" data-tip="${esc(tip)}"/>`;
    const every = Math.ceil(keys.length / 10);
    if (i % every === 0 || i === keys.length - 1) bars += `<text class="axis" x="${x + bw / 2}" y="${H - 5}" text-anchor="middle">${label}</text>`;
  });
  const grid = ticks
    .map((t) => `<line class="grid" x1="${pad.l}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="axis" x="${pad.l - 4}" y="${y(t) + 3}" text-anchor="end">${t}</text>`)
    .join("");
  const legend =
    used.size > 1
      ? `<div class="legend">${[...used]
          .map((c) => `<span><i style="background:${seriesVar(c)}"></i>${c === "other" ? "其他" : CATEGORY_LABEL[c]}</span>`)
          .join("")}</div>`
      : "";
  return `<div class="chart-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="工時長條圖">${grid}${bars}</svg></div>${legend}`;
}

function roundedTop(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function heatmap(entries, today) {
  const per = {};
  for (const e of entries) {
    per[e.date] = per[e.date] || { n: 0, h: 0 };
    per[e.date].n++;
    per[e.date].h += e.hours || 0;
  }
  const weeks = 53;
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  const start = addDays(today, -dow - (weeks - 1) * 7);
  const cell = 12;
  const gap = 3;
  const left = 22;
  const top = 16;
  const W = left + weeks * (cell + gap);
  const H = top + 7 * (cell + gap);
  let out = "";
  let lastMonth = null;
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(start, w * 7);
    const m = ws.slice(5, 7);
    if (m !== lastMonth && (w > 0 || parseInt(ws.slice(8), 10) <= 7)) {
      out += `<text class="axis" x="${left + w * (cell + gap)}" y="10">${parseInt(m, 10)}月</text>`;
    }
    lastMonth = m;
    for (let d = 0; d < 7; d++) {
      const date = addDays(ws, d);
      if (date > today) break;
      const v = per[date] || { n: 0, h: 0 };
      const level = v.n === 0 ? 0 : v.n === 1 ? 1 : v.n <= 3 ? 2 : v.n <= 5 ? 3 : 4;
      out += `<rect x="${left + w * (cell + gap)}" y="${top + d * (cell + gap)}" width="${cell}" height="${cell}" rx="2" class="heat l${level}" data-tip="${date}：${v.n} 筆${v.h ? `、${formatDuration(v.h)}` : ""}"/>`;
    }
  }
  [
    [0, "一"],
    [2, "三"],
    [4, "五"],
  ].forEach(([d, l]) => (out += `<text class="axis" x="0" y="${top + d * (cell + gap) + 10}">${l}</text>`));
  const legend = `<div class="legend heat-legend"><span>少</span>${[0, 1, 2, 3, 4].map((l) => `<i class="heat l${l}"></i>`).join("")}<span>多</span></div>`;
  return `<div class="heat-scroll"><svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="每日紀錄熱力圖">${out}</svg></div>${legend}`;
}

// Tap or hover a mark to see its value.
function bindTips(root) {
  const tip = document.getElementById("tip");
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8)}px`;
    tip.style.top = `${Math.max(8, y - r.height - 12)}px`;
  };
  root.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("pointerenter", (ev) => show(el, ev.clientX, ev.clientY));
    el.addEventListener("pointerdown", (ev) => show(el, ev.clientX, ev.clientY));
    el.addEventListener("pointerleave", () => (tip.hidden = true));
  });
}

// ---------- settings ----------

async function viewSettings(_, firstRun) {
  titleEl.textContent = "設定";
  view.innerHTML = `
  ${firstRun ? `<section class="card notice"><h2>第一次使用</h2><p>這個 app 直接讀寫你的私人 repo。請先貼上 GitHub token，資料只存在這支手機的瀏覽器裡。</p></section>` : ""}
  <section class="card">
    <h2>GitHub 連線</h2>
    <form id="settings-form" autocomplete="off">
      <label>Token<input type="password" name="token" value="${esc(settings.token)}" placeholder="github_pat_…" autocapitalize="off" spellcheck="false"></label>
      <details><summary>進階</summary>
        <div class="row">
          <label>Owner<input name="owner" value="${esc(settings.owner)}"></label>
          <label>Repo<input name="repo" value="${esc(settings.repo)}"></label>
        </div>
        <label>Branch<input name="branch" value="${esc(settings.branch)}"></label>
      </details>
      <div class="form-actions">
        ${settings.token ? `<button type="button" class="btn ghost danger" id="clear-btn">清除</button>` : ""}
        <button type="submit" class="btn primary">儲存並測試</button>
      </div>
      <p id="test-result" class="muted"></p>
    </form>
  </section>
  <section class="card" id="place-card">
    <h2>天氣地點</h2>
    <label>城市（手機定位不能用時使用）
      <select id="place-city"><option value="">不設定</option>${CITIES.map(
        ([name]) => `<option value="${name}" ${placeSetting().city === name ? "selected" : ""}>${name}</option>`
      ).join("")}</select>
    </label>
    <label class="check"><input type="checkbox" id="place-fixed" ${placeSetting().fixed ? "checked" : ""}> 一律使用這個城市（不用手機定位）</label>
  </section>
  ${settings.token ? `<section class="card" id="push-card">
    <h2>手機通知</h2>
    <p class="muted" id="push-status">檢查中…</p>
    <div class="form-actions" id="push-actions"></div>
  </section>` : ""}
  <p class="muted diag">app 版本 ${APP_VERSION}</p>
  <section class="card md">
    <h2>如何建立 token</h2>
    <ol>
      <li>打開 <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → Fine-grained token</a></li>
      <li>Token name：<code>pa-app</code>；Expiration：選最長（到期前會無法同步，再建一把即可）</li>
      <li>Repository access：<b>Only select repositories</b> → 只選 <code>${esc(settings.repo)}</code></li>
      <li>Permissions → Repository permissions → <b>Contents：Read and write</b>（其他都不用開）</li>
      <li>Generate token，複製後貼到上面</li>
    </ol>
    <p class="muted">Token 只存在這個瀏覽器，只會傳給 api.github.com。換手機或清除瀏覽器資料後要重新貼上。</p>
  </section>`;

  const form = document.getElementById("settings-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const next = {
      token: form.token.value.trim(),
      owner: form.owner.value.trim(),
      repo: form.repo.value.trim(),
      branch: form.branch.value.trim() || "main",
    };
    const result = document.getElementById("test-result");
    result.textContent = "測試中…";
    try {
      const info = await new Repo(next).check();
      if (info.permissions && info.permissions.push === false) throw Object.assign(new Error("Token 只有讀取權限，請開 Contents：Read and write"), { status: 0 });
      settings = next;
      saveSettings(settings);
      repo = new Repo(settings);
      cache.months.clear();
      cache.files.clear();
      cache.monthList = null;
      result.textContent = `✓ 已連線到 ${info.full_name}`;
      toast("已儲存");
      setTimeout(() => (location.hash = "#/today"), 600);
    } catch (e) {
      result.textContent = `✗ ${errorText(e)}`;
    }
  });
  if (settings.token) renderPush();
  const savePlace = () => {
    savePlaceSetting({ city: document.getElementById("place-city").value, fixed: document.getElementById("place-fixed").checked });
    toast("天氣地點已儲存");
  };
  document.getElementById("place-city").addEventListener("change", savePlace);
  document.getElementById("place-fixed").addEventListener("change", savePlace);
  document.getElementById("clear-btn")?.addEventListener("click", () => {
    if (!confirm("清除這支手機上的 token？")) return;
    clearSettings();
    settings = loadSettings();
    repo = new Repo(settings);
    viewSettings(null, true);
  });
}

async function renderPush() {
  const status = document.getElementById("push-status");
  const actions = document.getElementById("push-actions");
  if (!status) return;
  if (!pushSupported()) {
    status.textContent = "這個瀏覽器不支援推播通知。請用 Chrome 打開，並加到主畫面。";
    actions.innerHTML = "";
    return;
  }
  const { sub, stale } = await currentSubscription().catch(() => ({ sub: null, stale: false }));
  const denied = Notification.permission === "denied";
  status.textContent = sub
    ? "✓ 已開啟。晨報（08:00）和晚上回顧（21:00）會從這個 app 跳通知。"
    : stale
    ? "通知金鑰已更新，請按「開啟通知」重新開啟一次。"
    : denied
    ? "通知權限被封鎖了。請到手機設定 → 應用程式 → Chrome → 通知，允許後再回來開啟。"
    : "還沒開啟。開啟後，晨報和晚上回顧會直接從這個 app 跳通知。";
  actions.innerHTML = sub
    ? `<button type="button" class="btn ghost" id="push-test">本機測試</button><button type="button" class="btn ghost danger" id="push-off">關閉通知</button>`
    : `<button type="button" class="btn primary" id="push-on" ${denied ? "disabled" : ""}>開啟通知</button>`;
  const run = async (btn, fn, done) => {
    btn.disabled = true;
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast(errorText(e), true);
    }
    renderPush();
  };
  document.getElementById("push-on")?.addEventListener("click", (ev) => run(ev.target, () => enablePush(repo), "通知已開啟"));
  document.getElementById("push-off")?.addEventListener("click", (ev) => {
    if (confirm("關閉這支手機的通知？")) run(ev.target, () => disablePush(repo), "通知已關閉");
  });
  document.getElementById("push-test")?.addEventListener("click", (ev) => run(ev.target, showLocalTest));
}

// ---------- boot ----------

document.getElementById("refresh").addEventListener("click", () => {
  cache.months.clear();
  cache.files.clear();
  cache.monthList = null;
  cache.repairs = null;
  route();
});
document.addEventListener("pointerdown", (ev) => {
  if (!ev.target.closest("[data-tip]")) document.getElementById("tip").hidden = true;
});
// The 今天 tab icon shows today's date (Asia/Taipei) and turns over at midnight.
function updateCalendarIcon() {
  const [, m, d] = todayTaipei().split("-").map(Number);
  document.getElementById("cal-month").textContent = `${m}月`;
  document.getElementById("cal-day").textContent = String(d);
}
updateCalendarIcon();
setInterval(updateCalendarIcon, 60000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && updateCalendarIcon());

window.addEventListener("hashchange", route);
document.getElementById("outbox-btn").addEventListener("click", () => (location.hash = "#/outbox"));
// Coming back to the app (e.g. from a notification): drop what was read
// earlier so the brief, review and log are fetched fresh.
let hiddenAt = 0;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 60000) {
    cache.files.clear();
    cache.months.clear();
    cache.monthList = null;
    cache.repairs = null;
    route();
  }
});
window.addEventListener("online", () => {
  offlineUntil = 0;
  flushOutbox();
});
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && flushOutbox());
setInterval(() => outbox.count() && navigator.onLine !== false && flushOutbox(), 60000);
updateOutboxButton();
flushOutbox();
if (!location.hash) history.replaceState(null, "", "#/today");
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

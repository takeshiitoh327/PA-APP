import { Repo, loadSettings, saveSettings, clearSettings } from "./gh.js";
import {
  CATEGORIES,
  CATEGORY_LABEL,
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
import { todayWeather, weatherLine, describe, locationPermission } from "./weather.js";
import { summarize, resolveRange, previousRange, openCommitments, addDays, daysBetween } from "./stats.js";
import { pushSupported, currentSubscription, enablePush, disablePush, showLocalTest } from "./push.js";

const TZ = "Asia/Taipei";
const view = document.getElementById("view");
const titleEl = document.getElementById("title");
let settings = loadSettings();
let repo = new Repo(settings);

// Months are fetched lazily and kept for the session; ↻ clears them.
const cache = { months: new Map(), monthList: null, files: new Map() };

// Fixed category -> color slot, so a category keeps its color in every chart.
const SERIES = ["work", "meeting", "learning", "health", "life", "family", "social", "finance"];
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
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "show error" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), isError ? 6000 : 2500);
}

function errorText(e) {
  if (e.status === 401) return "Token 無效或已過期，請到設定更新";
  if (e.status === 403) return "Token 權限不足（需要 Contents 讀寫）或已達 API 上限";
  if (e instanceof TypeError) return "網路連線失敗，請稍後再試";
  return e.message || String(e);
}

function loading(msg = "讀取中…") {
  view.innerHTML = `<div class="loading"><span class="spinner"></span>${esc(msg)}</div>`;
}

// ---------- data ----------

async function getText(path) {
  if (!cache.files.has(path)) cache.files.set(path, repo.getFile(path).then((f) => (f ? f.text : null)));
  return cache.files.get(path);
}

async function getMonth(month) {
  if (!cache.months.has(month)) {
    cache.months.set(
      month,
      repo.getFile(`logs/${month}.md`).then((f) => ({ text: f ? f.text : null, days: parseMonth(f ? f.text : "") }))
    );
  }
  return cache.months.get(month);
}

async function allLogs() {
  if (!cache.monthList) {
    cache.monthList = repo
      .listDir("logs")
      .then((files) => files.map((f) => f.name).filter((n) => /^\d{4}-\d{2}\.md$/.test(n)).map((n) => n.slice(0, 7)).sort());
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

async function writeLog(date, transform, message) {
  const path = monthPath(date);
  await repo.updateFile(path, transform, message || `Log: ${date}`);
  cache.months.delete(date.slice(0, 7));
  cache.monthList = null;
}

// ---------- views ----------

const routes = {
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
  document.querySelectorAll("nav.tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === (name === "brief" || name === "review" ? "today" : name)));
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
  const metrics = Object.entries(e.metrics);
  const status = e.category === "plan" ? (e.status === "done" ? "✓ 完成" : e.status === "dropped" ? "✗ 取消" : e.due ? `到期 ${e.due.slice(5).replace("-", "/")}` : "") : "";
  return `<li class="entry ${e.category === "plan" ? `plan ${e.status}` : ""}">
    <div class="entry-time">${e.time}${end ? `<i class="time-line" aria-hidden="true"></i><span><span class="sr-only">至 </span>${end}</span>` : ""}</div>
    <div class="entry-body">
      <div class="entry-text">${esc(e.plain)}</div>
      <div class="entry-meta">
        <span class="cat"><i style="background:${seriesVar(e.category)}"></i>${esc(CATEGORY_LABEL[e.category] || e.category)}</span>
        ${e.hours ? `<span>${formatDuration(e.hours)}</span>` : ""}
        ${status ? `<span>${status}</span>` : ""}
        ${metrics.map(([k, v]) => `<span class="metric">${esc(k)} ${v}</span>`).join("")}
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

function dayTotals(entries) {
  const by = {};
  for (const e of entries) if (e.hours) by[e.category] = (by[e.category] || 0) + e.hours;
  const parts = Object.entries(by).map(([c, h]) => `${CATEGORY_LABEL[c] || c} ${formatDuration(h)}`);
  return parts.length ? `合計：${parts.join("、")}` : "";
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
      : day && day.weather
      ? `<section class="card weather"><p class="weather-saved">${esc(day.weather)}</p></section>`
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
    ${brief ? renderMarkdown(brief) : `<p class="muted">${isToday ? "今天的晨報還沒產生（每天 08:00）。" : "這天沒有晨報。"}</p>`}
  </section>
  <section class="card md" id="sec-review">
    <h2>晚上回顧</h2>
    ${review ? renderMarkdown(review) : `<p class="muted">${isToday ? "晚上回顧還沒產生（每天 21:00）。" : "這天沒有晚上回顧。"}</p>`}
  </section>`;
  if (focus) document.getElementById(`sec-${focus}`)?.scrollIntoView({ block: "start" });
  if (isToday) loadWeather(date, day);
}

// Shows today's weather and, the first time each day, writes it to the log.
async function loadWeather(date, day, tapped = false) {
  const card = document.getElementById("weather-card");
  if (!tapped && (await locationPermission()) !== "granted") {
    card.innerHTML = `<div class="weather-ask"><p class="muted">按一下取得目前位置的天氣，之後每天打開會自動顯示。</p>
      <button type="button" class="btn primary" id="weather-ask">📍 取得今天天氣</button></div>`;
    document.getElementById("weather-ask").addEventListener("click", () => {
      card.innerHTML = `<p class="muted">取得天氣中…</p>`;
      loadWeather(date, day, true);
    });
    return;
  }
  try {
    const w = await todayWeather();
    if (!card.isConnected) return;
    const today = describe(w.code);
    const now = describe(w.nowCode);
    card.innerHTML = `<div class="weather-row">
      <div class="weather-icon" aria-hidden="true">${now.icon}</div>
      <div class="weather-main"><strong>${w.now}°C</strong><span>${esc(w.place)}・現在${esc(now.text)}</span></div>
      <div class="weather-day"><span>${today.icon} ${esc(today.text)}</span><span>${w.min}–${w.max}°C</span>${
        w.rain !== null && w.rain !== undefined ? `<span>降雨 ${w.rain}%</span>` : ""
      }</div>
    </div>${w.rain >= 50 ? `<p class="weather-tip">☂️ 今天降雨機率高，記得帶傘</p>` : ""}`;
    if (!day || !day.weather) {
      await writeLog(date, (text) => setWeather(text, date, weatherLine(w, nowTaipei(1))), `Weather: ${date}`);
    }
  } catch (e) {
    if (card.isConnected) {
      card.innerHTML = `<p class="muted">天氣：${esc(e.message || "無法取得")}${
        /權限/.test(e.message) ? "（Chrome 網址列左邊的設定圖示 → 權限 → 位置，或手機設定 → 應用程式 → Chrome → 權限 → 位置）" : ""
      }</p><div class="form-actions"><button type="button" class="btn small" id="weather-retry">重試</button></div>`;
      document.getElementById("weather-retry").addEventListener("click", () => {
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
  const metricNames = [...new Set(all.entries.flatMap((e) => Object.keys(e.metrics)))];

  view.innerHTML = `${dateNav(date, "log")}
  <section class="card">
    <div class="card-head"><h2>這天的紀錄</h2><span class="muted">${entries.length} 筆</span></div>
    ${entries.length ? `<ul class="entries">${entries.map((e) => entryRow(e, { actions: true })).join("")}</ul><p class="muted totals">${esc(dayTotals(entries))}</p>` : `<p class="muted">還沒有紀錄。</p>`}
    <div class="mood"><span>心情</span>${[1, 2, 3, 4, 5]
      .map((n) => `<button class="mood-btn ${day && day.mood === n ? "on" : ""}" data-mood="${n}" aria-label="心情 ${n}">${n}</button>`)
      .join("")}</div>
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

  const setCategory = (c) => {
    category = c;
    document.querySelectorAll("#cat-chips .chip").forEach((b) => b.classList.toggle("on", b.dataset.cat === c));
    document.getElementById("due-row").hidden = c !== "plan";
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
    const line = buildEntryLine({
      time: start,
      category,
      hours,
      text: form.text.value.trim(),
      tags: [...new Set(form.tags.value.split(/\s+/).filter(Boolean).map(normalizeTag))],
      metrics,
      due: category === "plan" ? form.due.value : null,
    });
    const old = editing;
    const ok = await busy(document.getElementById("save-btn"), () =>
      writeLog(date, (text) => (old ? replaceEntry(text, date, old, line) : addEntry(text, date, line)))
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
      form.tags.value = e.tags.filter((t) => !["done", "dropped", "moved"].includes(t)).join(" ");
      const [m] = Object.entries(e.metrics);
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
    const ok = await busy(btn, () => writeLog(date, (text) => replaceEntry(text, date, e.line, newLine)));
    if (ok) {
      toast(act === "delete" ? "已刪除" : act === "done" ? "已標為完成" : "已取消計畫");
      viewLog(date);
    }
  });

  view.querySelector(".mood").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-mood]");
    if (!b) return;
    const mood = day && day.mood === Number(b.dataset.mood) ? null : Number(b.dataset.mood);
    const ok = await busy(b, () => writeLog(date, (text) => setMood(text, date, mood)));
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

// ---------- stats ----------

let statsRange = { kind: "week", from: null, to: null };

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

  view.innerHTML = `
  <div class="segmented" role="tablist">${ranges
    .map(([k, l]) => `<button class="${statsRange.kind === k ? "on" : ""}" data-range="${k}">${l}</button>`)
    .join("")}</div>
  <div class="row custom-range" ${statsRange.kind === "custom" ? "" : "hidden"}>
    <label>從<input type="date" id="from" value="${statsRange.from || addDays(today, -29)}"></label>
    <label>到<input type="date" id="to" value="${statsRange.to || today}"></label>
  </div>
  <p class="range-label muted">${label}</p>
  <div class="tiles">
    <div class="tile"><span>總工時</span><strong>${fmtH(s.totalHours)}</strong>${delta(s.totalHours, prev ? prev.totalHours : 0, "h")}</div>
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
  <section class="card"><h2>熱力圖（最近一年）</h2>${heatmap(entries, today)}</section>`;

  view.querySelector(".segmented").addEventListener("click", (ev) => {
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
  ${settings.token ? `<section class="card" id="push-card">
    <h2>手機通知</h2>
    <p class="muted" id="push-status">檢查中…</p>
    <div class="form-actions" id="push-actions"></div>
  </section>` : ""}
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
  route();
});
document.addEventListener("pointerdown", (ev) => {
  if (!ev.target.closest("[data-tip]")) document.getElementById("tip").hidden = true;
});
window.addEventListener("hashchange", route);
if (!location.hash) history.replaceState(null, "", "#/today");
route();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

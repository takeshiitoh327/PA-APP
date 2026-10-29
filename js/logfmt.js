// Reads and edits the daily log format used by personal-assistant
// (logs/YYYY-MM.md, see .claude/skills/log/SKILL.md there):
//
//   ## 2026-10-28 (Wed) · mood 4
//   - 13:30 · work · 3h · 製作控制盤 #client [panels=2]

export const CATEGORIES = [
  ["work", "工作"],
  ["meeting", "會議"],
  ["learning", "學習"],
  ["health", "健康"],
  ["life", "生活"],
  ["family", "家庭"],
  ["social", "社交"],
  ["finance", "財務"],
  ["errand", "雜事"],
  ["idea", "想法"],
  ["plan", "計畫"],
];
export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES);

const DAY_RE = /^## (\d{4}-\d{2}-\d{2})\b(?:.*?mood (\d(?:\.\d)?))?/;
const ENTRY_RE = /^- (\d{1,2}:\d{2}) · ([\w-]+) · (.*)$/;
const DURATION_RE = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/;
const TAG_RE = /(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_-]+)/gu;
const METRIC_RE = /\[([\p{L}\p{N}_-]+)=(-?\d+(?:\.\d+)?)\]/gu;
const DUE_RE = /\(due (\d{4}-\d{2}-\d{2})\)/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekday(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function monthPath(date) {
  return `logs/${date.slice(0, 7)}.md`;
}

export function parseDuration(text) {
  const m = DURATION_RE.exec(text.trim());
  if (!m || !(m[1] || m[2])) return null;
  return parseFloat(m[1] || 0) + parseInt(m[2] || 0, 10) / 60;
}

export function formatDuration(hours) {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}` || "0m";
}

export function parseEntryLine(line) {
  const m = ENTRY_RE.exec(line);
  if (!m) return null;
  const rest = m[3].split(" · ");
  let hours = null;
  let text = m[3];
  if (rest.length >= 2) {
    hours = parseDuration(rest[0]);
    if (hours !== null) text = rest.slice(1).join(" · ");
  }
  const tags = [...text.matchAll(TAG_RE)].map((t) => t[1].toLowerCase());
  const metrics = {};
  for (const [, k, v] of text.matchAll(METRIC_RE)) metrics[k] = (metrics[k] || 0) + parseFloat(v);
  const due = DUE_RE.exec(text);
  return {
    time: m[1].padStart(5, "0"),
    category: m[2].toLowerCase(),
    hours,
    text,
    plain: text.replace(TAG_RE, "").replace(METRIC_RE, "").replace(DUE_RE, "").replace(/\s+/g, " ").trim(),
    tags,
    metrics,
    due: due ? due[1] : null,
    status: tags.includes("done") ? "done" : tags.includes("dropped") ? "dropped" : "open",
    line,
  };
}

// Returns Map(date -> { mood, entries }) in file order.
export function parseMonth(text) {
  const days = new Map();
  let current = null;
  for (const line of (text || "").split("\n")) {
    const d = DAY_RE.exec(line);
    if (d) {
      current = { date: d[1], mood: d[2] ? parseFloat(d[2]) : null, entries: [] };
      days.set(d[1], current);
      continue;
    }
    const e = current && parseEntryLine(line);
    if (e) {
      e.date = current.date;
      current.entries.push(e);
    }
  }
  return days;
}

export function buildEntryLine({ time, category, hours, text, tags = [], metrics = [], due }) {
  const parts = [`- ${time} · ${category}`];
  if (hours) parts.push(formatDuration(hours));
  let body = text.replace(/\s*\n\s*/g, "；").trim();
  if (due) body += ` (due ${due})`;
  for (const t of tags) body += ` #${t}`;
  for (const [k, v] of metrics) body += ` [${k}=${v}]`;
  parts.push(body);
  return parts.join(" · ");
}

// Normalizes a tag the way the log skill does: no spaces, ASCII lowercased.
export function normalizeTag(tag) {
  return tag.trim().replace(/^#/, "").replace(/\s+/g, "-").replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function dayHeading(date, mood) {
  return `## ${date} (${weekday(date)})${mood ? ` · mood ${mood}` : ""}`;
}

function findDay(lines, date) {
  const start = lines.findIndex((l) => l.startsWith(`## ${date}`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return { start, end };
}

function ensureDay(lines, date) {
  let day = findDay(lines, date);
  if (day) return day;
  let at = lines.findIndex((l) => {
    const m = DAY_RE.exec(l);
    return m && m[1] > date;
  });
  const block = [dayHeading(date), ""];
  if (at < 0) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("", ...block);
  } else {
    lines.splice(at, 0, ...block);
  }
  return findDay(lines, date);
}

function finish(lines) {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n");
}

function newFile(date) {
  return [`# Daily log — ${date.slice(0, 7)}`, ""];
}

export function addEntry(text, date, line) {
  const lines = text ? text.replace(/\n*$/, "").split("\n") : newFile(date);
  const day = ensureDay(lines, date);
  const time = parseEntryLine(line).time;
  let at = day.start + 1;
  for (let i = day.start + 1; i < day.end; i++) {
    const e = parseEntryLine(lines[i]);
    if (e && e.time <= time) at = i + 1;
  }
  lines.splice(at, 0, line);
  return finish(lines);
}

export function replaceEntry(text, date, oldLine, newLine) {
  const lines = text.split("\n");
  const day = findDay(lines, date);
  if (!day) throw new Error("找不到這一天");
  const i = lines.slice(day.start, day.end).indexOf(oldLine);
  if (i < 0) throw new Error("找不到這筆紀錄，可能已被修改，請重新整理");
  if (newLine === null) lines.splice(day.start + i, 1);
  else lines[day.start + i] = newLine;
  return finish(lines);
}

export function setMood(text, date, mood) {
  const lines = text ? text.replace(/\n*$/, "").split("\n") : newFile(date);
  const day = ensureDay(lines, date);
  lines[day.start] = dayHeading(date, mood);
  return finish(lines);
}

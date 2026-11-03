// Changes saved while the phone is offline. Each change is kept as data (not
// as finished file text), so when it is uploaded it is applied to the latest
// copy of the file on GitHub and never overwrites entries written elsewhere
// in the meantime.
//
// Kinds:
//   { kind: "log", date, a: "add", line }
//   { kind: "log", date, a: "replace", old, line }   (line null = delete)
//   { kind: "log", date, a: "mood", mood }
//   { kind: "log", date, a: "weather", line }
//   { kind: "repair", date, rec }

import { addEntry, replaceEntry, setMood, setWeather } from "./logfmt.js";
import { addRepair, repairPath } from "./repairs.js";

const KEY = "pa-app.outbox";
const COPY_PREFIX = "pa-app.copy:";

export function list() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function store(ops) {
  localStorage.setItem(KEY, JSON.stringify(ops));
}

export function add(op) {
  const ops = list();
  ops.push({ ...op, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString() });
  store(ops);
}

export function remove(id) {
  store(list().filter((o) => o.id !== id));
}

export function setError(id, message) {
  store(list().map((o) => (o.id === id ? { ...o, error: message } : o)));
}

export function count() {
  return list().length;
}

export function pathOf(op) {
  return op.kind === "repair" ? repairPath(op.date) : `logs/${op.date.slice(0, 7)}.md`;
}

// The change as a function from the file's text to the new text.
export function transformOf(op) {
  if (op.kind === "repair") return (text) => addRepair(text, op.rec);
  const d = op.date;
  if (op.a === "add") return (text) => addEntry(text, d, op.line);
  if (op.a === "replace") return (text) => replaceEntry(text, d, op.old, op.line);
  if (op.a === "mood") return (text) => setMood(text, d, op.mood);
  if (op.a === "weather") return (text) => setWeather(text, d, op.line);
  throw new Error(`Unknown change ${op.a}`);
}

export function messageOf(op) {
  if (op.kind === "repair") return `Repair: ${op.date} ${op.rec.customer}`;
  return op.a === "weather" ? `Weather: ${op.date}` : `Log: ${op.date}`;
}

// Applies the waiting changes for one file on top of its text, for display.
export function overlay(path, text) {
  let out = text;
  for (const op of list()) {
    if (pathOf(op) !== path) continue;
    try {
      out = transformOf(op)(out);
    } catch {
      // A change that no longer fits (e.g. the entry was edited elsewhere)
      // is shown in the waiting list instead.
    }
  }
  return out;
}

// Lines and repairs still waiting, so the views can mark them with ⏳.
export function waitingLines() {
  const s = new Set();
  for (const op of list()) if (op.kind === "log" && op.line) s.add(op.line);
  return s;
}

export function waitingRepairs() {
  return list()
    .filter((o) => o.kind === "repair")
    .map((o) => `${o.date}|${o.rec.customer}|${o.rec.machine}`);
}

// Month paths that only exist as waiting changes so far.
export function waitingPaths(prefix) {
  return [...new Set(list().map(pathOf).filter((p) => p.startsWith(prefix)))];
}

// Last copy of a file read from GitHub, for reading while offline.
export function saveCopy(path, text) {
  try {
    localStorage.setItem(COPY_PREFIX + path, JSON.stringify(text));
  } catch {}
}

export function loadCopy(path) {
  try {
    const v = localStorage.getItem(COPY_PREFIX + path);
    return v === null ? undefined : JSON.parse(v);
  } catch {
    return undefined;
  }
}

export function describe(op) {
  if (op.kind === "repair") return `🔧 ${op.date} ${op.rec.customer}・${op.rec.machine}`;
  if (op.a === "mood") return `😊 ${op.date} 心情 ${op.mood ?? "清除"}`;
  if (op.a === "weather") return `🌤️ ${op.date} 天氣`;
  if (op.a === "replace" && op.line === null) return `🗑️ ${op.date} 刪除 ${op.old.replace(/^- /, "")}`;
  return `${op.a === "replace" ? "✏️" : "📝"} ${op.date} ${op.line.replace(/^- /, "")}`;
}

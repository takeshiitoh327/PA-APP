// Property checks for the file formats. These run in Node with no browser.
// Each property is tried on many random inputs from a seeded generator, so
// a failure prints the seed and the input and can be replayed.

import fs from "node:fs";
import path from "node:path";
import { ROOT, assert, eq } from "../harness.mjs";
import { buildEntryLine, parseEntryLine, addEntry, replaceEntry, parseMonth, setMood, formatDuration, parseDuration, EXERCISES } from "../../js/logfmt.js";
import { parseClosed, setClosed } from "../../js/projects.js";
import { addRepair, removeRepair, replaceRepair, parseRepairs, buildRepair, FIELDS } from "../../js/repairs.js";

const RUNS = 300;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const int = (r, a, b) => a + Math.floor(r() * (b - a + 1));
const WORDS = ["配盤", "現場配線", "測試", "報價", "跑步", "PLC 修改", "換 relay", "A/B 線", "盤體(2)", "x+y", "100%"];
const text = (r) => Array.from({ length: int(r, 1, 3) }, () => pick(r, WORDS)).join(pick(r, [" ", "，", ""]));
const time = (r) => `${String(int(r, 0, 23)).padStart(2, "0")}:${String(int(r, 0, 11) * 5).padStart(2, "0")}`;
const date = (r) => `2026-11-${String(int(r, 1, 30)).padStart(2, "0")}`;

function entry(r) {
  return {
    time: time(r),
    category: pick(r, ["work", "exercise", "health", "life", "learn"]),
    hours: pick(r, [0, 0.25, 0.5, 1, 1.5, 2 + int(r, 0, 11) * 5 / 60]),
    text: text(r),
    tags: r() < 0.5 ? [pick(r, ["run", "basketball", "doms", "測試客戶"])] : [],
    metrics: r() < 0.4 ? [[pick(r, ["km", "doms_quads", "panels"]), int(r, 1, 9)]] : [],
    project: r() < 0.3 ? pick(r, ["測試專案A", "Proj-B"]) : undefined,
  };
}

function property(name, fn) {
  return {
    name,
    run() {
      for (let seed = 1; seed <= RUNS; seed++) {
        try {
          fn(rng(seed));
        } catch (e) {
          e.message = `${e.message}\n    (seed ${seed})`;
          throw e;
        }
      }
    },
  };
}

export default [
  {
    name: "APP_VERSION and service worker cache name match",
    run() {
      const app = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8").match(/APP_VERSION = "(V[\d.]+)"/);
      const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").match(/VERSION = "pa-app-(V[\d.]+)"/);
      assert(app && sw, "version strings not found");
      eq(sw[1], app[1], "bump both js/app.js APP_VERSION and sw.js VERSION");
    },
  },
  {
    name: "service worker caches every app module (else the app breaks offline)",
    run() {
      const sw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
      const js = fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js"));
      const missing = js.filter((f) => !sw.includes(`"js/${f}"`));
      eq(missing, [], "add these to SHELL in sw.js");
    },
  },
  {
    name: "closed projects: status lines parse, other lines are ignored",
    run() {
      const m = parseClosed("# Project status\n\nSome note.\n- 迎廣50T · closed 2026-11-24\n- Proj-B · closed 2026-12-01 \n- 半句 · closed\n");
      eq([...m], [["迎廣50T", "2026-11-24"], ["Proj-B", "2026-12-01"]], "parsed");
      eq(parseClosed(null).size, 0, "missing file");
    },
  },
  property("closed projects: close, reopen and close twice keep the file well-formed", (r) => {
    let file = r() < 0.3 ? null : "# Project status\n\nNote line.\n";
    const names = ["迎廣50T", "Proj-B", "測試 機台", "a.b-c"];
    for (const n of names) if (r() < 0.5) file = setClosed(file, n, date(r));
    const base = setClosed(file, "X", null);
    const n = pick(r, names);
    const d = date(r);
    const closed = setClosed(base, n, d);
    eq(parseClosed(closed).get(n), d, "closed date");
    eq(setClosed(closed, n, d), closed, "closing twice changed the file");
    eq(parseClosed(setClosed(closed, n, null)).has(n), false, "reopened");
    for (const [k, v] of parseClosed(base)) if (k !== n) eq(parseClosed(closed).get(k), v, "other projects untouched");
    assert(!/\n\n\n/.test(closed) && closed.endsWith("\n") && !closed.endsWith("\n\n"), "blank lines");
  }),
  {
    name: "every exercise type has a unique ASCII tag and a label",
    run() {
      const tags = EXERCISES.map(([t]) => t);
      eq(new Set(tags).size, tags.length, "duplicate exercise tag");
      for (const [t, l] of EXERCISES) assert(/^[a-z]+$/.test(t) && l, `bad exercise ${t}`);
    },
  },
  property("duration: format then parse gives the same minutes", (r) => {
    const mins = int(r, 1, 24 * 60);
    eq(Math.round(parseDuration(formatDuration(mins / 60)) * 60), mins, `duration ${mins}m`);
  }),
  property("entry line: build then parse keeps time, category, hours, tags, metrics, project", (r) => {
    const e = entry(r);
    const line = buildEntryLine(e);
    const p = parseEntryLine(line);
    assert(p, `does not parse: ${line}`);
    eq([p.time, p.category], [e.time, e.category], `time/category of ${line}`);
    eq(p.hours === null ? 0 : Math.round(p.hours * 60), Math.round(e.hours * 60), `hours of ${line}`);
    eq(p.tags, e.tags.map((t) => t.toLowerCase()), `tags of ${line}`);
    eq(Object.entries(p.metrics), e.metrics, `metrics of ${line}`);
    eq(p.project, e.project || null, `project of ${line}`);
  }),
  property("log file: adding entries keeps every line, sorted, and is idempotent", (r) => {
    let file = "";
    const added = [];
    for (let i = int(r, 1, 8); i > 0; i--) {
      const d = date(r);
      const line = buildEntryLine({ ...entry(r), category: "work" });
      file = addEntry(file, d, line);
      added.push([d, line]);
    }
    eq(addEntry(file, ...added[0]), file, "adding the same line twice changed the file");
    const days = parseMonth(file);
    for (const [d, line] of added) assert(days.get(d).entries.some((e) => e.line === line), `lost ${line}`);
    const heads = file.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3, 13));
    eq(heads, [...heads].sort(), "days out of order");
    assert(!/\n\n\n/.test(file) && file.endsWith("\n") && !file.endsWith("\n\n"), "blank lines broken");
  }),
  property("log file: replace then replace back restores the file", (r) => {
    const d = date(r);
    const a = buildEntryLine({ ...entry(r), category: "work" });
    const b = buildEntryLine({ ...entry(r), category: "life" });
    if (a === b) return;
    const file = setMood(addEntry(addEntry("", d, a), date(r), buildEntryLine(entry(r))), d, 4);
    eq(replaceEntry(replaceEntry(file, d, a, b), d, b, a), file, "round trip changed the file");
  }),
  property("repair file: add, edit and remove keep the other records untouched", (r) => {
    const rec = (n) => {
      const x = { date: date(r), customer: `測試公司${n}`, machine: pick(r, ["沖床", "打包機", "測試機台"]) };
      for (const [k] of FIELDS) if (r() < 0.5) x[k] = text(r);
      return x;
    };
    let file = "";
    const recs = Array.from({ length: int(r, 1, 5) }, (_, i) => rec(i));
    for (const x of recs) file = addRepair(file, x);
    const parsed = parseRepairs(file);
    eq(parsed.length, recs.length, "record count");
    eq(parsed.map((x) => x.date), parsed.map((x) => x.date).sort(), "records out of date order");
    const target = pick(r, recs);
    const edited = { ...target, symptom: "新現象" };
    const after = replaceRepair(file, target, edited);
    const others = (f) => parseRepairs(f).filter((x) => x.customer !== target.customer).map(buildRepair);
    eq(others(after), others(file), "editing one record changed another");
    eq(parseRepairs(after).find((x) => x.customer === target.customer).symptom, "新現象", "edit not applied");
    eq(parseRepairs(removeRepair(file, target)).length, recs.length - 1, "remove");
    let threw = false;
    try {
      removeRepair(file, { ...target, machine: "不存在" });
    } catch {
      threw = true;
    }
    assert(threw, "removing a missing record must throw, not guess");
  }),
];

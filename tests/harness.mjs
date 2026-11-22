// Test harness for the PWA: serves the app from this checkout, fakes the
// GitHub Contents API in memory, blocks weather and geocoding hosts, and
// pins the clock. Every check in tests/e2e and tests/unit uses it.
//
// Fixtures are synthetic. This repo is public, so never copy real log or
// repair files in here.

import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((q, r) => {
      let p = path.join(ROOT, decodeURIComponent(q.url.split("?")[0]));
      if (!p.startsWith(ROOT)) return r.writeHead(403), r.end();
      if (p.endsWith("/")) p += "index.html";
      fs.readFile(p, (e, d) => {
        if (e) return r.writeHead(404), r.end();
        r.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
        r.end(d);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

export const FIXTURES = {
  "logs/2026-11.md": `# Daily log — 2026-11

## 2026-11-03 (Tue)
- 09:15 · work · 2h35m · 配盤 @測試專案A #wiring
- 18:30 · exercise · 40m · 跑步 #run [km=5]

## 2026-11-04 (Wed) · mood 4
- 08:00 · work · 3h · 現場配線 @測試專案A #site-work [crew=2]
`,
  "logs/2026-10.md": `# Daily log — 2026-10

## 2026-10-30 (Fri)
- 10:00 · work · 1h · 報價 #測試客戶
`,
  "field/repairs/2026-11.md": `# Repairs — 2026-11

## 2026-11-02 · 測試公司甲 · 測試機台
- 直接客戶：測試公司甲
- 維修內容：更換繼電器；調整參數
`,
};

// GitHub mock. Each PUT bumps the file's sha. With `stale` on, GETs of a file
// keep returning the copy from before its last PUT, the way GitHub's replicas
// sometimes do right after a write.
class FakeGitHub {
  constructor(files) {
    this.files = { ...files };
    this.sha = Object.fromEntries(Object.keys(this.files).map((k) => [k, "s0"]));
    this.prev = {};
    this.puts = [];
    this.stale = false;
    this.online = true;
  }
  async handle(rt) {
    if (!this.online) return rt.abort("internetdisconnected");
    const req = rt.request();
    const p = decodeURIComponent(new URL(req.url()).pathname.replace(/^\/repos\/[^/]+\/[^/]+\/?/, "").replace(/^contents\/?/, ""));
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData());
      if (this.files[p] !== undefined && body.sha !== this.sha[p]) return rt.fulfill({ status: 409, json: { message: "sha mismatch" } });
      this.prev[p] = { text: this.files[p], sha: this.sha[p] };
      this.files[p] = Buffer.from(body.content, "base64").toString();
      this.sha[p] = `s${this.puts.length + 1}`;
      this.puts.push({ path: p, message: body.message });
      return rt.fulfill({ json: { content: { sha: this.sha[p] } } });
    }
    const old = this.stale && this.prev[p];
    if (old && old.text !== undefined) return rt.fulfill({ json: { content: Buffer.from(old.text).toString("base64"), sha: old.sha } });
    if (this.files[p] !== undefined) return rt.fulfill({ json: { content: Buffer.from(this.files[p]).toString("base64"), sha: this.sha[p] } });
    const kids = [...new Set(Object.keys(this.files).filter((k) => k.startsWith(p + "/")).map((k) => k.slice(p.length + 1).split("/")[0]))];
    return kids.length ? rt.fulfill({ json: kids.map((name) => ({ name })) }) : rt.fulfill({ status: 404, json: {} });
  }
}

// Starts the app. Returns { page, gh, url(hash), errors, close }.
// `errors` collects uncaught page errors and console errors; checks fail on
// any of them unless they expect it.
export async function start({ files = FIXTURES, now = "2026-11-04T20:00:00+08:00", settings = {}, storage = {} } = {}) {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR_FAILED/.test(m.text()) && errors.push(`console: ${m.text()}`));
  const gh = new FakeGitHub(files);
  await page.clock.setFixedTime(new Date(now));
  await page.route("https://api.github.com/**", (rt) => gh.handle(rt));
  await page.route(/open-meteo|nominatim|cwa\.gov|opendata\.cwa|met\.no/, (rt) => rt.abort());
  await page.addInitScript(
    ([s, st]) => {
      if (sessionStorage.getItem("pa-test-init")) return;
      sessionStorage.setItem("pa-test-init", "1");
      localStorage.setItem("pa-app.settings", JSON.stringify({ token: "t", ...s }));
      for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v);
    },
    [settings, storage]
  );
  return {
    page,
    ctx,
    gh,
    errors,
    base,
    url: (hash) => base + hash,
    async goto(hash) {
      await page.goto(base + hash);
    },
    async close() {
      await browser.close();
      srv.close();
    },
  };
}

export class AssertionError extends Error {}
export function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}
export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg}\n    expected: ${e}\n    actual:   ${a}`);
}

// Lines added and removed between two versions of a file.
export function lineDiff(before = "", after = "") {
  const A = before.split("\n"), B = after.split("\n");
  return { added: B.filter((l) => !A.includes(l)), removed: A.filter((l) => !B.includes(l)) };
}

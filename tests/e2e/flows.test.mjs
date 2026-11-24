// End-to-end checks: drive the real app in Chromium the way the user does on
// the phone, then check what was written to the (fake) GitHub repo.

import { start, assert, eq, lineDiff, FIXTURES } from "../harness.mjs";
import { EXERCISES } from "../../js/logfmt.js";

const LOG = "logs/2026-11.md";
const REPAIRS = "field/repairs/2026-11.md";

// Runs fn with a fresh app and fails on any page error the check did not expect.
function flow(name, fn, opts) {
  return {
    name,
    async run(ctx) {
      const app = await start(opts);
      try {
        await fn(app);
        assert(!app.errors.length, `page errors:\n    ${app.errors.join("\n    ")}`);
      } catch (e) {
        await app.page.screenshot({ path: ctx.shot(name) }).catch(() => {});
        throw e;
      } finally {
        await app.close();
      }
    },
  };
}

async function waitPuts(app, n) {
  for (let i = 0; i < 80 && app.gh.puts.length < n; i++) await app.page.waitForTimeout(100);
  assert(app.gh.puts.length >= n, `expected ${n} write(s) to GitHub, got ${app.gh.puts.length}`);
}

export default [
  flow("every page opens without errors", async (app) => {
    const pages = [
      ["#/today", "#view"],
      ["#/log/2026-11-03", ".entry"],
      ["#/stats", "#view"],
      ["#/projects", "#view"],
      ["#/repairs", ".repair"],
      ["#/doms", "polygon.m"],
      ["#/health", "#view"],
      ["#/outbox", "#view"],
      ["#/settings", "#view"],
    ];
    for (const [hash, sel] of pages) {
      await app.goto(hash);
      await app.page.waitForSelector(sel, { timeout: 8000 });
      await app.page.waitForTimeout(300);
      const t = await app.page.locator("#view").innerText();
      assert(t.trim().length > 0, `${hash} is empty`);
      assert(!/undefined|NaN|\[object Object\]/.test(t), `${hash} shows undefined/NaN:\n${t.slice(0, 400)}`);
    }
    eq(app.gh.puts.length, 0, "opening pages must not write anything");
  }),

  flow("switching pages quickly: the slower earlier page does not draw over the new one", async (app) => {
    // Slow GitHub down so #/today is still loading when the user taps 日誌.
    await app.page.route("https://api.github.com/**", async (rt) => {
      await new Promise((r) => setTimeout(r, 400));
      return rt.fallback();
    });
    await app.goto("#/today");
    await app.page.waitForTimeout(100);
    await app.page.evaluate(() => (location.hash = "#/log/2026-11-03"));
    await app.page.waitForSelector("#entry-form", { timeout: 8000 });
    await app.page.waitForTimeout(2500);
    assert(await app.page.locator("#entry-form").count(), "the today page replaced the log page after it");
  }),

  flow(
    "closed projects drop out of the log form's suggestions but keep their hours",
    async (app) => {
      await app.goto("#/log/2026-11-04");
      await app.page.waitForSelector("#entry-form");
      const chips = await app.page.locator("#recent-chips .chip").allTextContents();
      assert(chips.length && !chips.some((c) => c.includes("測試專案A")), `recent work still offers the closed project: ${chips}`);
      assert(chips.some((c) => c.includes("測試專案B")), `open project missing from recent work: ${chips}`);
      eq(await app.page.locator("#project-names option").evaluateAll((o) => o.map((x) => x.value)), ["測試專案B"], "project list offers only open projects");

      await app.goto("#/projects");
      await app.page.locator("[data-prange=all]").click();
      await app.page.waitForSelector(".card.project h2");
      const heads = (await app.page.locator(".card.project h2").allTextContents()).filter((h) => h !== "未歸類的工作");
      eq(heads, ["測試專案B", "測試專案A已結案 11/24"], "closed project listed last with its badge");
      assert((await app.page.locator(".card.project", { hasText: "測試專案A" }).locator(".project-total").innerText()).trim() !== "", "closed project keeps its hours");
    },
    {
      files: {
        ...FIXTURES,
        "logs/2026-11.md": FIXTURES["logs/2026-11.md"] + "- 19:00 · work · 1h · 程式 @測試專案B #program\n",
        "projects/status.md": "# Project status\n\n- 測試專案A · closed 2026-11-24\n",
      },
    }
  ),

  flow("work entry from the form is written in the log format", async (app) => {
    await app.goto("#/log/2026-11-04");
    await app.page.waitForSelector("#entry-form");
    const f = app.page.locator("#entry-form");
    await f.locator("[name=start]").fill("13:00");
    await f.locator("[name=end]").fill("15:30");
    await f.locator("[name=text]").fill("程式修改");
    await f.locator("[name=project]").fill("測試專案A");
    await app.page.click("#save-btn");
    await waitPuts(app, 1);
    const before = FIXTURES[LOG];
    const d = lineDiff(before, app.gh.files[LOG]);
    eq(d.removed, [], "nothing else in the file may change");
    eq(d.added.length, 1, "exactly one new line");
    assert(/^- 13:00 · work · 2h30m · 程式修改 @測試專案A/.test(d.added[0]), `line format: ${d.added[0]}`);
    const lines = app.gh.files[LOG].split("\n");
    assert(lines.indexOf(d.added[0]) > lines.findIndex((l) => l.startsWith("- 08:00")), "entry sorted after 08:00");
    await app.page.waitForSelector(".entry:has-text('程式修改')");
  }),

  flow("every exercise type saves with its tag", async (app) => {
    for (const [tag, label] of EXERCISES) {
      await app.goto("#/log/2026-11-04");
      await app.page.waitForSelector("[data-quick=exercise]");
      await app.page.click("[data-quick=exercise]");
      await app.page.click(`[data-ex=${tag}]`);
      if (tag === "other") await app.page.fill("#exercise-form [name=other]", "爬山");
      await app.page.click("#exercise-form button[type=submit]");
      await app.page.waitForSelector(`.entry:has-text('${tag === "other" ? "爬山" : label}')`, { timeout: 8000 });
      assert(app.gh.files[LOG].includes(`· exercise · 30m · ${tag === "other" ? "爬山" : label} #${tag}`), `exercise line for ${tag}`);
    }
  }),

  flow("repair: add, edit in place, move to another month, cancel", async (app) => {
    await app.goto("#/repairs/2026-11-04");
    await app.page.waitForSelector("#repair-form");
    await app.page.fill("#repair-form input[name=direct]", "測試公司乙");
    await app.page.fill("#repair-form input[name=machine]", "沖床");
    await app.page.fill("#repair-form input[name=fix]", "換繼電器");
    await app.page.click("#repair-form button[type=submit]");
    await waitPuts(app, 1);
    let heads = app.gh.files[REPAIRS].split("\n").filter((l) => l.startsWith("## "));
    eq(heads, ["## 2026-11-02 · 測試公司甲 · 測試機台", "## 2026-11-04 · 測試公司乙 · 沖床"], "records after add");

    await app.goto("#/repairs");
    await app.page.waitForSelector(".repair [data-edit]");
    const n = app.gh.puts.length;
    const before = app.gh.files[REPAIRS];
    await app.page.locator(".repair", { hasText: "測試公司甲" }).locator("[data-edit]").click();
    const f = app.page.locator(".repair.editing form");
    eq(await f.locator("[name=fix]").evaluateAll((e) => e.map((x) => x.value)), ["更換繼電器", "調整參數"], "edit form prefills each fix item");
    await f.locator("[name=symptom]").fill("測試現象");
    await f.locator("button[type=submit]").click();
    await waitPuts(app, n + 1);
    eq(lineDiff(before, app.gh.files[REPAIRS]), { added: ["- 現象：測試現象"], removed: [] }, "edit is a minimal diff");

    await app.page.waitForSelector(".repair [data-edit]");
    await app.page.locator(".repair", { hasText: "測試公司甲" }).locator("[data-edit]").click();
    await app.page.locator(".repair.editing [name=date]").fill("2026-10-30");
    await app.page.locator(".repair.editing button[type=submit]").click();
    await waitPuts(app, n + 3);
    heads = app.gh.files[REPAIRS].split("\n").filter((l) => l.startsWith("## "));
    eq(heads, ["## 2026-11-04 · 測試公司乙 · 沖床"], "moved record left November");
    assert(app.gh.files["field/repairs/2026-10.md"].includes("## 2026-10-30 · 測試公司甲 · 測試機台\n- 直接客戶：測試公司甲"), "moved record is in October");

    await app.page.waitForSelector(".repair [data-edit]");
    await app.page.locator(".repair [data-edit]").first().click();
    await app.page.locator("[data-cancel]").click();
    eq(await app.page.locator(".repair.editing").count(), 0, "cancel closes the edit form");
    eq(app.gh.puts.length, n + 3, "cancel writes nothing");
  }),

  flow("offline: entries queue on the phone and upload when back online", async (app) => {
    await app.goto("#/log/2026-11-04");
    await app.page.waitForSelector("#entry-form");
    app.gh.online = false;
    await app.ctx.setOffline(true);
    const f = app.page.locator("#entry-form");
    await f.locator("[name=start]").fill("16:00");
    await f.locator("[name=end]").fill("17:00");
    await f.locator("[name=text]").fill("離線測試");
    await app.page.click("#save-btn");
    await app.page.waitForSelector(".entry .waiting", { timeout: 15000 });
    eq(app.gh.puts.length, 0, "nothing written while offline");
    app.gh.online = true;
    await app.ctx.setOffline(false);
    await waitPuts(app, 1);
    assert(app.gh.files[LOG].includes("- 16:00 · work · 1h · 離線測試"), "queued entry uploaded");
    await app.page.waitForTimeout(1500);
    eq(await app.page.evaluate(() => JSON.parse(localStorage.getItem("pa-app.outbox") || "[]").length), 0, "outbox empty after upload");
  }),

  flow("stale GitHub read right after a save still shows the new entry", async (app) => {
    await app.goto("#/log/2026-11-04");
    await app.page.waitForSelector("#entry-form");
    app.gh.stale = true;
    const f = app.page.locator("#entry-form");
    await f.locator("[name=start]").fill("19:00");
    await f.locator("[name=text]").fill("剛存的紀錄");
    await app.page.click("#save-btn");
    await waitPuts(app, 1);
    await app.goto("#/today");
    await app.page.waitForTimeout(1500);
    assert((await app.page.locator("#view").innerText()).includes("剛存的紀錄"), "today page lost the entry");
    await app.page.reload();
    await app.goto("#/log/2026-11-04");
    await app.page.waitForSelector(".entry:has-text('剛存的紀錄')", { timeout: 8000 });
    // A second save on top of the stale copy must keep the first one.
    await f.locator("[name=start]").fill("20:00");
    await f.locator("[name=text]").fill("第二筆");
    await app.page.click("#save-btn");
    await waitPuts(app, 2);
    assert(app.gh.files[LOG].includes("剛存的紀錄") && app.gh.files[LOG].includes("第二筆"), "second save overwrote the first");
  }),
];

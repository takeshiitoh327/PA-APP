#!/usr/bin/env node
// Runs every check: node tests/run.mjs [filter]
//   filter  only run checks whose file or name contains this text
// Exits 1 if any check fails. Screenshots of failed end-to-end checks go to
// tests/out/ (git-ignored).

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./harness.mjs";

const filter = process.argv[2] || "";
const OUT = path.join(ROOT, "tests/out");
fs.rmSync(OUT, { recursive: true, force: true });

const files = ["unit", "e2e"].flatMap((dir) =>
  fs.readdirSync(path.join(ROOT, "tests", dir)).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join("tests", dir, f))
);

const ctx = {
  shot(name) {
    fs.mkdirSync(OUT, { recursive: true });
    return path.join(OUT, name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) + ".png");
  },
};

let passed = 0, failed = 0;
const t0 = Date.now();
for (const file of files) {
  const checks = (await import(pathToFileURL(path.join(ROOT, file)))).default;
  for (const c of checks) {
    if (filter && !file.includes(filter) && !c.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const t = Date.now();
    try {
      await c.run(ctx);
      passed++;
      console.log(`  ok    ${c.name} (${Date.now() - t} ms)`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${c.name}  [${file}]\n    ${String(e && e.message).split("\n").join("\n    ")}`);
      if (!(e && e.constructor && e.constructor.name === "AssertionError")) console.log(String(e && e.stack).split("\n").slice(1, 4).join("\n"));
    }
  }
}
if (!passed && !failed) {
  console.log(`no checks match "${filter}"`);
  process.exit(1);
}
console.log(`\n${failed ? "FAILED" : "PASSED"}: ${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
if (failed && fs.existsSync(OUT)) console.log(`screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);

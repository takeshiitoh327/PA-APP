// Estimated hours per project, kept in projects/estimates.md as one line per
// project:  - 迎廣50T · hw=40 · sw=16 · site=24 · travel=6 · extra=8

export const ESTIMATE_PATH = "projects/estimates.md";

// [key, label, phases whose logged hours count as the actual]
export const ESTIMATE_FIELDS = [
  ["hw", "硬體", ["layout", "wiring", "front-wiring"]],
  ["sw", "軟體", ["program", "shop-test"]],
  ["site", "現場", ["site-work", "test"]],
  ["travel", "交通", null],
  ["extra", "外縣市額外", null],
];

const HEADER = `# Project estimates

Estimated hours per project, entered in the app (專案工時). hw = hardware, sw = software, site = on-site work, travel = travel estimate, extra = extra hours for sites outside the home county.

`;

const LINE_RE = /^- (.+?)((?: · [a-z]+=[\d.]+)+)\s*$/;

export function parseEstimates(text) {
  const out = new Map();
  for (const line of (text || "").split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const est = {};
    for (const [, k, v] of m[2].matchAll(/ · ([a-z]+)=([\d.]+)/g)) est[k] = parseFloat(v);
    out.set(m[1].trim(), est);
  }
  return out;
}

export function estimateTotal(est) {
  return ESTIMATE_FIELDS.reduce((a, [k]) => a + (est[k] || 0), 0);
}

// Replaces (or adds, or removes when every field is empty) one project's line.
export function setEstimate(text, name, est) {
  const fields = ESTIMATE_FIELDS.filter(([k]) => est[k] > 0).map(([k]) => ` · ${k}=${+est[k].toFixed(2)}`);
  const line = fields.length ? `- ${name}${fields.join("")}` : null;
  const lines = (text || HEADER).split("\n");
  const i = lines.findIndex((l) => {
    const m = LINE_RE.exec(l);
    return m && m[1].trim() === name;
  });
  if (i >= 0) {
    if (line) lines[i] = line;
    else lines.splice(i, 1);
  } else if (line) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length && !lines[lines.length - 1].startsWith("- ")) lines.push("");
    lines.push(line, "");
  }
  return lines.join("\n");
}

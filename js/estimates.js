// Actual hours per project, entered by hand, kept in projects/hours.md.
// Every input is its own line, stamped with when it was entered:
//   - 迎廣50T · 2026-11-17 14:05 · hw=4 · site=2.5
// (Older lines without a time stamp still count.)

export const ESTIMATE_PATH = "projects/hours.md";

// [key, label]
export const ESTIMATE_FIELDS = [
  ["hw", "硬體"],
  ["sw", "軟體"],
  ["site", "現場"],
  ["travel", "交通"],
  ["extra", "外縣市額外"],
];

const HEADER = `# Project hours

Actual hours per project, entered by hand in the app (專案工時). One line per input, with the time it was entered. hw = hardware, sw = software, site = on-site work, travel = travel, extra = extra hours for sites outside the home county.

`;

const LINE_RE = /^- (.+?)(?: · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}))?((?: · [a-z]+=[\d.]+)+)\s*$/;

// Map(project -> [{ at, hours: {hw, ...}, line }]) in the order entered.
export function parseEstimates(text) {
  const out = new Map();
  for (const line of (text || "").split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const hours = {};
    for (const [, k, v] of m[3].matchAll(/ · ([a-z]+)=([\d.]+)/g)) hours[k] = parseFloat(v);
    const name = m[1].trim();
    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ at: m[2] || null, hours, line });
  }
  for (const list of out.values()) list.sort((a, b) => (a.at || "").localeCompare(b.at || ""));
  return out;
}

export function estimateTotal(hours) {
  return ESTIMATE_FIELDS.reduce((a, [k]) => a + ((hours && hours[k]) || 0), 0);
}

// Per-field sums over a project's inputs.
export function sumInputs(list) {
  const sum = {};
  for (const r of list || []) for (const [k] of ESTIMATE_FIELDS) sum[k] = (sum[k] || 0) + (r.hours[k] || 0);
  return sum;
}

export function inputLine(project, at, hours) {
  const fields = ESTIMATE_FIELDS.filter(([k]) => hours[k] > 0).map(([k]) => ` · ${k}=${+hours[k].toFixed(2)}`);
  return fields.length ? `- ${project} · ${at}${fields.join("")}` : null;
}

export function addInput(text, line) {
  const lines = (text || HEADER).split("\n");
  if (lines.includes(line)) return lines.join("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length && !lines[lines.length - 1].startsWith("- ")) lines.push("");
  lines.push(line, "");
  return lines.join("\n");
}

export function removeInput(text, line) {
  return (text || "")
    .split("\n")
    .filter((l) => l !== line)
    .join("\n");
}

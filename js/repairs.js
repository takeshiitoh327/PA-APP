// Repair records in field/repairs/YYYY-MM.md of personal-assistant. Text
// lives in GitHub; photos and programs stay in the user's Google Drive and
// are linked by folder URL.
//
// 客戶 is who hired the job; 業主 is the end user on site when the job came
// through a client (e.g. 奕郝 serviced under 田豐's name).
//
//   ## 2026-10-29 · 田豐 · 打包機
//   - 業主：奕郝
//   - 年份：103年
//   - 製造：機台 田豐；電控 中信
//   - 年份：103年
//   - 現象：…
//   - 處理：更換 PLC FBs-24MAR2-AC；安裝 103 年舊程式
//   - 零件：FBs-24MAR2-AC；CU-11 380V
//   - 資料夾：https://drive.google.com/drive/folders/…

export const FIELDS = [
  ["owner", "業主"],
  ["year", "年份"],
  ["build", "製造"],
  ["symptom", "現象"],
  ["cause", "原因"],
  ["fix", "處理"],
  ["parts", "零件"],
  ["folder", "資料夾"],
];
const LABEL_TO_KEY = Object.fromEntries(FIELDS.map(([k, l]) => [l, k]));
const HEAD_RE = /^## (\d{4}-\d{2}-\d{2}) · (.+?) · (.+)$/;
const FIELD_RE = /^- (.+?)：(.*)$/;

export function repairPath(date) {
  return `field/repairs/${date.slice(0, 7)}.md`;
}

export function parseRepairs(text) {
  const out = [];
  let cur = null;
  for (const line of (text || "").split("\n")) {
    const h = HEAD_RE.exec(line);
    if (h) {
      cur = { date: h[1], customer: h[2], machine: h[3] };
      out.push(cur);
      continue;
    }
    const f = cur && FIELD_RE.exec(line);
    if (f && LABEL_TO_KEY[f[1]]) cur[LABEL_TO_KEY[f[1]]] = f[2].trim();
  }
  return out;
}

function oneLine(s) {
  return String(s || "").replace(/\s*\n\s*/g, "；").trim();
}

export function buildRepair(r) {
  const lines = [`## ${r.date} · ${oneLine(r.customer)} · ${oneLine(r.machine)}`];
  for (const [k, l] of FIELDS) if (oneLine(r[k])) lines.push(`- ${l}：${oneLine(r[k])}`);
  return lines.join("\n");
}

// Adds a record to the month file, keeping records in date order.
export function addRepair(text, r) {
  const block = buildRepair(r);
  const body = text ? text.replace(/\n*$/, "") : `# Repairs — ${r.date.slice(0, 7)}`;
  const parts = body.split(/\n(?=## )/);
  const head = parts.shift();
  const later = parts.findIndex((p) => p.slice(3, 13) > r.date);
  if (later < 0) parts.push(block);
  else parts.splice(later, 0, block);
  return [head, ...parts].join("\n\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

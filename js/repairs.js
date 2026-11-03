// Repair records in field/repairs/YYYY-MM.md of personal-assistant. Text
// lives in GitHub; photos and programs stay in the user's Google Drive and
// are linked by folder URL.
//
// Who the job was for: 直接客戶 (hired the user directly) or 客戶 (a client
// who passed the job on), plus 業主 (the end owner on site, e.g. 奕郝 was
// serviced under 田豐's name). The heading names whoever hired the job.
// Several items in one field are joined with "；".
//
//   ## 2026-10-29 · 田豐 · 打包機
//   - 客戶：田豐
//   - 業主：奕郝
//   - 地點：南投市南崗工業區
//   - 年份：103年
//   - 製造：機台 田豐；電控 中信
//   - 故障原因：…
//   - 維修內容：更換 PLC FBs-24MAR2-AC；安裝 103 年舊程式
//   - 零件：FBs-24MAR2-AC；CU-11 380V
//   - 資料夾：https://drive.google.com/drive/folders/…

export const FIELDS = [
  ["direct", "直接客戶"],
  ["client", "客戶"],
  ["owner", "業主"],
  ["place", "地點"],
  ["year", "年份"],
  ["build", "製造"],
  ["symptom", "現象"],
  ["cause", "故障原因"],
  ["fix", "維修內容"],
  ["parts", "零件"],
  ["folder", "資料夾"],
];
// 原因 and 處理 are the labels used before 2026-11-03.
const LABEL_TO_KEY = { ...Object.fromEntries(FIELDS.map(([k, l]) => [l, k])), 原因: "cause", 處理: "fix" };
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

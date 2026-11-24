// Closed projects, kept in projects/status.md of personal-assistant:
//   - 迎廣50T · closed 2026-11-24
// A closed project drops out of the log form's suggestions (recent work and
// the project list). Its entries and hours stay everywhere else.

export const STATUS_PATH = "projects/status.md";

const CLOSED_RE = /^- (.+?) · closed (\d{4}-\d{2}-\d{2})\s*$/;

// Map(project -> date closed)
export function parseClosed(text) {
  const out = new Map();
  for (const line of (text || "").split("\n")) {
    const m = CLOSED_RE.exec(line);
    if (m) out.set(m[1].trim(), m[2]);
  }
  return out;
}

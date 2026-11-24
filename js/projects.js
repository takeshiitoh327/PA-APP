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

const HEADER = `# Project status

Projects listed here are closed (format: \`- NAME · closed YYYY-MM-DD\`; the PWA reads it). Do not suggest them for new log entries, and ask before logging new work under one (warranty or follow-up work can still use the old project name).
`;

// Marks a project closed on `date`, or open again when date is null.
// Other lines in the file are kept as they are.
export function setClosed(text, project, date) {
  const lines = (text || HEADER).replace(/\n*$/, "").split("\n");
  const kept = lines.filter((l) => {
    const m = CLOSED_RE.exec(l);
    return !(m && m[1].trim() === project);
  });
  if (date) {
    if (!kept.some((l) => l.startsWith("- "))) kept.push("");
    kept.push(`- ${project} · closed ${date}`);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

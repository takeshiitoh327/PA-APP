// Statistics over parsed log entries; mirrors scripts/log_stats.py in
// personal-assistant so both give the same numbers.

export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

export function resolveRange(kind, today, from, to) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (kind === "week") {
    const start = addDays(today, -dow);
    return [start, addDays(start, 6)];
  }
  if (kind === "month") {
    const start = today.slice(0, 8) + "01";
    const next = new Date(`${start}T00:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return [start, addDays(next.toISOString().slice(0, 10), -1)];
  }
  if (kind === "year") return [`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`];
  if (kind === "custom" && from && to) return from <= to ? [from, to] : [to, from];
  return ["0000-01-01", "9999-12-31"];
}

// The range of the same length right before [start, end].
export function previousRange(kind, start, end) {
  if (kind === "month") {
    const prevEnd = addDays(start, -1);
    return [prevEnd.slice(0, 8) + "01", prevEnd];
  }
  if (kind === "year") {
    const y = parseInt(start.slice(0, 4), 10) - 1;
    return [`${y}-01-01`, `${y}-12-31`];
  }
  const len = daysBetween(start, end) + 1;
  return [addDays(start, -len), addDays(start, -1)];
}

export function streak(loggedDays, today) {
  let d = loggedDays.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (loggedDays.has(d)) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

const sortDesc = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);

export function summarize(days, entries, start, end, today) {
  const sel = entries.filter((e) => e.date >= start && e.date <= end);
  const hours = {};
  const counts = {};
  const metrics = {};
  const tagCount = {};
  const tagHours = {};
  const hoursByDay = {};
  for (const e of sel) {
    counts[e.category] = (counts[e.category] || 0) + 1;
    for (const [k, v] of Object.entries(e.metrics)) metrics[k] = (metrics[k] || 0) + v;
    for (const t of e.tags) {
      if (t === "done" || t === "dropped" || t === "moved") continue;
      tagCount[t] = (tagCount[t] || 0) + 1;
      tagHours[t] = (tagHours[t] || 0) + (e.hours || 0);
    }
    if (e.hours !== null) {
      hours[e.category] = (hours[e.category] || 0) + e.hours;
      hoursByDay[e.date] = hoursByDay[e.date] || {};
      hoursByDay[e.date][e.category] = (hoursByDay[e.date][e.category] || 0) + e.hours;
    }
  }
  const plans = entries.filter((e) => e.category === "plan" && e.due && e.due >= start && e.due <= end);
  const moods = [...days.values()].filter((d) => d.date >= start && d.date <= end && d.mood !== null);
  const spanEnd = end < today ? end : today;
  return {
    start,
    end,
    entries: sel.length,
    daysLogged: new Set(sel.map((e) => e.date)).size,
    daysSoFar: start === "0000-01-01" ? null : Math.max(0, daysBetween(start, spanEnd) + 1),
    streak: streak(new Set(entries.map((e) => e.date)), today),
    totalHours: Object.values(hours).reduce((a, b) => a + b, 0),
    hours: sortDesc(hours),
    counts: sortDesc(counts),
    tags: sortDesc(tagCount)
      .slice(0, 12)
      .map(([t, n]) => [t, n, tagHours[t]]),
    metrics: Object.entries(metrics).sort(),
    moodAvg: moods.length ? moods.reduce((a, d) => a + d.mood, 0) / moods.length : null,
    moodDays: moods.length,
    hoursByDay,
    commitments: {
      due: plans.length,
      done: plans.filter((e) => e.status === "done").length,
      dropped: plans.filter((e) => e.status === "dropped").length,
      open: plans.filter((e) => e.status === "open" && e.due <= today).length,
    },
  };
}

export function openCommitments(entries, by) {
  return entries
    .filter((e) => e.category === "plan" && e.status === "open" && e.due && e.due <= by)
    .sort((a, b) => a.due.localeCompare(b.due));
}

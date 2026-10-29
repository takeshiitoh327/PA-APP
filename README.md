# pa-app

A small PWA front end for a private `personal-assistant` repo: today's morning brief and evening review, daily log input, and log statistics.

**This repo holds code only.** All data stays in the private repo and is read and written in the browser through the GitHub Contents API with a fine-grained token that only has Contents read/write on that one repo. The token is stored in the browser's `localStorage` and only sent to `api.github.com`.

## Pages

- `#/today[/YYYY-MM-DD]`: the day's log entries, open commitments, brief and review. `#/brief/DATE` and `#/review/DATE` jump to that section (used by the Telegram alerts).
- `#/log[/YYYY-MM-DD]`: add, edit or delete log entries, close plans, set the day's mood.
- `#/stats`: hours by category, per-day chart, tags, metrics, mood, commitments, heatmap for a week, month, year, all time or a custom range.
- `#/settings`: token and repo.

## Data format

Reads and writes `logs/YYYY-MM.md` in the format the `/log` skill uses (`- HH:MM · category · duration · text #tag [metric=value]`). `js/stats.js` mirrors `scripts/log_stats.py` so both report the same numbers.

## Deploy

GitHub Pages, branch `main`, folder `/`. No build step. Bump `VERSION` in `sw.js` when changing files so phones pick up the update.

Vendored: [marked](https://github.com/markedjs/marked) 12.0.2 (MIT) and [DOMPurify](https://github.com/cure53/DOMPurify) 3.1.6 (Apache-2.0 / MPL-2.0); licenses in `vendor/`.

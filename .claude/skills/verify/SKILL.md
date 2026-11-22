---
name: verify
description: Verify a change to this PWA before committing or pushing it. Runs the format property checks and drives the real app in Chromium against a fake GitHub API (log entries, exercise, repairs add/edit/move, offline queue, stale GitHub reads, fast page switching), then checks the release version. Use before every commit to this repo, after fixing a bug the user reported, or when the user asks to test or verify the app.
---

# Verify a PA-APP change

The user only ever sees this app on their phone, after it is pushed to GitHub Pages. A broken push means a broken log on the phone, so nothing is pushed until this passes.

## 1. Run the checks

```bash
node tests/run.mjs            # everything, about 20 s
node tests/run.mjs repair     # only checks whose file or name contains "repair"
```

- Playwright and Chromium are preinstalled in cloud sessions; never run `npm install` or `playwright install` for this.
- `tests/unit/` runs in Node: version match and property checks on the log and repair file formats (300 seeded random inputs each; a failure prints the seed).
- `tests/e2e/` starts the app from this checkout with `tests/harness.mjs`: a fake GitHub in memory (`app.gh.files`, `app.gh.puts`, `app.gh.stale`, `app.gh.online`), weather hosts blocked, clock pinned to 2026-11-04 20:00 Taipei. Any page error fails the check.
- Failed end-to-end checks save a screenshot to `tests/out/`. Look at it before guessing.

## 2. Add a check for what you changed

- **Bug fix:** first write a check that reproduces the bug and see it fail, then fix the code and see it pass. Keep the check.
- **New feature or changed flow:** add a `flow(...)` to `tests/e2e/flows.test.mjs` (or a new `*.test.mjs`) that does what the user would do on the phone and checks the exact lines written to `app.gh.files`. Prefer checking a minimal diff (`lineDiff`) over "file contains X".
- **New file format rule:** add a property to `tests/unit/formats.test.mjs`.
- **Fixtures are synthetic.** This repo is public: never copy the user's real logs, repair records, customer names or the token into tests.

## 3. Show it working

For a visible change, take one screenshot at phone size (412×915) of the new UI with the harness and look at it. The checks prove the data is right; the screenshot proves it looks right.

## 4. Release

- Bump both `APP_VERSION` in `js/app.js` and `VERSION` in `sw.js` (the unit check fails if they differ).
- Run `node tests/run.mjs` once more on the final code, then commit and push to `main`.
- In the reply to the user, say which checks ran and that they passed, or exactly what failed.

## Rules

- Never skip, weaken or delete a check to get a pass, and never add sleeps or retries to hide a flaky one. Find the cause. If you cannot after three rounds, stop and tell the user what fails.
- Do not loosen a check in the same change that it is failing on; if the check itself is wrong, say why in the commit message.
- Keep the whole run under a minute. If a check gets slow, make it faster rather than running it less.

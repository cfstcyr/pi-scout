# pi-scout — agent guide

pi extension (pi package, `package.json` › `pi.extensions`): a background researcher that searches the workspace and
opted-in read-only sources while the agent works, then injects one dated list of leads per task.

- Runtime: Bun for tests (`bun test test/`), no runtime dependencies besides pi. TypeScript, ESM.
- Entry point `src/extension.ts`; search `src/research.ts`; list `src/map7.ts`; delivery `src/push.ts`; sources `src/sources/`.
- Safety invariants (keep them, they have tests): read-only tools only, sources opt-in in the user config, project config
  can only restrict, secrets redacted before any model call, open-world sources get only the user's prompt words, the
  list holds locators and dates, never item content.
- `docs/` is the GitHub Pages explainer (single self-contained `index.html` + fonts). Keep it in sync with README.md.
- Evaluation harness and benchmark data live in a private experiment, not in this repo.
- Commits: Conventional Commits, identity `git@cfstcyr.com`.

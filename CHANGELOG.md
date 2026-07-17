# Changelog

All notable changes to teamspend are documented in this file. This
changelog covers both distributions -- the npm package (`teamspend`,
JS/TS) and the PyPI package (`teamspend`, Python) -- since they talk to
the same two admin APIs and compute the same before/after delta; entries
note which distribution they apply to.

## [Python 0.1.0] - 2026-07-16

Initial public release of the Python port, published to PyPI as
`teamspend` (`pip install teamspend`). Complementary to, not a replacement
for, the existing npm package -- both are first-class and maintained
together. See `python/README.md` for Python-specific usage.

### Added

- `teamspend --tools <a>,<b> --before <window> --after <window>` CLI
  (console script `teamspend`, package `teamspend`) with the same flags as
  the npm CLI: `--json`, `--before-csv`, `--after-csv`.
- Programmatic library API: `from teamspend import fetch_cursor_spend,
  fetch_claude_code_spend, import_from_csv, build_comparison, ...`,
  returning the same normalized data shape as the npm package's exports
  (snake_case attribute names on the Python side; the JSON report file
  re-serializes to the npm package's camelCase key shape for wire
  compatibility).
- Both admin-API adapters reimplemented as genuine Python logic --
  Cursor's 30-day-chunk pagination, Claude Code's 2026-01-01 Analytics API
  start-date guard, and the shared suspicious-zero detection for flat-seat/
  per-seat billing tiers -- using only the standard library's `urllib` for
  HTTP (no `requests` dependency), matching the npm package's zero-runtime-
  dependency design.
- The CSV-import fallback (`import_from_csv`), with the same
  `date,user_email,cost_usd,is_estimated` schema and the same
  control-character stripping the TypeScript original applies to guard
  against terminal-escape injection via a crafted CSV cell.
- Full pytest suite (51 tests) ported from the TypeScript vitest suite,
  covering every adapter (against the same bundled JSON/CSV fixtures the
  npm package's tests use), the retry/backoff HTTP client, the comparison
  builder, the terminal/JSON output layer, and the CLI end-to-end.

### Notes

- Verified parity against the npm package's own bundled fixtures: both
  CLIs compute the identical `total_cost_usd`/`totalCostUsd` and
  `delta_usd`/`deltaUsd` from `fixtures/cursor.fixture.json` and
  `fixtures/claude-code.fixture.json`.
- The Python CLI's concurrent before/after fetch uses a 2-worker
  `ThreadPoolExecutor` rather than JavaScript's native `Promise.allSettled`,
  but preserves the same guarantee: one side's failure never blocks or
  corrupts the other side's result, and both PeriodOutcome objects are
  always populated (result or error, never neither).

## [0.1.2] - npm, prior to this Python port

npm package `teamspend` at v0.1.2. See the npm package's own release
history on [npm](https://www.npmjs.com/package/teamspend) for earlier
JS/TS-only changes; this changelog file did not exist before the Python
port was added and is retrofit here as the shared changelog going forward.

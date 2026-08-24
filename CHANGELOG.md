# Changelog

All notable changes to teamspend are documented in this file. This
changelog covers both distributions -- the npm package and the PyPI
package, both now named `teamspend-cli` (formerly published as plain
`teamspend` on both registries) -- since they talk to the same six data
sources and compute the same before/after delta; entries note which
distribution they apply to.

## [0.2.4 (PyPI)] - 2026-08-08

Bug fix. `teamspend.__version__` (the module-level attribute, exported in
`__all__` for programmatic/library callers) was a separate hardcoded
`"0.1.0"` string in `python/src/teamspend/__init__.py` that had drifted
from the real installed version -- unlike `cli.py`'s `_VERSION`, which a
prior fix already made read `importlib.metadata.version("teamspend-cli")`
dynamically. `__version__` now uses the same dynamic lookup, so
`import teamspend; teamspend.__version__` and `teamspend --version` always
agree and both reflect the real installed/published version.

## [0.2.5 (npm) / 0.2.3 (PyPI)] - 2026-08-08

Bug fix, both distributions. `--before-csv`/`--after-csv` silently stopped
working whenever a tool's API token was simply unset: the missing-token
check raised a plain `Error`/`RuntimeError` instead of `DataUnavailableError`,
so the CSV-fallback catch block (which only matches `DataUnavailableError`)
never triggered and the CLI reported `DATA UNAVAILABLE: Missing
TEAMSPEND_*_TOKEN` even with a valid CSV file passed in -- exactly the
scenario the README's own CSV-import quickstart example hits. Missing-token
and missing-org checks for cursor, claude-code, and copilot now raise
`DataUnavailableError`, so the existing CSV fallback engages correctly.
Regression tests added on both sides.

## [renamed to teamspend-cli on both registries] - 2026-07-18

Both the npm package and the PyPI package changed name from `teamspend` to
`teamspend-cli`, matching the naming convention used by this maintainer's
other packages. Same maintainer, same repo, same code -- only the package
names changed. The installed command is `teamspend` either way -- this
rename only affects the name you pass to `npm install`/`npx`/`pip install`.

- **npm:** the old `teamspend` name was initially deprecated (`npm
  deprecate`) to point installers at `teamspend-cli` without removing it.
  As of 2026-08-03, the old name was fully unpublished from the registry
  (`npm view teamspend` now returns an `unpublished` record for all of its
  prior versions); it is no longer installable under any version. Anything
  still depending on it must migrate to `teamspend-cli`.
- **PyPI:** the old `teamspend` package's final release (0.2.2) briefly
  rewrote its own README to point installers at `teamspend-cli`. As of
  2026-08-03, the old package was fully unpublished from PyPI (`pip install
  teamspend` and `pypi.org/pypi/teamspend/json` both return 404/not found);
  it is no longer installable under any version.

## [0.2.1] - 2026-07-18

Security fix, both distributions.

### Fixed

- `output.ts`/`output.py`: the `--breakdown session` terminal table printed
  `sessionId` without the control-character stripping already applied to
  `userEmail` three lines below it in the same file. A local-log-sourced
  session ID could carry a raw terminal escape sequence (e.g. an OSC 52
  clipboard-write payload) that would print unsanitized. Now reuses the
  existing `stripControlChars`/`strip_control_chars` helper for `sessionId`
  too, closing the same class of gap already fixed for `userEmail`.

## [0.2.0] - 2026-07-18

Both distributions.

### Added

- GitHub Copilot adapter (`TEAMSPEND_COPILOT_TOKEN` + `TEAMSPEND_COPILOT_ORG`,
  optional `TEAMSPEND_COPILOT_SEAT_PRICE_USD`) -- real usage-metrics API,
  cost derived from GitHub's own published `ai_credits_used` -> USD rate,
  since the API has no cost field of its own.
- OpenCode adapter -- reads OpenCode's local session logs directly, no
  admin API, no credential.
- Codex CLI adapter -- reads Codex's local rollout logs directly, no admin
  API, no credential; cost always reported as `$0`/estimated since Codex's
  local data has no cost field at all.
- `claude-code-personal` tool id -- credential-free mode for someone who
  wants their own Claude Code usage without org-admin access, reading
  Claude Code's own local JSONL logs.
- `--breakdown session` flag -- per-session cost table (available for
  `claude-code-personal` and `opencode` only, since the admin-API tools'
  responses have no session concept to group by).

### Changed

- README and package metadata (`description`, `keywords`) updated across
  both distributions to reflect all 6 tool configurations.

## [Python 0.1.1] - 2026-07-16

Docs-only patch release for the Python distribution. No source or
behavior changes.

### Changed

- `python/README.md`: added a "How it works" section (concurrency and
  failure isolation between the before/after fetches, the retry/backoff
  policy, Cursor's 30-day-chunk pagination, the Claude Code
  2026-01-01 Analytics API start-date guard, suspicious-zero estimation,
  and how `build_comparison()` derives the delta and top spenders) and a
  "Security" section (which credentials teamspend reads and how, the CSV
  control-character stripping, the JSON report's `0600` file
  permissions, what's out of scope, and a pointer to
  [SECURITY.md](https://github.com/RudrenduPaul/teamspend/blob/main/SECURITY.md)
  for vulnerability reporting), bringing it to the same depth as the
  other Python ports in this batch (e.g. `skillguard-cli`,
  `auditreach-cli`).

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

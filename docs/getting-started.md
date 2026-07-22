# Getting started

teamspend answers one question: when a team moves from one AI coding tool
to another, or runs two at once, what did that actually cost, in real
dollars, pulled straight from each vendor's own admin API? It ships as two
independent, equally first-class packages, both named `teamspend-cli`: an
npm package (JavaScript/TypeScript) and a PyPI package (Python). Pick
whichever fits your toolchain, or install both. (The older plain
`teamspend` name is deprecated on both registries in favor of
`teamspend-cli` -- same maintainer and repo, just renamed to match this
project's other packages. The installed command is `teamspend` either way.)

## Install

**npm (JS/TS CLI):**

```bash
npm install -g teamspend-cli
# or run it once without installing:
npx teamspend-cli --tools cursor,claude-code --before ... --after ...
```

**pip (Python library + CLI):**

```bash
pip install teamspend-cli
```

Both are zero-runtime-dependency: the npm package uses native `fetch`, the
Python package uses the standard library's `urllib`. Neither pulls in a
third-party HTTP client.

## Credentials

teamspend needs org-admin-level API access for each tool you're comparing.
Set the corresponding environment variable before running:

| Tool | Environment variable | Where to get it |
| --- | --- | --- |
| Cursor | `TEAMSPEND_CURSOR_TOKEN` | Cursor Admin API key, from your org's Cursor dashboard |
| Claude Code | `TEAMSPEND_CLAUDE_CODE_TOKEN` | Anthropic Admin/Analytics API key, from the Anthropic Console |
| GitHub Copilot | `TEAMSPEND_COPILOT_TOKEN`, `TEAMSPEND_COPILOT_ORG` (both required), `TEAMSPEND_COPILOT_SEAT_PRICE_USD` (optional) | A PAT with `read:org` scope (or the fine-grained "View Organization Copilot Metrics" permission) on an org with Copilot Business/Enterprise; `TEAMSPEND_COPILOT_ORG` is your org login |
| OpenCode | None needed | OpenCode has no admin API -- teamspend reads its local session logs directly. Set `OPENCODE_DATA_DIR` only if yours isn't at the default `~/.local/share/opencode`. |
| Codex CLI | None needed | Codex CLI has no admin API either -- teamspend reads its local rollout logs directly. Set `CODEX_HOME` only if yours isn't at the default `~/.codex`. |

If you can already see billing for your org on that tool's own dashboard,
you have the access level teamspend needs. Copilot is the one exception --
GitHub's own API has no cost field at all, so see the project README's
["GitHub Copilot support"](../README.md#github-copilot-support) section for
how teamspend derives a dollar figure honestly instead of guessing one.

## Your first comparison

```bash
export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

# npm CLI
npx teamspend-cli --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

# Python CLI (after `pip install teamspend-cli`)
teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30
```

Real output shape (both CLIs print the same lines; numbers come from your
own org's data):

```
teamspend snapshot -- migration cost comparison
Tools: cursor -> claude-code

BEFORE (cursor)
  Total spend:      $2140.00  (exact, usage-based)
  Active users:      14

AFTER (claude-code)
  Total spend:      $1860.00  (exact, usage-based)
  Active users:      14

DELTA: -$280.00 (-13.1%)

Full report: ./teamspend-snapshot-2026-07-16T2031.json
```

Exit code `0` means both periods fetched successfully. Exit code `1` means
at least one side failed -- a missing/invalid credential, a malformed CLI
argument, or a vendor API window limit (see
[concepts.md](./concepts.md#claude-codes-analytics-api-window-limit)).
The failed side always shows `DATA UNAVAILABLE: <reason>` rather than being
silently dropped from the report.

Add `--json` to print the full JSON report to stdout instead of the
human-readable summary shown above. The JSON report file on disk
(`teamspend-snapshot-<timestamp>.json`) is written either way -- `--json`
only changes what prints to the terminal.

## Using the library instead of the CLI

Both packages export a programmatic API for scripts and CI gates that want
to call teamspend in-process instead of shelling out to a CLI binary.

**TypeScript:**

```ts
import { fetchCursorSpend, fetchClaudeCodeSpend, buildComparison } from 'teamspend';

const before = await fetchCursorSpend({ start: '2026-04-01', end: '2026-04-30' }, cursorKey);
const after = await fetchClaudeCodeSpend({ start: '2026-06-01', end: '2026-06-30' }, claudeKey);
const report = buildComparison(
  { label: 'before', tool: 'cursor', result: before, error: null },
  { label: 'after', tool: 'claude-code', result: after, error: null },
);
```

**Python:**

```python
from teamspend import (
    fetch_cursor_spend,
    fetch_claude_code_spend,
    build_comparison,
    DateWindow,
    PeriodOutcome,
)

before = fetch_cursor_spend(DateWindow("2026-04-01", "2026-04-30"), cursor_key)
after = fetch_claude_code_spend(DateWindow("2026-06-01", "2026-06-30"), claude_key)
report = build_comparison(
    PeriodOutcome("before", "cursor", before, None),
    PeriodOutcome("after", "claude-code", after, None),
)
print(report.delta_usd, report.delta_percent)
```

Both return the same normalized shape (`total_cost_usd`/`totalCostUsd`,
`users`, `is_estimated`/`isEstimated`) -- see [concepts.md](./concepts.md)
for the full data model.

## CSV import for history a live API can't reach

Claude Code's Analytics API has no data before 2026-01-01. If your
comparison window reaches back further, hand teamspend a CSV in the
documented schema and it merges the CSV data in for that side:

```bash
teamspend --tools cursor,claude-code \
  --before 2025-11-01:2025-11-30 \
  --after 2026-06-01:2026-06-30 \
  --before-csv ./before.csv
```

CSV schema: `date,user_email,cost_usd,is_estimated`, one row per user per
day. See [concepts.md](./concepts.md#csv-import-schema) for the fallback
mechanics.

## Next steps

- [concepts.md](./concepts.md) -- how the comparison pipeline works, the
  suspicious-zero detection, and the CSV-import fallback schema.
- [integrations/ci.md](./integrations/ci.md) -- wiring teamspend into a
  scheduled CI job.
- The [project README](../README.md) for the full tool comparison.

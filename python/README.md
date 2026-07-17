# teamspend (Python)

Compare AI coding tool spend before and after a migration -- Cursor vs
Claude Code, real numbers pulled from each vendor's own admin API, one
command.

[![PyPI version](https://img.shields.io/pypi/v/teamspend.svg)](https://pypi.org/project/teamspend/)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/RudrenduPaul/teamspend/blob/main/LICENSE)
[![Python versions](https://img.shields.io/pypi/pyversions/teamspend.svg)](https://pypi.org/project/teamspend/)
[![npm version](https://img.shields.io/npm/v/teamspend.svg)](https://www.npmjs.com/package/teamspend)

## Why this exists

More teams are running more than one AI coding tool at once, or moving
between them, than ever before. Cursor's Admin API reports Cursor spend.
Anthropic's Claude Enterprise Analytics API reports Claude Code spend.
Neither has a reason to show a competitor's number next to its own, so a
team mid-migration is left opening two dashboards and doing the
subtraction by hand. teamspend pulls both sides through the same
normalized schema and prints one honest delta. This package is the Python
distribution -- a genuine, independent port, not a wrapper around the
Node binary.

## Install

```bash
pip install teamspend
```

or with [uv](https://docs.astral.sh/uv/):

```bash
uv add teamspend
```

Zero runtime dependencies: the standard library's `urllib` handles every
admin-API call. The complementary JS/TS distribution installs the same way
on the npm side: `npm install -g teamspend` (or `npx teamspend ...` to run
it once without installing) -- see the
[project README](https://github.com/RudrenduPaul/teamspend#readme) for
that package. Both are first-class, maintained together; neither is
deprecated in favor of the other.

## Quickstart

```bash
export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

teamspend --tools cursor,claude-code \
  --before 2026-04-01:2026-04-30 \
  --after 2026-06-01:2026-06-30
```

Both credentials need org-admin-level access on their platform. If you can
already see billing for your org, you have what you need.

Output (shape shown below; your real numbers come from your own org's API
data):

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

Exit code `0` means both periods fetched successfully, `1` means at least
one side failed (auth, a vendor API window limit, or a CLI argument
error) -- see `DATA UNAVAILABLE` in the terminal output and the `error`
field of the JSON report for the reason.

## Using the library instead of the CLI

Both packages export a programmatic API for scripts and CI gates that want
to call teamspend in-process instead of shelling out to a CLI binary.

**TypeScript:**

```ts
import { fetchCursorSpend, fetchClaudeCodeSpend, buildComparison } from 'teamspend';
```

**Python:**

```python
from teamspend import fetch_cursor_spend, fetch_claude_code_spend, build_comparison, DateWindow, PeriodOutcome

before_window = DateWindow("2026-04-01", "2026-04-30")
after_window = DateWindow("2026-06-01", "2026-06-30")

before_result = fetch_cursor_spend(before_window, cursor_api_key)
after_result = fetch_claude_code_spend(after_window, claude_api_key)

report = build_comparison(
    PeriodOutcome("before", "cursor", before_result, None),
    PeriodOutcome("after", "claude-code", after_result, None),
)
print(report.delta_usd, report.delta_percent)
```

Both return the same shape of normalized data (`total_cost_usd`/
`totalCostUsd`, `users`, `is_estimated`/`isEstimated`) -- see
[docs/concepts.md](https://github.com/RudrenduPaul/teamspend/blob/main/docs/concepts.md)
for the full data model.

## CSV import, for the history a live API can't reach

```bash
teamspend --tools cursor,claude-code \
  --before 2025-11-01:2025-11-30 \
  --after 2026-06-01:2026-06-30 \
  --before-csv ./before.csv
```

CSV schema: `date,user_email,cost_usd,is_estimated`, one row per user per
day. Rows are aggregated per `user_email`.

## Good to know before you run it

- This is a snapshot tool, not a running dashboard. It answers one
  question well and stops.
- The output includes real emails and dollar amounts, printed to your
  terminal and saved to a report file (`0600` permissions, auto-added to
  `.gitignore`). If you wire this into a scheduled CI job on a public
  repo, that data lands in your build logs, so check your CI provider's
  log visibility first.
- Flat-seat and per-seat billing tiers (Cursor plans without usage
  overage, Claude.ai Team/Enterprise seats) don't expose true per-user
  cost through the vendor's own Admin API. When teamspend sees a user
  with real token or request activity but a reported cost of exactly $0,
  it marks that user's number, and the whole report, as estimated rather
  than showing a misleading exact-looking $0.
- Claude Code's Analytics API has no data before 2026-01-01. A window that
  starts earlier raises `DataUnavailableError` and, if `--before-csv`/
  `--after-csv` was passed, falls back to the CSV import path for that
  side automatically.

## Development

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

Source lives under `python/src/teamspend/`, laid out to mirror the
TypeScript module structure 1:1 (`adapters/`, `compare.py`, `output.py`,
`cli.py`, `types.py`, `errors.py`, `http_client.py`) so a change in one
codebase has an obvious counterpart to check in the other. See
[CONTRIBUTING.md](https://github.com/RudrenduPaul/teamspend/blob/main/CONTRIBUTING.md).

## License

Apache 2.0.

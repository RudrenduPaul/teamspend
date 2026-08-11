<!-- mcp-name: io.github.RudrenduPaul/teamspend -->

# teamspend (Python)

Compare AI coding tool spend before and after a migration -- Cursor,
Claude Code, GitHub Copilot, OpenCode, and Codex CLI, real numbers pulled
from each vendor's own API or local logs, one command.

[![PyPI version](https://img.shields.io/pypi/v/teamspend-cli.svg)](https://pypi.org/project/teamspend-cli/)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/RudrenduPaul/teamspend/blob/main/LICENSE)
[![Python versions](https://img.shields.io/pypi/pyversions/teamspend-cli.svg)](https://pypi.org/project/teamspend-cli/)
[![npm version](https://img.shields.io/npm/v/teamspend-cli.svg)](https://www.npmjs.com/package/teamspend-cli)

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
pip install teamspend-cli
```

or with [uv](https://docs.astral.sh/uv/):

```bash
uv add teamspend-cli
```

Zero runtime dependencies: the standard library's `urllib` handles every
admin-API call. The complementary JS/TS distribution installs the same way
on the npm side: `npm install -g teamspend-cli` (or `npx teamspend-cli ...`
to run it once without installing; the older `teamspend` npm name is
deprecated in favor of `teamspend-cli`, same maintainer and repo) -- see the
[project README](https://github.com/RudrenduPaul/teamspend#readme) for
that package. Both distributions (this PyPI package and the npm package)
are first-class and maintained together.

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

## GitHub Copilot support

```bash
export TEAMSPEND_COPILOT_TOKEN=<a token with read:org on the org>
export TEAMSPEND_COPILOT_ORG=<your GitHub org login>
export TEAMSPEND_COPILOT_SEAT_PRICE_USD=19   # optional

teamspend --tools cursor,copilot --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30
```

GitHub's real Copilot usage metrics API has no cost/spend field at all --
only usage counts, most usefully `ai_credits_used`. teamspend converts that
to USD at GitHub's own published, fixed rate of 1 AI credit = $0.01 USD,
and adds `TEAMSPEND_COPILOT_SEAT_PRICE_USD` (if set) once per user for the
whole window to also reflect the flat per-seat license price GitHub's API
never exposes. Every Copilot result is therefore always `is_estimated`,
regardless of whether a seat price was supplied -- see the project
[README's "GitHub Copilot support" section](https://github.com/RudrenduPaul/teamspend#github-copilot-support)
and [docs/concepts.md](https://github.com/RudrenduPaul/teamspend/blob/main/docs/concepts.md#copilots-usage-based-report-pagination-and-cost-derivation)
for the full mechanics.

## OpenCode and Codex CLI: local-only, no API key needed

```bash
teamspend --tools claude-code,opencode --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30
teamspend --tools claude-code,codex --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30
```

Neither [OpenCode](https://github.com/anomalyco/opencode) nor
[Codex CLI](https://github.com/openai/codex) has an admin, team, or
billing API -- both are local CLIs, so teamspend reads their own local
session logs directly off disk instead: `~/.local/share/opencode/storage/message/`
for OpenCode, `~/.codex/sessions/YYYY/MM/DD/` for Codex. No credential,
no network call for either. Both results attribute everything to the
single local user running the command, not a team, and are always marked
`is_estimated`: OpenCode stores `cost: 0` for most models in its own
logs, and Codex's local data has no cost field at all, only exact token
counts. Codex also only keeps roughly the last 7 days of logs readable
before background-compressing them. See the project README's
[OpenCode](https://github.com/RudrenduPaul/teamspend#opencode-local-only-no-api-key-needed)
and [Codex CLI](https://github.com/RudrenduPaul/teamspend#codex-cli-local-only-no-api-key-needed)
sections for the full mechanics and caveats.

## Personal usage mode, for when you don't have admin access

```bash
teamspend --tools claude-code-personal,claude-code-personal --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30
```

If you just want your own personal Claude Code spend and don't have (or
don't want to use) org-admin access, use `claude-code-personal` instead
of `claude-code`. It reads Claude Code's own local JSONL session logs
straight off disk, no API key, no network call, no admin access needed --
just the logs Claude Code already writes on your machine.

## Session-level cost breakdown

```bash
teamspend --tools claude-code-personal,claude-code-personal --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30 --breakdown session
```

Add `--breakdown session` to break a flat total down by session, using
the `sessionId`/`sessionID` each log entry already carries -- available
for `claude-code-personal` and `opencode` only, since `cursor`,
`claude-code`, and `copilot` pull from admin APIs that return per-user
aggregates with no session field to group by. A session is the most
honest proxy teamspend can offer for "cost per task" -- it is not a
measure of whether that session's output was actually good, since no
vendor exposes that.

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

## How it works

```
CLI flags / env vars
  -> two adapters run concurrently (ThreadPoolExecutor, 2 workers)
       - Cursor: 30-day-chunk pagination against api.cursor.com/admin/usage, summed per user
       - Claude Code: single call to api.anthropic.com .../usage_report/claude_code
                       (guarded: no data before 2026-01-01)
  -> each field read from a response is validated (require_field) --
       missing field raises SchemaDriftError, never a silent guess
  -> suspicious-zero detection: real token/request activity + cost 0
       -> that user, and the whole side, is marked isEstimated
  -> build_comparison(): before/after -> delta_usd, delta_percent,
       top 5 spenders across both periods
  -> terminal summary + JSON report (0600 file perms) written to cwd
```

**Concurrency and failure isolation.** `cli.py`'s `run()` submits the
before and after fetches to a 2-worker `ThreadPoolExecutor` and resolves
each `Future` independently, catching any exception per side into a
`PeriodOutcome(result=None, error=...)` rather than letting one side's
failure abort the other -- mirroring the TypeScript CLI's
`Promise.allSettled`. Exit code `0` requires both sides to have a
`result`; either side without one returns exit code `1`.

**Retry/backoff.** Every adapter call goes through `http_client.py`'s
`fetch_with_retry`, which retries HTTP 429 and 5xx responses up to 3
times with exponential backoff (0.5s base, doubling), raises
`AuthenticationError` immediately -- never retried -- on 401/403, and
raises `RetryExhaustedError` once the retry budget is spent. The real
network call sits behind a swappable `transport` function (`urllib` in
production), which is how the pytest suite simulates arbitrary HTTP
statuses without opening a real socket.

**Cursor pagination.** The Cursor Admin API caps each call's window at 30
days, so `adapters/cursor.py`'s `_split_into_chunks` breaks any longer
`--before`/`--after` window into consecutive 30-day chunks, fetches each
one, and sums the result per `user_id`. If any chunk fails after retries
are exhausted, the entire fetch fails -- it never reports a total built
from only the chunks that happened to succeed.

**Claude Code start-date guard.** Anthropic's Claude Enterprise Analytics
API has no data before 2026-01-01. `adapters/claude_code.py` checks the
requested window's start date before making any request and raises
`DataUnavailableError` if it predates that date; the CLI then falls back
to `--before-csv`/`--after-csv` for that side if one was passed, or
surfaces the error as that side's `PeriodOutcome.error` otherwise.

**Suspicious-zero detection.** Cursor plans without usage overage, and
Claude.ai Team/Enterprise seats, report a technically valid `cost_usd`/
`spend_usd` of exactly 0 for a user who clearly has real token or request
activity. Both adapters check for that specific combination and mark that
user -- and the whole side's `is_estimated` flag -- as estimated, so the
output never shows a misleading exact-looking $0 next to genuine usage.

**The comparison itself.** `compare.py`'s `build_comparison()` takes two
independently-resolved `PeriodOutcome`s. `delta_usd` and `delta_percent`
are computed only when both sides have a `result`; otherwise they're
`None` and the terminal output prints `DELTA: unavailable`. It also
collects the top 5 spenders from each side, merges and re-sorts them by
cost, and keeps the top 5 across both periods combined.

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

## Security

The three admin-API tools need org-admin-level credentials --
`TEAMSPEND_CURSOR_TOKEN` (Cursor Admin API), `TEAMSPEND_CLAUDE_CODE_TOKEN`
(Anthropic's Claude Enterprise Analytics API), and/or
`TEAMSPEND_COPILOT_TOKEN` + `TEAMSPEND_COPILOT_ORG` (GitHub Copilot usage
metrics API) -- read only from environment variables via `os.environ.get()` in
`cli.py`'s `_fetch_tool()`. Neither is ever hardcoded, persisted to disk,
or included in the JSON report or terminal output. A 401/403 from either
vendor's API raises `AuthenticationError` naming which environment
variable to check; the credential value itself never appears in that
message, a log line, or a traceback. `opencode`, `codex`, and
`claude-code-personal` need no credential at all -- they read local
files only, never a network call.

The one other untrusted input this package reads is an imported CSV file
(`--before-csv`/`--after-csv`): `adapters/csv_import.py` strips C0
control characters (`\x00`-`\x1f`) from every cell before it can reach
the terminal summary, closing a terminal/ANSI-escape-injection path a
crafted `user_email` or `cost_usd` cell could otherwise open. Nothing
read from an API response or a CSV file is ever passed to `eval`, `exec`,
or a shell -- both adapters and the CSV importer only parse and validate
(`require_field` in `http_client.py` raises `SchemaDriftError` rather
than guessing when a vendor field is missing).

The JSON report file (`teamspend-snapshot-*.json`) contains real per-user
emails and dollar amounts, so `output.py` writes it with `0600`
(owner-read/write-only) permissions via `os.open(..., O_CREAT |
O_WRONLY, 0o600)` -- avoiding the umask-then-chmod race a separate
`chmod` call after write would leave open -- and the CLI auto-scaffolds a
`.gitignore` entry for that file pattern on first run.

**What's out of scope**: the accuracy of a vendor's own admin-API
response (a wrong number from Cursor's or Anthropic's API is a report for
that vendor, not teamspend), and findings that assume a credential has
already been put somewhere insecure by the user (a committed `.env` file,
a world-readable shell history) -- teamspend reads credentials only from
environment variables it does not set or persist itself.

To report a vulnerability, use
[GitHub Security Advisories](https://github.com/RudrenduPaul/teamspend/security/advisories/new)
rather than a public issue -- see
[SECURITY.md](https://github.com/RudrenduPaul/teamspend/blob/main/SECURITY.md)
for the full policy and response timeline. **Honest note**: this project
does not currently publish SLSA provenance, Sigstore signatures, or an
SBOM, and has no OpenSSF Scorecard badge set up -- none of that
infrastructure exists yet for either distribution, so it isn't claimed
here. Both distributions have zero runtime dependencies (this package
uses only `urllib` from the standard library), so there is no
third-party HTTP client to audit in the request path.

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


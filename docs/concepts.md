# Concepts

## The fetch/compare pipeline

Both the npm and PyPI packages run the same pipeline (TypeScript:
`src/cli.ts`; Python: `teamspend/cli.py`):

```
--tools a,b --before W1 --after W2
         |
         v
   validate flags (two known tools, YYYY-MM-DD:YYYY-MM-DD windows,
   before strictly earlier than after)
         |
         v
   fetch both sides concurrently (Promise.allSettled in TS,
   a 2-worker ThreadPoolExecutor in Python) -- one side failing
   never blocks or corrupts the other side's result
         |
         v
   each side: call the tool's admin-API adapter
     -> DataUnavailableError + --*-csv provided -> CSV-import fallback
     -> any other failure -> that side's PeriodOutcome carries the error,
        never silently retried into a different code path
         |
         v
   buildComparison / build_comparison -- computes deltaUsd/deltaPercent
   ONLY when both sides succeeded; otherwise null, with the failed side's
   error preserved in the report
         |
         v
   scaffold .gitignore (first run only) -> write JSON report (0600) ->
   print terminal summary or --json
```

## Suspicious-zero detection

Both Cursor (flat-seat plans without usage overage) and Claude Code
(Claude.ai Team/Enterprise seats) can report an exact-looking `cost_usd: 0`
/ `spend_usd: 0` for a user who clearly has real token or request activity
-- the vendor's own Admin API just doesn't expose true per-user cost on
those billing tiers. teamspend flags that specific combination
(`cost == 0` and `tokens/requests > 0`) as `is_estimated` on that user, and
propagates it to `is_estimated` on the whole `AdapterResult` if any user in
the response is flagged. This surfaces in the terminal output as
`(estimated)` instead of `(exact, usage-based)` next to the total spend
line.

This detection came from watching two other tools ([ccusage
#1113](https://github.com/ccusage/ccusage/pull/1113) and
[saras-usage-dashboard #19](https://github.com/sarasanalytics-com/saras-usage-dashboard/pull/19))
hit the identical root cause independently -- see the project README's
"Success stories" section for the full story.

## Retry and timeout behavior

Every admin-API call goes through a shared fetch+retry wrapper
(`http-client.ts` / `http_client.py`):

- **429 (rate limit)** and **5xx (server error)** are retried identically:
  exponential backoff starting at 500ms, doubling each attempt, capped at
  3 retries (4 attempts total).
- **401/403** raise `AuthenticationError` immediately -- never retried,
  since a bad credential won't fix itself on attempt 2.
- **Network error or timeout** (30-second request timeout) is treated the
  same as a 5xx: retried, then raises `RetryExhaustedError` if the budget
  is spent.
- If any retry budget is exhausted, the *entire* call for that tool fails
  -- teamspend never silently returns a partial result and presents it as
  complete.

## Cursor's 30-day pagination

Cursor's Admin API caps each call to a 30-day window. `fetchCursorSpend` /
`fetch_cursor_spend` splits a longer requested window into consecutive
30-day chunks, fetches each one, and sums per-user totals across chunks.
If any chunk fails after retries, the whole fetch fails -- never sums only
the chunks that succeeded, which would under-report spend with no
indication the number is incomplete.

## Claude Code's Analytics API window limit

Anthropic's Claude Enterprise Analytics API has no data before
`2026-01-01` (a hard start date, not a rolling window). A requested window
starting before that date raises `DataUnavailableError` without calling
the API at all. If `--before-csv` (or `--after-csv`) was passed for that
side, the CLI falls back to CSV import automatically; otherwise the whole
run reports that side as `DATA UNAVAILABLE`.

## OpenCode: local-file adapter, no admin API

Unlike Cursor and Claude Code, OpenCode has no admin/team/billing API at
all -- confirmed against its own README, which describes a local CLI with
no organization-level usage endpoint. `fetchOpenCodeSpend` /
`fetch_opencode_spend` reads OpenCode's own local session logs directly
instead of calling anything over the network:

- **Location**: `$OPENCODE_DATA_DIR/storage/message/{sessionID}/msg_{messageID}.json`,
  one JSON file per message. `OPENCODE_DATA_DIR` may be a single path or a
  comma-separated list; it defaults to `~/.local/share/opencode`
  (`%USERPROFILE%\.local\share\opencode` on Windows -- OpenCode uses the
  same XDG-style relative path on every platform). Verified against
  [ccusage's OpenCode guide](https://ccusage.com/guide/opencode/) and
  [tokscale's README](https://github.com/junhoyeo/tokscale), which both
  document the same path; the per-message fields read
  (`tokens.input`/`output`/`reasoning`, `tokens.cache.read`/`write`,
  `cost`) come from OpenCode's own generated SDK types
  (`packages/sdk/js/src/gen/types.gen.ts`, `AssistantMessage`). A newer
  SQLite store (`opencode.db`, v1.2+) exists but isn't read yet -- adding a
  SQLite dependency isn't worth it against this package's zero-runtime-
  dependency design and Node's `>=18.3.0` floor (`node:sqlite` needs Node
  22.5+).
- **Window filtering**: since there's no server-side windowed query, every
  message file under the resolved data directories is read and filtered
  client-side by its `time.created` timestamp against the requested
  `[start, end]` window (inclusive, UTC day boundaries). Only `role:
  "assistant"` messages carry token/cost data; `role: "user"` messages are
  skipped.
- **No suspicious-zero rule -- always estimated instead.** OpenCode stores
  `cost: 0` in most message files (per ccusage's own docs: "Costs are
  calculated from token counts using LiteLLM pricing"), and teamspend
  bundles no per-token pricing table of its own. Rather than guess a dollar
  figure from a pricing table that would drift from real vendor prices,
  `fetchOpenCodeSpend` sums whatever `cost` OpenCode itself recorded and
  unconditionally marks the result `is_estimated`, even on the rare message
  where that field is genuinely nonzero. Token counts are exact; only the
  dollar figure is approximate.
- **One synthetic user per machine, not per team member.** OpenCode's
  message files carry no user/email field at all. Every message found is
  attributed to the OS account running teamspend (`os.userInfo().username`
  / `getpass.getuser()`), never an email. `AdapterResult.users` is at most
  a single entry.
- **Missing data dir vs. an inactive window**: no local message store found
  anywhere (missing data dir, or a resolved dir with zero message files)
  raises `DataUnavailableError`, the same fallback trigger used elsewhere --
  if `--*-csv` was passed for that side, the CLI falls back to CSV import.
  A data dir that exists but simply has no messages inside the requested
  window is different and legitimate: it returns a normal `AdapterResult`
  with an empty `users` list and `is_estimated: false`, not an error.

## CSV import schema

```
date,user_email,cost_usd,is_estimated
2025-11-01,jane@example.com,12.50,false
```

One row per user per day. Rows sharing a `user_email` are summed into a
single `UserUsage` entry; `is_estimated` becomes `true` for that user if
*any* of their rows set it. A malformed row (non-numeric `cost_usd`, empty
`user_email`) raises `CSVRowError` naming the exact row number rather than
silently producing `NaN` or grouping under an empty key. Cell values are
stripped of ASCII control characters (0x00-0x1F) before use, since a
crafted `user_email` could otherwise inject terminal escape sequences into
the non-JSON summary output.

## Report file and terminal output

Every run writes `teamspend-snapshot-<timestamp>.json` to the current
directory with `0600` permissions (owner read/write only) -- the report
contains per-user emails and dollar amounts, which is quasi-sensitive data
that shouldn't be world/group-readable on a shared host. The first run in
a directory also appends `teamspend-snapshot-*.json` to `.gitignore` if
one doesn't already exist, and prints a one-time note about it; every run
(not just the first) prints a reminder that the same data is also printed
to stdout, since a `.gitignore` entry does nothing to protect CI build
logs.

`--json` changes only what prints to the terminal (the full JSON report
instead of the human-readable summary); the JSON report file itself is
always written regardless of `--json`.

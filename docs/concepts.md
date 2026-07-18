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

## Personal usage mode (`claude-code-personal`)

Unlike every other tool id, `claude-code-personal` doesn't call an admin
API at all -- `fetchClaudeCodePersonalUsage` / `fetch_claude_code_personal_usage`
reads Claude Code's own local JSONL session logs directly off disk, so it
needs no credential and never checks a `TEAMSPEND_*_TOKEN` env var. It's
for the person who wants their own personal usage, not a team admin
comparing org-wide spend.

**Directory resolution** (same order Claude Code itself uses):

1. `CLAUDE_CONFIG_DIR` -- a comma-separated list; every entry is scanned,
   not just the first. Each entry may already point at a `projects/`
   directory or be the parent config dir that contains one.
2. Else, `$XDG_CONFIG_HOME/claude/projects` (defaulting `XDG_CONFIG_HOME`
   itself to `~/.config` per the XDG spec) IF that directory exists.
3. Else, the legacy default: `~/.claude/projects`.

Every `*.jsonl` file under the resolved directory(ies) is read recursively,
including nested `subagents/` subdirectories. No matching files anywhere
raises `DataUnavailableError` naming the exact directory(ies) checked,
never a silent zero.

**Parsing and window filtering.** Each JSONL line is one usage event;
entries are matched against the requested window by comparing the
`YYYY-MM-DD` prefix of `timestamp`. A malformed/corrupted line (Claude
Code's own logs can end mid-write if a session crashes) is skipped rather
than failing the whole read.

**Dedup.** Retried requests can appear more than once in the logs. Entries
are deduped by the `(message.id, requestId)` pair before summing; an entry
missing both is treated as unique (can't be meaningfully deduped without
either identifier).

**Cost.** `costUSD` is trusted when present on a line. When it's absent,
that line's token counts still count toward the totals, but not a dollar
figure, and the whole result is flagged `isEstimated` -- the same "never
present a guess as an exact number" rule the suspicious-zero detection
above follows.

**Identity.** There's no vendor-supplied `user_id`/`email` in a local log
file, so the single `UserUsage` entry uses the OS login name
(`os.userInfo().username` / `getpass.getuser()`) as `userId`, or the fixed
placeholder `"local-user"` if the OS can't answer (e.g. inside a minimal
container with no passwd entry). `userEmail` is always `null` in this mode.

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

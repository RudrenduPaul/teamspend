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

Copilot has no equivalent conditional rule -- see "Copilot's usage-based
report pagination and cost derivation" below for why every Copilot result
is unconditionally `is_estimated`.

## Copilot's usage-based report pagination and cost derivation

GitHub Copilot's real, current (non-deprecated) usage metrics API --
`GET /orgs/{org}/copilot/metrics/reports/users-1-day` -- is structurally
different from Cursor's and Claude Code's admin APIs in three ways that
`fetch_copilot_spend` / `fetchCopilotSpend` has to work around:

1. **No arbitrary date range.** The API only exposes single-day
   (`users-1-day?day=YYYY-MM-DD`) or latest-rolling-28-day
   (`users-28-day/latest`) granularity, no `start`/`end` query params. To
   honor a caller-supplied window, the adapter requests one report per
   calendar day in the window and sums per-user totals across days -- the
   same "chunk the window, sum the chunks" shape as `fetchCursorSpend`'s
   30-day pagination, just chunked by day instead of by 30-day page. A 404
   on a given day (no Copilot activity, or the org's metrics collection
   hadn't started that day) is treated as zero users for that day, not a
   failure.
2. **Report-then-download, not one inline response.** Each report call
   returns `{download_links, report_day}`, not per-user data inline.
   `download_links` are short-lived, pre-signed GitHub-owned URLs pointing
   to NDJSON (newline-delimited JSON) files -- one JSON user record per
   line. The adapter fetches and parses each one, without forwarding the
   org's `TEAMSPEND_COPILOT_TOKEN` (the pre-signed URL carries its own
   auth and can reject an extra Authorization header).
3. **No native cost field at all.** Unlike Cursor's `cost_usd` and Claude
   Code's `spend_usd`, GitHub's Copilot metrics response has no dollar
   figure anywhere -- only usage counts (`ai_credits_used`,
   `user_initiated_interaction_count`, lines-of-code sums, feature-usage
   flags). Copilot Business/Enterprise is flat-seat billing ($19 or
   $39/seat/month, bundling a matching monthly AI-credit allowance) --
   GitHub does not expose an org's actual contracted seat price through
   any API, the same structural gap Cursor's and Claude Code's flat-seat
   plans have. The one real, vendor-reported, per-user number is
   `ai_credits_used`, which the adapter converts to USD at GitHub's own
   published, fixed rate of **1 AI credit = $0.01 USD** (not a negotiated
   or per-org price). An optional `seat_price_usd` argument
   (`TEAMSPEND_COPILOT_SEAT_PRICE_USD` from the CLI) adds a flat per-seat
   price once per user for the whole window, never once per day, to also
   reflect the license cost the credits-only figure excludes.

Because there is no vendor-reported cost field to trust or distrust in the
first place, `is_estimated` is unconditionally `true` for every Copilot
result, regardless of whether `seat_price_usd` was supplied -- every dollar
figure Copilot's adapter produces is derived, never vendor-reported.

Copilot users are identified by `user_login` (a GitHub username); the
Copilot metrics API has no email field, so `user_email` is always `null`
for Copilot users. Copilot's per-user report also has no token counts
(input/output/cache) -- `requests` maps to
`user_initiated_interaction_count` instead.

Copilot usage metrics reports have no data before `2025-10-10`. A requested
window starting before that date raises `DataUnavailableError`, the same
`--*-csv` fallback mechanics as Claude Code's window limit below.

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

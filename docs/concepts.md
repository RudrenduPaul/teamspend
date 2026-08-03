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

This detection came from watching another tool ([ccusage
#1113](https://github.com/ccusage/ccusage/pull/1113)) hit the identical
root cause -- see the project README's "Success stories" section for the
full story.

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

## Codex CLI: local-file adapter, no admin API

Like OpenCode, OpenAI's Codex CLI (github.com/openai/codex) has no
admin/team/billing API -- `fetchCodexUsage` / `fetch_codex_usage` reads
Codex's own local rollout logs directly instead of calling anything over
the network. Verified directly against `openai/codex`'s own Rust source
(`codex-rs/`), not a third-party guess:

- **Location**: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`,
  plus the same layout under `<CODEX_HOME>/archived_sessions/` (both are
  scanned). `CODEX_HOME` is a single directory (never a comma-separated
  list, unlike Claude Code's `CLAUDE_CONFIG_DIR`) and defaults to
  `~/.codex` (`codex-rs/utils/home-dir/src/lib.rs::find_codex_home`,
  `codex-rs/rollout/src/lib.rs`'s `SESSIONS_SUBDIR`/
  `ARCHIVED_SESSIONS_SUBDIR` constants, `codex-rs/rollout/src/list.rs`'s
  layout doc comment).
- **Cold-storage limitation**: Codex background-compresses any rollout
  file older than 7 days from `.jsonl` to `.jsonl.zst`
  (`codex-rs/rollout/src/compression.rs`'s `MIN_ROLLOUT_AGE`). This
  adapter only reads plain `.jsonl` -- the same tradeoff already made for
  OpenCode's SQLite store: no dependency added for a secondary on-disk
  format. A window reaching more than ~7 days back will under-report or
  come back empty; use `--*-csv` to cover that period.
- **Window filtering and per-turn usage**: each `event_msg` record with
  `payload.type == "token_count"` carries `payload.info.last_token_usage`
  (already a per-turn delta, not a cumulative total --
  `codex-rs/protocol/src/protocol.rs::TokenUsageInfo`) and a top-level
  `timestamp`. Codex fires each `token_count` event twice in a row with
  byte-identical `info`; the second copy is skipped rather than
  double-counted. `input_tokens` already includes `cached_input_tokens` as
  a subset (confirmed against `codex-api/src/sse/responses.rs`'s own
  mapping from OpenAI's Responses API `usage` object), so the adapter
  stores the net, uncached portion as `inputTokens` and the cached portion
  separately as `cacheReadTokens`, the same double-counting fix already
  applied to Gemini's adapter precedent.
- **No cost field at all -- always estimated.** Unlike OpenCode's message
  files (which at least carry a `cost: 0` placeholder), Codex's
  `token_count` events have no cost field whatsoever -- only token counts.
  teamspend bundles no per-token pricing table of its own, so `costUsd` is
  always `0` and the result is always `isEstimated: true` whenever any
  usage is found. Token counts are exact; no dollar figure is reported.
- **One synthetic user per machine, not per team member.** Codex's rollout
  logs carry no user/email field. Every `token_count` event found is
  attributed to the OS account running teamspend (same as OpenCode and
  `claude-code-personal`). `AdapterResult.users` is at most a single
  entry.
- **Missing data dir vs. an inactive window**: no local rollout logs found
  anywhere raises `DataUnavailableError`, the same fallback trigger used
  elsewhere. A resolved directory that exists but simply has no
  `token_count` events inside the requested window returns a normal
  `AdapterResult` with an empty `users` list and `isEstimated: false`, not
  an error.

Cross-checked against ccusage's own Codex guide (ccusage.com/guide/codex/)
and mrexodia/agent-cost-dashboard's `cost_dashboard.py`
(`analyze_codex_jsonl_file`), which parse the identical record shapes
independently and agree with the Rust source on every field name.

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

# teamspend

Compare what your team spent on one AI coding tool before a migration against what you spend on another one after it. One command, a direct before/after number, no spreadsheet.

    npx teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

We built this because a team we talked to was mid-migration between two AI coding tools and had no way to answer "did this actually save us money" without manually opening two separate admin consoles and reconciling the numbers by hand. Their own admin dashboards are each accurate for their own tool. Neither will ever show you the other one's number next to it, because neither vendor has a reason to make that comparison easy.

## What it does

    npx teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

    teamspend snapshot -- migration cost comparison
    Tools: cursor -> claude-code

    BEFORE (cursor)
      Total spend:      $2,140.00  (exact, usage-based)
      Active users:      14

    AFTER (claude-code)
      Total spend:      $1,860.00  (exact, usage-based)
      Active users:      14

    DELTA: -$280.00 (-13.1%)

    Full report: ./teamspend-snapshot-2026-07-11T142842.json

Pulls directly from each tool's own admin API (Cursor's Admin API, Anthropic's Claude Enterprise Analytics/Admin API), not a scrape or an estimate. If a window predates a tool's API data availability, a CSV-import fallback covers that period with the same output shape.

## Install and setup

    npm install -g teamspend
    # or, for a one-off run:
    npx teamspend snapshot ...

Set the admin API credentials for the two tools you're comparing as environment variables:

    export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
    export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

Both require org-admin-level access on the respective platform. Confirm you have that before running this against your own account.

## A note on where the output goes

Every run prints per-user email and spend data to the terminal (and to the always-written JSON report file, which the CLI restricts to owner-only file permissions and gitignores automatically). If you wire `teamspend snapshot` into a scheduled CI workflow rather than running it locally, that output lands in your CI provider's build logs. For a public repository, build logs are frequently visible to anyone, independent of any `.gitignore` rule protecting the on-disk file. Confirm your CI provider's log visibility settings before running this in a public-repo workflow.

## Measured, not asserted

Every number below is reproducible from a clean clone (`npm run build && npm test`), not a marketing estimate:

| Metric | Value |
|---|---|
| Runtime dependencies | 0 (native `fetch`, native `node:util.parseArgs`, native `node:fs`) |
| Published package size | 19.7 kB packed / 67.8 kB unpacked |
| Cold install -> first CLI response | ~1.2s (`npm install` + first invocation, measured on Node 24) |
| Test suite | 32 tests, 97.7% line coverage, 0 unfixed HIGH/CRITICAL `npm audit` findings |

## What this tool does not do (yet, or ever)

- No ongoing dashboard. This is a one-shot snapshot for a migration decision, not a running service.
- No Copilot or OpenCode adapter in this version. The two admin-API-native tools this build targets are Cursor and Claude Code.
- No non-USD billing support.
- Fixtures used in the test suite are derived from each vendor's published API documentation, not verified against a live account. The first real validation against a live account's actual response shape happens on your own first run. If you hit a parsing error, that's a real signal the vendor's API shape has drifted from what's documented here, and an issue report is genuinely useful.

## CSV-import fallback

If your "before" window predates Anthropic's Analytics API start date (2026-01-01), or you need to supply historical data another way, pass a CSV file matching this schema:

    date,user_email,cost_usd,is_estimated
    2025-11-01,jane@example.com,12.50,false

    npx teamspend snapshot --tools cursor,claude-code --before 2025-11-01:2025-11-30 --after 2026-06-01:2026-06-30 --before-csv ./before.csv

## Development

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

## License

Apache 2.0.

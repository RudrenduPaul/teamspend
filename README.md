# teamspend

[![CI](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml/badge.svg)](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.3.0-brightgreen.svg)](package.json)

Your team switched from one AI coding tool to another. Did it actually save money? Right now the only way to know is opening two admin dashboards and doing the math by hand. teamspend does that math for you, in one command.

    npx teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

That's it. Real numbers pulled straight from each vendor's own API, a clean before and after, done.

## Why this exists

We talked to a team mid-migration between two AI coding tools who wanted a straight answer to a simple question: is this switch actually cheaper. Their old tool's dashboard could tell them what they used to spend. Their new tool's dashboard could tell them what they spend now. Neither could put both numbers side by side, because no vendor has a reason to make it easy to compare their price against a competitor's.

So we built the thing that does exactly that and nothing else.

## See it in action

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

No scraping, no estimates, no guesswork. Every number comes straight from the vendor's own admin API (Cursor's Admin API, Anthropic's Claude Enterprise Analytics API). If your comparison window reaches back further than a tool's API history, a CSV import fills that gap using the same normalized output.

## Get started in under a minute

    npm install -g teamspend

Then give it the two API keys for the tools you're comparing:

    export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
    export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

Both need org-admin-level access on their platform. If you can see billing for your org today, you already have what you need.

Run it once, get your answer:

    teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

## Built to be trusted, not just used

We think a tool that touches your team's spend and email data should earn that trust in the open, so here's what's actually true about this codebase, checked on every commit:

| | |
|---|---|
| Runtime dependencies | Zero. Native `fetch`, native `node:util.parseArgs`, native `node:fs`. Nothing to audit but our own code. |
| Package size | 19.7 kB packed, 67.8 kB unpacked |
| Cold install to first response | About 1.2 seconds |
| Tests | 36 passing, 97.7% line coverage |
| Known vulnerabilities | Zero, per `npm audit` |
| File permissions | The report file is written owner-only (`0600`) and auto-added to `.gitignore`, since it holds per-user emails and spend |

## CSV import, for the history a live API can't reach

If your "before" window predates a tool's API data availability (Anthropic's Analytics API only goes back to January 1, 2026), hand teamspend a CSV instead:

    date,user_email,cost_usd,is_estimated
    2025-11-01,jane@example.com,12.50,false

    npx teamspend snapshot --tools cursor,claude-code --before 2025-11-01:2025-11-30 --after 2026-06-01:2026-06-30 --before-csv ./before.csv

## Good to know before you run it

- This is a snapshot tool, not a dashboard. It answers one question well: what changed between two periods. It doesn't run in the background or track anything ongoing.
- Cursor and Claude Code are the two tools this version talks to. Copilot and OpenCode aren't wired up yet.
- USD only, for now.
- The output includes real emails and dollar amounts, printed to your terminal and saved to a report file. If you run this in a scheduled CI job on a public repo, that data lands in your build logs, so check your CI provider's log visibility before you automate it.
- The test fixtures are built from each vendor's published API docs, not a live account. If your first real run throws a parsing error, that's a genuine signal the vendor changed something, not a bug we're hiding from you. Open an issue, it helps.

## Contributing

Found a rough edge, a vendor API that shifted shape, or a tool you wish this supported? Open an issue or a pull request. The codebase is small on purpose, so a fix or a new adapter is usually a smaller change than it looks.

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

## License

Apache 2.0.

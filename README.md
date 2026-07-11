# teamspend

[![CI](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml/badge.svg)](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.3.0-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**Your AI coding tools will never tell you if switching between them actually saved money. teamspend does, in one command.**

    npx teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

More teams are running more than one AI coding tool at once, or moving between them, than ever before. Every one of those tools has a dashboard that's perfectly accurate about itself and structurally incapable of showing you anything else. teamspend is the missing piece: one real number, pulled straight from both tools' own APIs, showing exactly what changed.

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

That's the whole product. One command, one honest number, zero spreadsheets.

## What it actually does

- **Pulls real numbers, not scrapes or estimates.** Talks directly to Cursor's Admin API and Anthropic's Claude Enterprise Analytics API. What you see is what the vendor itself reports.
- **Compares across tools, which no single vendor dashboard will ever do.** Cursor's dashboard shows Cursor. Claude Code's dashboard shows Claude Code. teamspend puts both numbers in the same sentence.
- **Fills historical gaps with CSV import.** If your comparison window reaches back further than a tool's API history, hand it a CSV in the same shape and it merges in seamlessly.
- **Never fails silently.** If one side of the comparison can't be fetched, you get a clear "data unavailable" and a reason, never a wrong number presented as a right one.
- **Retries the way a production client should.** Rate limits and transient errors get exponential backoff automatically, capped and bounded, so a flaky API call doesn't mean a flaky result.
- **Ships with zero runtime dependencies.** No supply chain to audit but our own code. Native `fetch`, native argument parsing, native file I/O.

## Get started in under a minute

    npm install -g teamspend

Give it the two API keys for the tools you're comparing:

    export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
    export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

Both need org-admin-level access on their platform. If you can already see billing for your org, you have what you need.

    teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

## Built to be trusted, not just used

A tool that touches your team's spend and email data should earn that trust in the open. Here's what's actually true about this codebase, checked on every commit, not asserted in a marketing paragraph:

| | |
|---|---|
| Runtime dependencies | Zero |
| Package size | 19.7 kB packed, 67.8 kB unpacked |
| Cold install to first response | About 1.2 seconds |
| Tests | 36 passing, 97.7% line coverage |
| Known vulnerabilities | Zero, per `npm audit` |
| File permissions | Report files are owner-only (`0600`) and auto-gitignored, since they hold per-user emails and spend |

## CSV import, for the history a live API can't reach

    date,user_email,cost_usd,is_estimated
    2025-11-01,jane@example.com,12.50,false

    npx teamspend snapshot --tools cursor,claude-code --before 2025-11-01:2025-11-30 --after 2026-06-01:2026-06-30 --before-csv ./before.csv

## Roadmap

This started narrow on purpose: prove the idea on the two tools one real team was actually migrating between, get it right, then grow it. Next up, roughly in order of how often people ask:

- [ ] GitHub Copilot adapter
- [ ] OpenCode adapter
- [ ] Non-USD billing support

Want one of these sooner, or a tool that isn't on the list? Open an issue and say so. That's genuinely how the order gets decided.

## Good to know before you run it

- This is a snapshot tool, not a running dashboard. It answers one question well and stops.
- The output includes real emails and dollar amounts, printed to your terminal and saved to a report file. If you wire this into a scheduled CI job on a public repo, that data lands in your build logs, so check your CI provider's log visibility first.
- Test fixtures are built from each vendor's published API docs, not a live account. If your first real run throws a parsing error, that's a genuine signal a vendor's API shape drifted, not a bug we're hiding from you. Open an issue, it helps everyone who runs into it next.

## Contributing

Found a rough edge, a vendor API that shifted shape, or a tool you wish this supported? Open an issue or a pull request. The codebase is small on purpose, so a fix or a new adapter is usually a smaller change than it looks.

    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

If teamspend saved you from opening two dashboards and doing math by hand, a star helps other people with the same problem find it.

## License

Apache 2.0.

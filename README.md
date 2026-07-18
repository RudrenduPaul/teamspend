# teamspend

[![npm version](https://img.shields.io/npm/v/teamspend.svg)](https://www.npmjs.com/package/teamspend)
[![PyPI version](https://img.shields.io/pypi/v/teamspend.svg)](https://pypi.org/project/teamspend/)
[![CI](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml/badge.svg)](https://github.com/RudrenduPaul/teamspend/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.3.0-brightgreen.svg)](package.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**Your AI coding tools will never tell you if switching between them actually saved money. teamspend does, in one command.**

    npx teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

<!-- TODO: record a real terminal capture (asciinema or a short GIF) of the command above
     against a real Cursor + Claude Code org and embed it here. Capture script:
     1. export TEAMSPEND_CURSOR_TOKEN=... TEAMSPEND_CLAUDE_CODE_TOKEN=...
     2. Run the exact command in the hook above in a clean terminal, 80 columns wide.
     3. Record with `asciinema rec demo.cast` or a short screen-recording GIF, 10-15s,
        ending on the printed DELTA line.
     4. Save as demo.gif in the repo root, then replace this comment with
        `![teamspend snapshot output showing a before/after spend delta](demo.gif)`. -->

More teams are running more than one AI coding tool at once, or moving between them, than ever before. Every one of those tools has a dashboard that's perfectly accurate about itself and structurally incapable of showing you anything else. teamspend is the missing piece: one real number, pulled straight from both tools' own APIs, showing exactly what changed.

## Table of contents

- [See it in action](#see-it-in-action)
- [What it actually does](#what-it-actually-does)
- [Get started in under a minute](#get-started-in-under-a-minute)
- [Built to be trusted, not just used](#built-to-be-trusted-not-just-used)
- [CSV import, for the history a live API can't reach](#csv-import-for-the-history-a-live-api-cant-reach)
- [GitHub Copilot support](#github-copilot-support)
- [Roadmap](#roadmap)
- [Good to know before you run it](#good-to-know-before-you-run-it)
- [What is teamspend, and why does it exist](#what-is-teamspend-and-why-does-it-exist)
- [How teamspend compares](#how-teamspend-compares)
- [FAQ](#faq)
- [Contributing](#contributing)
- [Success stories](#success-stories)
- [License](#license)

## See it in action

    npx teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

Example output (shape shown below; your real numbers come from your own org's API data):

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
- **Retries the way a production client should.** Rate limits, timeouts, and transient errors get exponential backoff automatically, capped and bounded, so a flaky API call doesn't mean a flaky result.
- **Flags suspicious zeros instead of trusting them.** Flat-seat billing tiers on both Cursor and Claude Code can report an exact-looking `$0` for a user with real token activity. teamspend detects that pattern and marks the number estimated rather than showing a misleading zero.
- **Ships with zero runtime dependencies.** No supply chain to audit but our own code. Native `fetch`, native argument parsing, native file I/O.

## Get started in under a minute

teamspend ships two independent, equally first-class packages -- pick
whichever fits your toolchain, or install both. Neither is deprecated in
favor of the other; they talk to the same two admin APIs and compute the
same before/after delta.

    # npm -- JavaScript/TypeScript CLI + library
    npm install -g teamspend

    # PyPI -- Python CLI + library (genuine port, not a wrapper around the Node binary)
    pip install teamspend

Give it the two API keys for the tools you're comparing:

    export TEAMSPEND_CURSOR_TOKEN=<your Cursor Admin API key>
    export TEAMSPEND_CLAUDE_CODE_TOKEN=<your Anthropic Admin/Analytics API key>

Both need org-admin-level access on their platform. If you can already see billing for your org, you have what you need.

    teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

Comparing against GitHub Copilot instead? See
["GitHub Copilot support"](#github-copilot-support) below -- it needs two
more environment variables than Cursor/Claude Code do, for reasons that are
worth reading before you point it at a real org.

Both CLIs accept identical flags and print the same output shape. See
[python/README.md](./python/README.md) for the Python package's library API
and [docs/getting-started.md](./docs/getting-started.md) for the full guide
covering both distributions.

## Built to be trusted, not just used

A tool that touches your team's spend and email data should earn that trust in the open. Here's what's actually true about this codebase, checked on every commit, not asserted in a marketing paragraph:

| | |
|---|---|
| Runtime dependencies | Zero |
| Package size | 27.3 kB packed, 88.3 kB unpacked |
| Cold install to first response | Under 1 second, measured with a cleared npm/npx cache |
| Tests | 58 passing, 98.2% line coverage |
| Known vulnerabilities | Zero, per `npm audit` |
| File permissions | Report files are owner-only (`0600`) and auto-gitignored, since they hold per-user emails and spend |

## CSV import, for the history a live API can't reach

    date,user_email,cost_usd,is_estimated
    2025-11-01,jane@example.com,12.50,false

    npx teamspend --tools cursor,claude-code --before 2025-11-01:2025-11-30 --after 2026-06-01:2026-06-30 --before-csv ./before.csv

## GitHub Copilot support

    export TEAMSPEND_COPILOT_TOKEN=<a token with read:org on the org>
    export TEAMSPEND_COPILOT_ORG=<your GitHub org login>
    export TEAMSPEND_COPILOT_SEAT_PRICE_USD=19   # optional, see below

    npx teamspend --tools cursor,copilot --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

**Credential:** `TEAMSPEND_COPILOT_TOKEN` needs the `read:org` scope (a
classic PAT) or the fine-grained "View Organization Copilot Metrics"
permission, and the org must be on Copilot Business or Enterprise.
`TEAMSPEND_COPILOT_ORG` is required too -- unlike Cursor's and Claude
Code's admin APIs, GitHub's Copilot metrics endpoint is scoped to a specific
org login in the URL path itself, not just the token.

**How teamspend derives a dollar figure, honestly:** GitHub's real, current
Copilot usage metrics API (`GET /orgs/{org}/copilot/metrics/reports/
users-1-day`, confirmed against GitHub's own docs while building this --
the older `/orgs/{org}/copilot/metrics` endpoint some other tools still
reference was sunset by GitHub on 2026-04-02 and no longer works) has **no
cost or spend field anywhere**. Copilot Business/Enterprise is flat-seat
billing ($19 or $39 per seat per month, bundling a matching monthly AI-credit
allowance), and GitHub does not expose an org's actual contracted seat price
through any API -- the same structural gap Cursor's and Claude Code's
flat-seat billing tiers already have in this tool.

What the API *does* return per user is `ai_credits_used`. teamspend converts
that to USD at GitHub's own published, fixed rate of **1 AI credit = $0.01
USD** -- not invented, and not a negotiated per-org price. If you set
`TEAMSPEND_COPILOT_SEAT_PRICE_USD`, that flat price is added once per active
user for the whole comparison window (never once per day) to also reflect
the license cost the credits-only figure excludes; if you don't set it, the
reported number is credits-usage cost only and explicitly does not include
the seat fee.

Because there is no vendor-reported cost field to begin with, every Copilot
result -- with or without a seat price -- is marked `isEstimated: true`.
This is a stronger caveat than Cursor's and Claude Code's suspicious-zero
flag, which only fires on a specific zero-cost pattern: Copilot has no
native dollar figure to trust in the first place, so teamspend never claims
one. See [docs/concepts.md](./docs/concepts.md#copilots-usage-based-report-pagination-and-cost-derivation)
for the full mechanics, including why one comparison window means one API
call per calendar day rather than one call for the whole range.

## Roadmap

This started narrow on purpose: prove the idea on the two tools one real team was actually migrating between, get it right, then grow it. Next up, roughly in order of how often people ask:

- [x] GitHub Copilot adapter
- [ ] OpenCode adapter
- [ ] Non-USD billing support

Want one of these sooner, or a tool that isn't on the list? Open an issue and say so. That's genuinely how the order gets decided.

## Good to know before you run it

- This is a snapshot tool, not a running dashboard. It answers one question well and stops.
- The output includes real emails and dollar amounts, printed to your terminal and saved to a report file. If you wire this into a scheduled CI job on a public repo, that data lands in your build logs, so check your CI provider's log visibility first.
- Test fixtures are built from each vendor's published API docs, not a live account. If your first real run throws a parsing error, that's a genuine signal a vendor's API shape drifted, not a bug we're hiding from you. Open an issue, it helps everyone who runs into it next.
- Flat-seat and per-seat billing tiers (Cursor plans without usage overage, Claude.ai Team/Enterprise seats) don't expose true per-user cost through the vendor's own Admin API. When teamspend sees a user with real token or request activity but a reported cost of exactly $0, it marks that user's number, and the whole report, as estimated rather than showing a misleading exact-looking $0.

## What is teamspend, and why does it exist

teamspend is a command-line tool that answers one question: **when a team moves from one AI coding tool to another, or runs two at once, what did that actually cost, in real dollars, pulled straight from each vendor's own admin API?**

It exists because no vendor's dashboard can answer that question, structurally. Cursor's Admin API reports Cursor spend. Anthropic's Claude Enterprise Analytics API reports Claude Code spend. Neither has a reason to show a competitor's number next to its own, so a team mid-migration is left opening two dashboards and doing the subtraction by hand. teamspend does the same thing a `diff` does for two files: it pulls both sides through the same normalized schema and prints one honest delta.

It is deliberately narrow. teamspend does not run continuously, does not host a dashboard, and does not track more than a before/after window for two tools at a time (Cursor and Claude Code, in v0.1). It is a single command that answers a single question and exits.

## How teamspend compares

This is a narrow tool built for one specific job. It is not trying to replace the two projects below, and if what you actually need is what they do well, use them instead.

| | teamspend | [tokscale](https://github.com/junhoyeo/tokscale) | [Vantage](https://www.vantage.sh) |
|---|---|---|---|
| What it answers | "What did our team's spend change by, across a migration between two tools?" | "How much have I personally used across 40+ coding-agent CLIs?" | "What is my org spending across cloud, SaaS, and AI, all in one console?" |
| Audience | The person who has to answer for a team's AI tool bill | An individual developer tracking their own usage | A funded platform team consolidating multi-cloud cost |
| Cursor + Claude Code cost data | Yes, via each vendor's own Admin API | Yes, via 40+ tool integrations including Cursor and Claude Code | Yes, both ship as live connectors on Vantage's own site |
| Team budget / before-after migration view | Yes, this is the entire product | Not requested by its own community as of this writing | Not migration-specific; broader cost-allocation platform |
| Scale and backing | New, single-purpose OSS project | 4,400+ stars, 425 forks, MIT-licensed, actively maintained | $25M raised (seed + Series A), commercial platform |

**[tokscale](https://github.com/junhoyeo/tokscale)** is a genuinely good project: 4,400+ stars, tracks personal token usage across 40+ coding-agent tools with a leaderboard and contribution graph. Checking its last 100 issues turns up zero requests for team budgets, manager dashboards, or spend rollups, because that's not the product it's building. If what you want is a personal usage tracker across every AI CLI you use, use tokscale. teamspend exists for a different question, the one a team's budget owner asks, not the one an individual contributor asks.

**[Vantage](https://www.vantage.sh)** already ships live Cursor and Anthropic connectors as part of a broader cloud/SaaS/AI cost platform. If you're already consolidating your full cloud bill through Vantage, it's a solid choice and covers more ground than teamspend ever will. teamspend is for the narrower case: a lightweight, single-purpose tool for one migration decision, without adopting a full cost-management platform to get there.

**Cursor's, Claude Code's, and Copilot's own admin consoles** are each accurate for their own tool. Use them if you only run one. teamspend exists for the moment you're comparing two, because none of them will ever put a competitor's number in the same view as their own.

## FAQ

**Does teamspend replace Cursor's or Claude Code's own admin console?**
No. Each vendor's console is still the accurate source for that vendor's own numbers, and for anything beyond spend (seat management, usage policy, model access). teamspend exists for the one thing neither console does: putting both tools' numbers in the same comparison.

**What happens if one tool's API call fails partway through?**
The whole comparison is marked incomplete rather than silently reported as complete. `buildComparison` in `src/compare.ts` only computes a delta when both sides resolved; if either side failed, the report shows `DATA UNAVAILABLE` for that side and a null delta, never a number derived from a partial fetch.

**Does teamspend store or send my team's spend data anywhere?**
No. It's a local CLI: it calls each vendor's API directly from your machine, prints a summary to your terminal, and writes one JSON report file (`0600` permissions) to your current directory. Nothing is sent to teamspend or any third party.

**Can I use teamspend for tools other than Cursor and Claude Code?**
GitHub Copilot is also supported now -- see ["GitHub Copilot support"](#github-copilot-support) above, including an honest note on how its cost figure is derived since GitHub's own API has no dollar field to report. An OpenCode adapter is next on the roadmap; a CSV-import fallback already lets you supply spend data for any other tool in the meantime, using the same `date,user_email,cost_usd,is_estimated` schema documented above.

**Why does a $0 spend number sometimes show up as "estimated" instead of exact?**
Some billing tiers (flat-seat Cursor plans, Claude.ai Team/Enterprise seats) don't expose true per-user cost through the vendor's own Admin API and report an exact-looking `$0` even for users with real activity. teamspend detects a `$0` cost paired with non-zero token or request counts and flags it as estimated rather than presenting a misleading exact zero. See "Success stories" below for the two independent bug reports in other tools that led to this fix.

## Contributing

Found a rough edge, a vendor API that shifted shape, or a tool you wish this supported? Open an issue or a pull request. The codebase is small on purpose, so a fix or a new adapter is usually a smaller change than it looks. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide covering both the npm (TypeScript) and PyPI (Python, `python/`) packages -- an adapter change should land in both.

    # TypeScript (repo root)
    npm install
    npm run build
    npm run lint
    npm run typecheck
    npm test

    # Python (python/)
    cd python
    pip install -e ".[dev]"
    pytest

If teamspend saved you from opening two dashboards and doing math by hand, a star helps other people with the same problem find it.

## Success stories

The suspicious-zero fix above wasn't found in a vacuum. It came from watching two other teams hit the exact same wall in their own tools and treating their bug reports as a spec.

- [liuzemei's PR](https://github.com/ccusage/ccusage/pull/1113) to ccusage fixed the same root problem: on flat-seat billing, a vendor's own API can report cost_usd: 0 for a user who is clearly active, and a tool that trusts that number at face value ends up telling a team its top spender costs nothing. teamspend had the identical gap in its Cursor and Claude Code adapters. The two fixes take different routes though, ccusage recomputes a real dollar figure from its pricing table when it hits that zero, while teamspend takes the more modest step of just flagging the number as estimated instead of presenting a wrong zero as a real one.
- [anudeepkolla16's PR](https://github.com/sarasanalytics-com/saras-usage-dashboard/pull/19) to saras-usage-dashboard found the same failure mode independently, in a different codebase entirely. Two unrelated teams hitting the same vendor blind spot is a good sign it's a real, recurring problem worth fixing properly rather than a one-off edge case.

## License

Apache 2.0.

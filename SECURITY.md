# Security Policy

teamspend handles two categories of sensitive data by design: admin-API
credentials (via environment variables) and the per-user email + spend
data those APIs return. A vulnerability that exposes either beyond
teamspend's documented behavior -- printing to your own terminal, writing
one local report file -- is taken seriously and handled as a priority.

## Supported versions

| Package | Version | Supported |
| --- | --- | --- |
| `teamspend` (npm) | 0.1.x | Yes |
| `teamspend` (PyPI) | 0.1.x | Yes |

Both distributions are pre-1.0 and under active development. Security
fixes land on the latest `0.1.x` release of each; there is no older
supported line to backport to yet.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report it privately via
[GitHub Security Advisories](https://github.com/RudrenduPaul/teamspend/security/advisories/new)
for this repository. Include:

- Which distribution is affected (npm package, PyPI package, or both).
- A minimal reproduction: the command or library call, and what you
  expected teamspend to do versus what it actually did.
- Your assessment of impact -- e.g. "a crafted CSV cell injects terminal
  escape sequences into the human-readable summary" is the kind of
  trust-boundary issue that's already been proactively closed once (see
  the control-character stripping in `src/adapters/csv-import.ts` /
  `python/src/teamspend/adapters/csv_import.py`) and a bypass of that
  mitigation would be in scope.

## What counts as in scope

- Any code path where content read from an admin-API response or an
  imported CSV file is executed, evaluated, or used to construct a shell
  command, rather than only parsed and validated with
  `requireField`/`require_field`.
- A crafted CSV cell, user_email, or vendor-API field value that can
  manipulate what a human sees in the terminal output (terminal/ANSI
  injection) beyond what the existing control-character stripping already
  covers.
- Anything that causes the JSON report file
  (`teamspend-snapshot-*.json`) to be written with permissions broader
  than owner-only (`0600`), or written to a location other than the
  current working directory.
- Anything that causes an admin-API credential (`TEAMSPEND_CURSOR_TOKEN`,
  `TEAMSPEND_CLAUDE_CODE_TOKEN`) to be logged, written to disk, or sent
  anywhere other than the vendor's own API endpoint it's meant for.
- A crafted, extremely large, or malformed API response or CSV file that
  causes unbounded resource consumption (an unbounded loop, unbounded
  memory) rather than a clean, named error.

## What is out of scope

- The accuracy of a vendor's own admin-API response -- if Cursor's or
  Anthropic's API itself reports an incorrect number, that's a report for
  that vendor, not teamspend. `SchemaDriftError` (a field teamspend
  expected is missing) is a compatibility bug worth a normal issue, not a
  security report, unless it's paired with one of the in-scope categories
  above.
- Findings that assume a user has already put their own admin-API
  credential in an insecure location (a public repo's `.env` file, a
  world-readable shell history). teamspend reads credentials only from
  environment variables it does not set or persist itself.

## What teamspend does not do (by design, not by omission)

- No telemetry, no analytics, no calls to any endpoint other than the two
  documented admin APIs (Cursor, Anthropic) and, for CSV import, the local
  filesystem. Nothing is sent to teamspend's maintainers or any third
  party.
- No supply-chain surface beyond the language runtime's own standard
  library: the npm package has zero runtime dependencies (native `fetch`,
  native `parseArgs`), and the Python package has zero runtime
  dependencies (`urllib` from the standard library). There is no
  third-party HTTP client or CLI-framework dependency to audit in either
  distribution.

## Response

We aim to acknowledge a report within 5 business days and to have a fix or
a mitigation plan within 30 days for a confirmed, in-scope vulnerability.
Credit is given in the release notes unless you ask to remain anonymous.

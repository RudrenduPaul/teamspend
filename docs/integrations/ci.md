# CI integrations

teamspend is a snapshot tool, not a running dashboard, so the typical CI
use case is a scheduled job that runs a comparison periodically and posts
or archives the result -- not a pass/fail gate on every PR.

## GitHub Actions -- npm CLI, scheduled snapshot

```yaml
name: teamspend snapshot (npm)
on:
  schedule:
    - cron: '0 9 * * 1'  # every Monday at 09:00 UTC
  workflow_dispatch: {}

jobs:
  snapshot:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Run teamspend
        env:
          TEAMSPEND_CURSOR_TOKEN: ${{ secrets.TEAMSPEND_CURSOR_TOKEN }}
          TEAMSPEND_CLAUDE_CODE_TOKEN: ${{ secrets.TEAMSPEND_CLAUDE_CODE_TOKEN }}
        run: npx teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30 --json > snapshot.json
      - uses: actions/upload-artifact@v4
        with:
          name: teamspend-snapshot
          path: snapshot.json
```

## GitHub Actions -- Python CLI, scheduled snapshot

```yaml
name: teamspend snapshot (Python)
on:
  schedule:
    - cron: '0 9 * * 1'
  workflow_dispatch: {}

jobs:
  snapshot:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install teamspend
      - name: Run teamspend
        env:
          TEAMSPEND_CURSOR_TOKEN: ${{ secrets.TEAMSPEND_CURSOR_TOKEN }}
          TEAMSPEND_CLAUDE_CODE_TOKEN: ${{ secrets.TEAMSPEND_CLAUDE_CODE_TOKEN }}
        run: teamspend --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30 --json > snapshot.json
      - uses: actions/upload-artifact@v4
        with:
          name: teamspend-snapshot
          path: snapshot.json
```

**Before wiring either of these in**: teamspend's output includes real
per-user emails and dollar amounts, printed to stdout and written to the
report file. Confirm your CI provider's build logs and artifact storage
are private for this repository before scheduling a run -- teamspend
itself warns about this on every run (see
[concepts.md](../concepts.md#report-file-and-terminal-output)), but the
warning only helps if someone reads it before the first scheduled run
lands in a public log.

## Calling the library directly in a custom script

For a CI step that needs to do more than print a report (e.g. post a
Slack message only when the delta crosses a threshold), call the library
directly instead of parsing the CLI's stdout:

```python
import os
import sys

from teamspend import (
    DateWindow,
    PeriodOutcome,
    build_comparison,
    fetch_claude_code_spend,
    fetch_cursor_spend,
)

before = fetch_cursor_spend(
    DateWindow("2026-04-01", "2026-04-30"), os.environ["TEAMSPEND_CURSOR_TOKEN"]
)
after = fetch_claude_code_spend(
    DateWindow("2026-06-01", "2026-06-30"), os.environ["TEAMSPEND_CLAUDE_CODE_TOKEN"]
)
report = build_comparison(
    PeriodOutcome("before", "cursor", before, None),
    PeriodOutcome("after", "claude-code", after, None),
)

if report.delta_usd is not None and report.delta_usd > 500:
    print(f"Spend increased by ${report.delta_usd:.2f} -- flagging for review.")
    sys.exit(1)
```

See [python/examples/02-ci-gate](../../python/examples/02-ci-gate) for a
complete, runnable version of this pattern.

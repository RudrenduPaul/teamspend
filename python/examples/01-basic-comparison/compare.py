#!/usr/bin/env python3
"""
01 -- basic comparison.

The simplest possible use of the teamspend library: call fetch_cursor_spend()
and fetch_claude_code_spend(), then build_comparison() to get a delta. This
example replays the repo's own bundled fixtures
(python/fixtures/cursor.fixture.json, claude-code.fixture.json) through a
custom `transport` instead of making a real network call, so it runs
standalone with no API keys and no network access.

To run this against your own real data instead, drop the `transport=`
keyword argument and set TEAMSPEND_CURSOR_TOKEN / TEAMSPEND_CLAUDE_CODE_TOKEN
-- fetch_cursor_spend/fetch_claude_code_spend then hit the real admin APIs.

Run:
    python3 examples/01-basic-comparison/compare.py
"""
from pathlib import Path

from teamspend import (
    DateWindow,
    PeriodOutcome,
    build_comparison,
    fetch_claude_code_spend,
    fetch_cursor_spend,
    render_terminal_summary,
)
from teamspend.http_client import HttpResponse

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def _fixture_transport(fixture_name: str):
    """Returns a `transport` callable that always replays one fixture file."""
    body = (FIXTURES_DIR / fixture_name).read_bytes()

    def transport(url: str, headers: dict, timeout: float) -> HttpResponse:
        return HttpResponse(status=200, body=body)

    return transport


def main() -> None:
    before_window = DateWindow("2026-04-01", "2026-04-30")
    after_window = DateWindow("2026-06-01", "2026-06-30")

    before_result = fetch_cursor_spend(
        before_window, "demo-key", transport=_fixture_transport("cursor.fixture.json")
    )
    after_result = fetch_claude_code_spend(
        after_window,
        "demo-key",
        transport=_fixture_transport("claude-code.fixture.json"),
    )

    report = build_comparison(
        PeriodOutcome("before", "cursor", before_result, None),
        PeriodOutcome("after", "claude-code", after_result, None),
    )

    print(render_terminal_summary(report))


if __name__ == "__main__":
    main()

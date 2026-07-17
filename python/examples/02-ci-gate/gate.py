#!/usr/bin/env python3
"""
02 -- CI gate.

Demonstrates using the teamspend library as an actual CI gate: fetch both
periods, build the comparison, and exit non-zero if the spend increase
crosses a threshold -- exactly what you'd drop into a scheduled CI job
(see ../../../docs/integrations/ci.md for the GitHub Actions version of
this same pattern).

Uses the bundled fixtures via a custom transport, so it runs standalone
with no API keys. Pass a real dollar threshold as argv[1] to try different
gate values (default: 50.00).

Run:
    python3 examples/02-ci-gate/gate.py
    python3 examples/02-ci-gate/gate.py 10.00
"""
import sys
from pathlib import Path

from teamspend import (
    DateWindow,
    PeriodOutcome,
    build_comparison,
    fetch_claude_code_spend,
    fetch_cursor_spend,
)
from teamspend.http_client import HttpResponse

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"


def _fixture_transport(fixture_name: str):
    body = (FIXTURES_DIR / fixture_name).read_bytes()

    def transport(url: str, headers: dict, timeout: float) -> HttpResponse:
        return HttpResponse(status=200, body=body)

    return transport


def main() -> int:
    threshold_usd = float(sys.argv[1]) if len(sys.argv) > 1 else 50.00

    before = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-30"),
        "demo-key",
        transport=_fixture_transport("cursor.fixture.json"),
    )
    after = fetch_claude_code_spend(
        DateWindow("2026-06-01", "2026-06-30"),
        "demo-key",
        transport=_fixture_transport("claude-code.fixture.json"),
    )

    report = build_comparison(
        PeriodOutcome("before", "cursor", before, None),
        PeriodOutcome("after", "claude-code", after, None),
    )

    if report.delta_usd is None:
        print("GATE ERROR: one or both periods failed to fetch.", file=sys.stderr)
        return 2

    if report.delta_usd > threshold_usd:
        print(
            f"GATE FAIL: spend increased by ${report.delta_usd:.2f}, "
            f"over the ${threshold_usd:.2f} threshold.",
            file=sys.stderr,
        )
        return 1

    print(
        f"GATE PASS: spend changed by ${report.delta_usd:.2f} "
        f"(threshold ${threshold_usd:.2f})."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

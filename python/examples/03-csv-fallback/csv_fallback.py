#!/usr/bin/env python3
"""
03 -- CSV fallback.

Demonstrates the CSV-import path: a "before" window that predates Claude
Code's Analytics API start date (2026-01-01) normally raises
DataUnavailableError; supplying a CSV file in the documented schema
(date,user_email,cost_usd,is_estimated) lets teamspend fill that gap
instead. Uses the repo's bundled fixture CSV
(python/fixtures/csv-import.fixture.csv) so it runs standalone with no
setup.

Also shows what a straight (non-fallback) DataUnavailableError looks like
when no CSV is supplied, so the difference is visible side by side.

Run:
    python3 examples/03-csv-fallback/csv_fallback.py
"""
from pathlib import Path

from teamspend import DateWindow, import_from_csv
from teamspend.errors import DataUnavailableError
from teamspend.adapters.claude_code import fetch_claude_code_spend

FIXTURES_DIR = Path(__file__).resolve().parents[2] / "fixtures"
CSV_FIXTURE = FIXTURES_DIR / "csv-import.fixture.csv"

# Predates the Analytics API's 2026-01-01 start date on purpose.
PRE_API_WINDOW = DateWindow("2025-11-01", "2025-11-30")


def without_csv_fallback() -> None:
    print("--- without a CSV fallback ---")
    try:
        fetch_claude_code_spend(PRE_API_WINDOW, "demo-key")
    except DataUnavailableError as error:
        print(f"Raised as expected: {error}")
    print()


def with_csv_fallback() -> None:
    print("--- with a CSV fallback ---")
    result = import_from_csv(str(CSV_FIXTURE), "claude-code", PRE_API_WINDOW)
    print(f"source:          {result.source}")
    print(f"total_cost_usd:  ${result.total_cost_usd:.2f}")
    print(f"users:           {len(result.users)}")
    for user in result.users:
        note = " (estimated)" if user.is_estimated else ""
        print(f"  {user.user_email}: ${user.cost_usd:.2f}{note}")


if __name__ == "__main__":
    without_csv_fallback()
    with_csv_fallback()

"""
CSV-import fallback adapter, for the history a live admin API can't reach.

Ported from src/adapters/csv-import.ts. Schema: date, user_email, cost_usd,
is_estimated. One row per user per day; rows are aggregated per user_email.

Uses a simple split(",") parser rather than the stdlib `csv` module, on
purpose: the TypeScript original does the same (no quoted-field or embedded-
comma support), and keeping the two implementations' exact parsing
semantics identical matters more here than gaining stdlib `csv`'s richer
quoting support that the npm CLI doesn't have either.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Dict, List

from ..errors import CSVRowError, CSVSchemaError, EmptyCSVError
from ..types import AdapterResult, DateWindow, ToolId, UserUsage, sum_cost

EXPECTED_COLUMNS = ["date", "user_email", "cost_usd", "is_estimated"]

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f]")


def _strip_control_chars(value: str) -> str:
    """
    Strips C0 control characters (0x00-0x1f), including ANSI/OSC terminal
    escape sequences, from a CSV cell value. Without this, a crafted
    user_email in an imported CSV could inject escape codes into the
    non-JSON terminal summary output.
    """
    return _CONTROL_CHAR_RE.sub("", value)


def _parse_csv(text: str) -> List[Dict[str, str]]:
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    if not lines:
        raise EmptyCSVError("<csv content>")

    header = [h.strip() for h in lines[0].split(",")]
    missing_columns = [col for col in EXPECTED_COLUMNS if col not in header]
    if missing_columns:
        raise CSVSchemaError(EXPECTED_COLUMNS)

    date_idx = header.index("date")
    email_idx = header.index("user_email")
    cost_idx = header.index("cost_usd")
    estimated_idx = header.index("is_estimated")

    rows: List[Dict[str, str]] = []
    for line in lines[1:]:
        cells = [_strip_control_chars(c.strip()) for c in line.split(",")]

        def cell(idx: int) -> str:
            return cells[idx] if idx < len(cells) else ""

        rows.append(
            {
                "date": cell(date_idx),
                "user_email": cell(email_idx),
                "cost_usd": cell(cost_idx),
                "is_estimated": cell(estimated_idx),
            }
        )
    return rows


def import_from_csv(csv_path: str, source: ToolId, window: DateWindow) -> AdapterResult:
    """
    Imports before-window spend from a CSV file for a tool whose admin API
    doesn't cover the requested window (e.g. Claude Code before 2026-01-01).
    """
    text = Path(csv_path).read_text(encoding="utf-8")
    if not text.strip():
        raise EmptyCSVError(csv_path)

    rows = _parse_csv(text)
    user_totals: Dict[str, UserUsage] = {}

    for index, row in enumerate(rows):
        row_number = index + 2  # +1 for header row, +1 for 1-based numbering
        if len(row["user_email"]) == 0:
            raise CSVRowError(row_number, "user_email is empty")

        try:
            cost = float(row["cost_usd"])
        except ValueError:
            raise CSVRowError(
                row_number, f'cost_usd "{row["cost_usd"]}" is not a valid number'
            )

        existing = user_totals.get(row["user_email"])
        is_estimated = row["is_estimated"].lower() == "true"

        if existing:
            existing.cost_usd += cost
            existing.is_estimated = existing.is_estimated or is_estimated
        else:
            user_totals[row["user_email"]] = UserUsage(
                user_id=row["user_email"],
                user_email=row["user_email"],
                input_tokens=None,
                output_tokens=None,
                cache_read_tokens=None,
                cache_write_tokens=None,
                requests=None,
                cost_usd=cost,
                is_estimated=is_estimated,
            )

    users_list = list(user_totals.values())
    return AdapterResult(
        source=source,
        window=window,
        total_cost_usd=sum_cost(users_list),
        is_estimated=any(u.is_estimated for u in users_list),
        users=users_list,
    )

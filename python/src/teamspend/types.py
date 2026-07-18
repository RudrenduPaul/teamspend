"""
Shared data types for teamspend's fetch/compare pipeline.

Ported from src/schema.ts. Field names follow Python (snake_case)
convention; the JSON report written by teamspend.output re-serializes to
the same camelCase keys the npm package's report file uses, so a report
produced by either distribution has the same on-disk shape even though the
in-process Python objects use snake_case attributes (same convention this
account's other Python ports, e.g. skillguard-cli, already use).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Literal, Optional

ToolId = Literal["cursor", "claude-code", "copilot"]
"""Tools teamspend can pull spend data from."""


@dataclass
class DateWindow:
    start: str
    """YYYY-MM-DD"""
    end: str
    """YYYY-MM-DD"""


@dataclass
class UserUsage:
    user_id: str
    user_email: Optional[str]
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    cache_read_tokens: Optional[int]
    cache_write_tokens: Optional[int]
    requests: Optional[int]
    cost_usd: float
    is_estimated: bool


@dataclass
class AdapterResult:
    """Normalized shape every adapter (and the CSV-import fallback) maps into."""

    source: ToolId
    window: DateWindow
    total_cost_usd: float
    is_estimated: bool
    users: List[UserUsage] = field(default_factory=list)


def sum_cost(users: List[UserUsage]) -> float:
    return sum(user.cost_usd for user in users)


def top_spenders(users: List[UserUsage], limit: int) -> List[UserUsage]:
    return sorted(users, key=lambda u: u.cost_usd, reverse=True)[:limit]

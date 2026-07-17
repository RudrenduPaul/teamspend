"""
Builds the before/after comparison report from two independently-resolved
adapter fetches.

Ported from src/compare.ts. Never treats a partial failure as a complete
comparison: if either side failed, delta is null and the failed side is
marked, not silently dropped from the report.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Literal, Optional

from .types import AdapterResult, ToolId, top_spenders

PeriodLabel = Literal["before", "after"]


@dataclass
class PeriodOutcome:
    label: PeriodLabel
    tool: ToolId
    result: Optional[AdapterResult]
    error: Optional[BaseException]


@dataclass
class TopSpenderEntry:
    period: PeriodLabel
    user_email: Optional[str]
    cost_usd: float


@dataclass
class ComparisonReport:
    before: PeriodOutcome
    after: PeriodOutcome
    delta_usd: Optional[float]
    delta_percent: Optional[float]
    top_spenders_across_both: List[TopSpenderEntry] = field(default_factory=list)


def build_comparison(before: PeriodOutcome, after: PeriodOutcome) -> ComparisonReport:
    before_cost = before.result.total_cost_usd if before.result else None
    after_cost = after.result.total_cost_usd if after.result else None

    delta_usd = (
        after_cost - before_cost
        if before_cost is not None and after_cost is not None
        else None
    )
    delta_percent = (
        (delta_usd / before_cost) * 100
        if delta_usd is not None and before_cost is not None and before_cost != 0
        else None
    )

    top_spenders_across_both: List[TopSpenderEntry] = []
    if before.result:
        for user in top_spenders(before.result.users, 5):
            top_spenders_across_both.append(
                TopSpenderEntry("before", user.user_email, user.cost_usd)
            )
    if after.result:
        for user in top_spenders(after.result.users, 5):
            top_spenders_across_both.append(
                TopSpenderEntry("after", user.user_email, user.cost_usd)
            )
    top_spenders_across_both.sort(key=lambda entry: entry.cost_usd, reverse=True)

    return ComparisonReport(
        before=before,
        after=after,
        delta_usd=delta_usd,
        delta_percent=delta_percent,
        top_spenders_across_both=top_spenders_across_both[:5],
    )

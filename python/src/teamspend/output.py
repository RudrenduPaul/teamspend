"""
Terminal summary rendering, JSON report writing, and .gitignore scaffolding.

Ported from src/output.ts. The JSON report re-serializes the snake_case
Python dataclasses into the same camelCase key shape the npm CLI's report
file uses, so a report from either distribution has the same on-disk shape.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from .adapters.csv_import import strip_control_chars
from .compare import ComparisonReport, PeriodOutcome

GITIGNORE_ENTRY = "teamspend-snapshot-*.json"


def scaffold_gitignore(cwd: str) -> bool:
    """
    Scaffolds a .gitignore entry for the report file in `cwd` if one doesn't
    already exist, and returns whether the first-run spend-sensitivity
    warning should be printed. The report contains per-user email + spend,
    which is quasi-sensitive data that shouldn't land in a repo by accident
    during a fast-moving migration.
    """
    gitignore_path = Path(cwd) / ".gitignore"
    already_present = False

    if gitignore_path.exists():
        contents = gitignore_path.read_text(encoding="utf-8")
        already_present = GITIGNORE_ENTRY in contents

    if not already_present:
        if gitignore_path.exists():
            with gitignore_path.open("a", encoding="utf-8") as handle:
                handle.write(f"\n{GITIGNORE_ENTRY}\n")
        else:
            gitignore_path.write_text(f"{GITIGNORE_ENTRY}\n", encoding="utf-8")
        return True

    return False


def _format_usd(amount: float) -> str:
    return f"${amount:.2f}"


def render_terminal_summary(report: ComparisonReport) -> str:
    lines = []
    lines.append("teamspend snapshot -- migration cost comparison")
    lines.append(f"Tools: {report.before.tool} -> {report.after.tool}")
    lines.append("")

    for outcome in (report.before, report.after):
        label = outcome.label.upper()
        lines.append(f"{label} ({outcome.tool})")
        if outcome.result:
            estimate_note = (
                "estimated" if outcome.result.is_estimated else "exact, usage-based"
            )
            lines.append(
                f"  Total spend:      {_format_usd(outcome.result.total_cost_usd)}"
                f"  ({estimate_note})"
            )
            lines.append(f"  Active users:      {len(outcome.result.users)}")
        else:
            message = str(outcome.error) if outcome.error else "unknown error"
            lines.append(f"  DATA UNAVAILABLE: {message}")
        lines.append("")

    if report.delta_usd is not None and report.delta_percent is not None:
        sign = "+" if report.delta_usd >= 0 else "-"
        lines.append(
            f"DELTA: {sign}{_format_usd(abs(report.delta_usd))} "
            f"({sign}{abs(report.delta_percent):.1f}%)"
        )
    else:
        lines.append(
            "DELTA: unavailable -- one or both periods failed to fetch, see above"
        )

    if report.top_spenders_across_both:
        lines.append("")
        lines.append("TOP SPENDERS (across both periods)")
        for i, spender in enumerate(report.top_spenders_across_both):
            # CSV-sourced emails are already stripped in csv_import.py; API-sourced
            # emails weren't, leaving an inconsistent path to this same unsanitized
            # terminal print -- strip here too so a compromised vendor response
            # can't inject terminal escape sequences via user_email either.
            email = strip_control_chars(spender.user_email) if spender.user_email else "(unknown)"
            lines.append(
                f"  {i + 1}. {email}     {spender.period}      {_format_usd(spender.cost_usd)}"
            )

    return "\n".join(lines)


def _outcome_to_dict(outcome: PeriodOutcome) -> Dict[str, Any]:
    return {
        "label": outcome.label,
        "tool": outcome.tool,
        "result": (
            {
                "source": outcome.result.source,
                "window": asdict(outcome.result.window),
                "totalCostUsd": outcome.result.total_cost_usd,
                "isEstimated": outcome.result.is_estimated,
                "users": [
                    {
                        "userId": u.user_id,
                        "userEmail": u.user_email,
                        "inputTokens": u.input_tokens,
                        "outputTokens": u.output_tokens,
                        "cacheReadTokens": u.cache_read_tokens,
                        "cacheWriteTokens": u.cache_write_tokens,
                        "requests": u.requests,
                        "costUsd": u.cost_usd,
                        "isEstimated": u.is_estimated,
                    }
                    for u in outcome.result.users
                ],
            }
            if outcome.result
            else None
        ),
        "error": {"message": str(outcome.error)} if outcome.error else None,
    }


def report_to_json_dict(report: ComparisonReport) -> Dict[str, Any]:
    return {
        "before": _outcome_to_dict(report.before),
        "after": _outcome_to_dict(report.after),
        "deltaUsd": report.delta_usd,
        "deltaPercent": report.delta_percent,
        "topSpendersAcrossBoth": [
            {
                "period": entry.period,
                "userEmail": entry.user_email,
                "costUsd": entry.cost_usd,
            }
            for entry in report.top_spenders_across_both
        ],
    }


def write_json_report(report: ComparisonReport, cwd: str) -> str:
    """
    Always writes the JSON report file, regardless of --json. --json only
    changes what prints to the terminal.
    """
    timestamp = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "")
    )
    safe_timestamp = timestamp.replace(":", "").replace(".", "")[:15]
    path = str(Path(cwd) / f"teamspend-snapshot-{safe_timestamp}.json")

    payload = json.dumps(report_to_json_dict(report), indent=2)

    # mode 0o600 restricts the file to owner read/write only. Without it,
    # the default (masked by the process umask, typically 0o644) leaves
    # per-user email + spend readable by any other local user on a shared
    # host. os.open with O_CREAT + explicit mode avoids the umask-then-chmod
    # race a separate os.chmod() call after write would have.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(payload)
    return path

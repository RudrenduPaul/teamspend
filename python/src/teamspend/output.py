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
from typing import Any, Dict, List, Optional

from .adapters.csv_import import strip_control_chars
from .compare import ComparisonReport, PeriodOutcome
from .types import BreakdownMode, top_sessions

GITIGNORE_ENTRY = "teamspend-snapshot-*.json"
# How many sessions the terminal breakdown table shows per period.
SESSION_BREAKDOWN_LIMIT = 10


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


def _push_session_breakdown(lines: List[str], outcome: PeriodOutcome) -> None:
    """
    Appends a per-session cost breakdown for one period's outcome, or (when
    --breakdown session was requested but this outcome's tool/adapter
    doesn't produce session-level data) a clear explanation of why not.
    Never silently shows nothing and never fabricates a breakdown for a
    tool whose real data has no session concept.
    """
    if not outcome.result:
        return  # DATA UNAVAILABLE already covers this case.

    all_sessions = [
        session
        for user in outcome.result.users
        for session in (user.sessions or [])
    ]
    any_user_supports_sessions = any(
        user.sessions is not None for user in outcome.result.users
    )

    if all_sessions:
        shown = min(SESSION_BREAKDOWN_LIMIT, len(all_sessions))
        lines.append(f"  SESSION BREAKDOWN (top {shown} by cost):")
        for i, session in enumerate(top_sessions(all_sessions, SESSION_BREAKDOWN_LIMIT)):
            estimate_tag = " (estimated)" if session.is_estimated else ""
            reqs = session.requests or 0
            plural = "" if reqs == 1 else "s"
            # session_id is local-log-sourced, same class of value as
            # user_email below -- strip control chars so a crafted log
            # entry can't inject terminal escape sequences via this print
            # path either.
            safe_session_id = strip_control_chars(session.session_id)
            lines.append(
                f"    {i + 1}. {safe_session_id}     "
                f"{_format_usd(session.cost_usd)}     {reqs} req{plural}{estimate_tag}"
            )
    elif any_user_supports_sessions:
        lines.append("  SESSION BREAKDOWN: no session activity in this window.")
    else:
        lines.append(
            f"  SESSION BREAKDOWN: not available for {outcome.tool} -- this tool's data "
            "source reports aggregate totals only, with no per-session/conversation "
            "breakdown in its response shape. Session-level cost breakdown is only "
            "available for claude-code-personal and opencode, which read local session "
            "logs directly."
        )
    lines.append("")


def render_terminal_summary(
    report: ComparisonReport, breakdown: Optional[BreakdownMode] = None
) -> str:
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

        if breakdown == "session":
            _push_session_breakdown(lines, outcome)

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


def _user_to_dict(u: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
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
    # Only present in the JSON report when the adapter actually produced
    # session data AND the caller requested it -- matches the TypeScript
    # port's stripSessionsUnlessRequested behavior in cli.py, which sets
    # u.sessions back to None on every user when --breakdown session
    # wasn't passed, so the default report shape is unchanged.
    if u.sessions is not None:
        payload["sessions"] = [
            {
                "sessionId": s.session_id,
                "costUsd": s.cost_usd,
                "inputTokens": s.input_tokens,
                "outputTokens": s.output_tokens,
                "requests": s.requests,
                "isEstimated": s.is_estimated,
            }
            for s in u.sessions
        ]
    return payload


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
                "users": [_user_to_dict(u) for u in outcome.result.users],
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

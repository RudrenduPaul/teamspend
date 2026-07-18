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

ToolId = Literal[
    "cursor",
    "claude-code",
    "copilot",
    "opencode",
    "claude-code-personal",
    "codex",
]
"""
Tools teamspend can pull spend data from. `claude-code-personal` is not a
separate vendor -- it's a credential-free local-file read mode for Claude
Code's own JSONL session logs, for someone who wants their personal usage
without org-admin API access (see
teamspend.adapters.claude_code_personal). `codex` (OpenAI's Codex CLI) is
the same shape as `opencode` -- no admin/team API, only local per-machine
session logs (see teamspend.adapters.codex).
"""


@dataclass
class DateWindow:
    start: str
    """YYYY-MM-DD"""
    end: str
    """YYYY-MM-DD"""


@dataclass
class SessionUsage:
    """
    Cost attributed to a single session/conversation -- a bounded unit of
    one interaction, and the most honest proxy teamspend can offer for
    "cost per task." This is NOT a measure of task success, quality, or
    ROI: no vendor exposes whether a session's output was actually good,
    so teamspend never claims to know that. It only ever reports what a
    session cost.

    Ported from src/schema.ts's SessionUsage interface.
    """

    session_id: str
    cost_usd: float
    input_tokens: Optional[int]
    output_tokens: Optional[int]
    requests: Optional[int]
    is_estimated: bool


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
    # Per-session (per-conversation) cost breakdown, populated only by
    # adapters whose underlying data source actually exposes a session
    # identifier -- local-log-based adapters (claude_code_personal,
    # opencode), which parse a real sessionId/sessionID out of each log
    # entry. Admin-API-based adapters (cursor, claude_code, copilot) report
    # aggregate per-user totals only, with no session concept anywhere in
    # their response shape, so they leave this field None rather than
    # fabricating session boundaries that don't exist. None by default so
    # every adapter that predates this field keeps working unchanged.
    sessions: Optional[List[SessionUsage]] = None


@dataclass
class AdapterResult:
    """Normalized shape every adapter (and the CSV-import fallback) maps into."""

    source: ToolId
    window: DateWindow
    total_cost_usd: float
    is_estimated: bool
    users: List[UserUsage] = field(default_factory=list)


BreakdownMode = Literal["session"]
"""Supported values for the CLI's `--breakdown` flag."""


def sum_cost(users: List[UserUsage]) -> float:
    return sum(user.cost_usd for user in users)


def top_spenders(users: List[UserUsage], limit: int) -> List[UserUsage]:
    return sorted(users, key=lambda u: u.cost_usd, reverse=True)[:limit]


def top_sessions(sessions: List[SessionUsage], limit: int) -> List[SessionUsage]:
    return sorted(sessions, key=lambda s: s.cost_usd, reverse=True)[:limit]

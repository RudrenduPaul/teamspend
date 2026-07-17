"""
Claude Code (Anthropic Claude Enterprise Analytics API) adapter.

Ported from src/adapters/claude-code.ts.
"""
from __future__ import annotations

from typing import Any, Dict

from ..errors import DataUnavailableError
from ..http_client import fetch_with_retry, require_field
from ..types import AdapterResult, DateWindow, UserUsage, sum_cost

TOOL = "claude-code"
ANALYTICS_API_START_DATE = "2026-01-01"
"""Anthropic's Claude Enterprise Analytics API has no data before this date."""


def _normalize_user(raw: Dict[str, Any]) -> UserUsage:
    input_tokens = require_field(raw, "input_tokens", TOOL)
    output_tokens = require_field(raw, "output_tokens", TOOL)
    cost_usd = require_field(raw, "spend_usd", TOOL)

    # Claude.ai Team/Enterprise seats don't expose true per-user cost via the
    # Admin API -- it reports a technically-valid but structurally
    # uninformative spend_usd: 0 for a user who clearly has real token
    # activity. Flag that specific combination as estimated rather than
    # presenting a misleading exact-looking $0 (no requests field exists on
    # this vendor's payload, so the check is token-only).
    is_suspicious_zero = cost_usd == 0 and (input_tokens > 0 or output_tokens > 0)

    return UserUsage(
        user_id=require_field(raw, "user_id", TOOL),
        user_email=require_field(raw, "email", TOOL),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=require_field(raw, "cache_read_tokens", TOOL),
        cache_write_tokens=require_field(raw, "cache_write_tokens", TOOL),
        requests=None,
        cost_usd=cost_usd,
        is_estimated=is_suspicious_zero,
    )


def fetch_claude_code_spend(
    window: DateWindow, api_key: str, **fetch_kwargs: Any
) -> AdapterResult:
    """
    Fetches Claude Code spend via Anthropic's Analytics/Admin API. If the
    window's start predates 2026-01-01 (the Analytics API's hard start date,
    not a rolling window), raises DataUnavailableError rather than silently
    returning an incomplete or zeroed result. The caller falls back to the
    CSV-import path for that portion of the window.
    """
    if window.start < ANALYTICS_API_START_DATE:
        raise DataUnavailableError(
            TOOL,
            f"requested window starts {window.start}, before the Analytics "
            f"API's {ANALYTICS_API_START_DATE} start date",
        )

    auth_header = {"x-api-key": api_key}
    url = (
        "https://api.anthropic.com/v1/organizations/usage_report/claude_code"
        f"?start={window.start}&end={window.end}"
    )
    raw = fetch_with_retry(TOOL, url, auth_header, **fetch_kwargs)
    raw_users = require_field(raw, "users", TOOL)

    users = [_normalize_user(u) for u in raw_users]
    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users),
        is_estimated=any(u.is_estimated for u in users),
        users=users,
    )

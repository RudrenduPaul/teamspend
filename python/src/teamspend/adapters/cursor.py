"""
Cursor Admin API adapter.

Ported from src/adapters/cursor.ts. Paginates across the API's 30-day
per-call cap and sums the result. If any chunk fails after retries are
exhausted, the ENTIRE call fails -- never silently sums only the chunks
that succeeded, which would under-report spend without any indication the
number is incomplete.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List

from ..http_client import fetch_with_retry, require_field
from ..types import AdapterResult, DateWindow, UserUsage, sum_cost

CURSOR_MAX_WINDOW_DAYS = 30
TOOL = "cursor"


def _split_into_chunks(window: DateWindow) -> List[DateWindow]:
    start = date.fromisoformat(window.start)
    end = date.fromisoformat(window.end)
    chunks: List[DateWindow] = []
    chunk_start = start

    while chunk_start <= end:
        chunk_end = chunk_start + timedelta(days=CURSOR_MAX_WINDOW_DAYS - 1)
        clamped_end = min(chunk_end, end)
        chunks.append(
            DateWindow(start=chunk_start.isoformat(), end=clamped_end.isoformat())
        )
        chunk_start = clamped_end + timedelta(days=1)

    return chunks


def _normalize_user(raw: Dict[str, Any]) -> UserUsage:
    input_tokens = require_field(raw, "input_tokens", TOOL)
    output_tokens = require_field(raw, "output_tokens", TOOL)
    requests = require_field(raw, "requests", TOOL)
    cost_usd = require_field(raw, "cost_usd", TOOL)

    # Cursor plans without usage overage don't expose true per-user cost via
    # the Admin API -- it reports a technically-valid but structurally
    # uninformative cost_usd: 0 for a user who clearly has real activity.
    # Flag that specific combination as estimated rather than presenting a
    # misleading exact-looking $0.
    is_suspicious_zero = cost_usd == 0 and (
        input_tokens > 0 or output_tokens > 0 or requests > 0
    )

    return UserUsage(
        user_id=require_field(raw, "user_id", TOOL),
        user_email=raw.get("email"),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=require_field(raw, "cache_read_tokens", TOOL),
        cache_write_tokens=require_field(raw, "cache_write_tokens", TOOL),
        requests=requests,
        cost_usd=cost_usd,
        is_estimated=is_suspicious_zero,
    )


def fetch_cursor_spend(window: DateWindow, api_key: str, **fetch_kwargs: Any) -> AdapterResult:
    """
    Fetches Cursor Admin API spend for the given window, paginating across
    30-day chunks (the API's per-call cap) and summing the result.

    `fetch_kwargs` forwards to http_client.fetch_with_retry (e.g. `transport`
    and `sleep` for tests) -- never used by real callers.
    """
    chunks = _split_into_chunks(window)
    auth_header = {"Authorization": f"Bearer {api_key}"}

    user_totals: Dict[str, UserUsage] = {}

    for chunk in chunks:
        url = f"https://api.cursor.com/admin/usage?start={chunk.start}&end={chunk.end}"
        raw = fetch_with_retry(TOOL, url, auth_header, **fetch_kwargs)
        users = require_field(raw, "users", TOOL)

        for raw_user in users:
            normalized = _normalize_user(raw_user)
            existing = user_totals.get(normalized.user_id)
            if existing:
                existing.input_tokens = (existing.input_tokens or 0) + (
                    normalized.input_tokens or 0
                )
                existing.output_tokens = (existing.output_tokens or 0) + (
                    normalized.output_tokens or 0
                )
                existing.cache_read_tokens = (existing.cache_read_tokens or 0) + (
                    normalized.cache_read_tokens or 0
                )
                existing.cache_write_tokens = (existing.cache_write_tokens or 0) + (
                    normalized.cache_write_tokens or 0
                )
                existing.requests = (existing.requests or 0) + (normalized.requests or 0)
                existing.cost_usd += normalized.cost_usd
                existing.is_estimated = existing.is_estimated or normalized.is_estimated
            else:
                user_totals[normalized.user_id] = normalized

    users_list = list(user_totals.values())
    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users_list),
        is_estimated=any(u.is_estimated for u in users_list),
        users=users_list,
    )

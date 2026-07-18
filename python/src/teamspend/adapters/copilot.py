"""
GitHub Copilot usage metrics adapter.

Ported from src/adapters/copilot.ts. See that file's module docstring for
the full research writeup; summarized here:

- The endpoint this adapter calls, GET /orgs/{org}/copilot/metrics/reports/
  users-1-day, is the CURRENT (non-deprecated) Copilot usage metrics API.
  The older /orgs/{org}/copilot/metrics endpoint, which returned inline
  org-aggregate JSON, was sunset by GitHub on 2026-04-02 and no longer
  exists.
- That real API has no arbitrary start/end range parameter -- only
  single-day (`users-1-day?day=YYYY-MM-DD`) or latest-rolling-28-day
  (`users-28-day/latest`) granularity. This adapter requests one report per
  calendar day in the window and sums per-user totals across days, the
  Python mirror of fetch_cursor_spend's 30-day-chunk-and-sum pattern.
- Each report call returns `{download_links, report_day}`, not data inline.
  download_links are short-lived, pre-signed GitHub-owned URLs pointing to
  NDJSON (newline-delimited JSON) files -- this adapter fetches and parses
  each one.
- GitHub's Copilot metrics API has NO cost/spend field at all (unlike
  Cursor/Claude Code, which do report a native cost figure). The only real,
  vendor-reported, per-user number is `ai_credits_used`, which this adapter
  converts to USD at GitHub's own published, fixed $0.01/credit rate --
  never fabricated. An optional `seat_price_usd` adds a flat per-seat
  monthly price once per user (never per day), since GitHub does not expose
  an org's actual negotiated seat price via any API -- the same structural
  gap Cursor's and Claude Code's flat-seat plans have.
- `is_estimated` is unconditionally True for every Copilot result: every
  dollar figure produced here is derived, never vendor-reported.
"""
from __future__ import annotations

import json as json_module
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from ..errors import AuthenticationError, DataUnavailableError, InvalidCliArgError
from ..http_client import fetch_with_retry, require_field
from ..types import AdapterResult, DateWindow, UserUsage, sum_cost

TOOL = "copilot"
COPILOT_API_VERSION = "2026-03-10"

COPILOT_METRICS_START_DATE = "2025-10-10"
"""GitHub's Copilot usage metrics reports have no data before this date."""

COPILOT_CREDIT_USD_RATE = 0.01
"""
GitHub's own published, fixed conversion rate from an AI credit to USD --
not a negotiated or per-org price. Source: GitHub Blog, "GitHub Copilot is
moving to usage-based billing" (2026) -- "1 AI credit = $0.01 USD".
"""


def _split_into_days(window: DateWindow) -> List[str]:
    start = date.fromisoformat(window.start)
    end = date.fromisoformat(window.end)
    days: List[str] = []
    cursor = start
    while cursor <= end:
        days.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return days


def _normalize_user(raw: Dict[str, Any]) -> UserUsage:
    user_login = require_field(raw, "user_login", TOOL)
    ai_credits_used = require_field(raw, "ai_credits_used", TOOL)
    interaction_count = require_field(raw, "user_initiated_interaction_count", TOOL)

    return UserUsage(
        user_id=user_login,
        # GitHub identifies Copilot users by user_id/user_login (a GitHub
        # username), never an email address -- unlike Cursor and Claude Code.
        user_email=None,
        # Copilot's metrics reports carry no token counts at all.
        input_tokens=None,
        output_tokens=None,
        cache_read_tokens=None,
        cache_write_tokens=None,
        requests=interaction_count,
        cost_usd=ai_credits_used * COPILOT_CREDIT_USD_RATE,
        is_estimated=True,
    )


def _parse_ndjson(text: str) -> List[Dict[str, Any]]:
    return [
        json_module.loads(line)
        for line in text.split("\n")
        if line.strip()
    ]


def fetch_copilot_spend(
    window: DateWindow,
    api_key: str,
    org: str,
    seat_price_usd: Optional[float] = None,
    **fetch_kwargs: Any,
) -> AdapterResult:
    """
    Fetches GitHub Copilot org usage for the given window and converts it to
    a dollar figure. See this module's docstring for the full API research
    writeup.

    `fetch_kwargs` forwards to http_client.fetch_with_retry (e.g.
    `transport` and `sleep` for tests) -- never used by real callers.
    """
    if seat_price_usd is not None and not (seat_price_usd >= 0):
        raise InvalidCliArgError(
            f"copilot seat price must be a non-negative number, got {seat_price_usd}"
        )

    if window.start < COPILOT_METRICS_START_DATE:
        raise DataUnavailableError(
            TOOL,
            f"requested window starts {window.start}, before Copilot usage "
            f"metrics reports' {COPILOT_METRICS_START_DATE} start date",
        )

    auth_header = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
    }

    user_totals: Dict[str, UserUsage] = {}

    for day in _split_into_days(window):
        url = (
            f"https://api.github.com/orgs/{quote(org, safe='')}"
            f"/copilot/metrics/reports/users-1-day?day={day}"
        )
        report = fetch_with_retry(
            TOOL, url, auth_header, empty_on=(404,), **fetch_kwargs
        )

        # 404 means "no report for this day" -- treated as zero users for
        # that day, not a failure, the same way Cursor's adapter treats a
        # 200 {"users": []} response.
        if report is None:
            continue

        download_links = require_field(report, "download_links", TOOL)

        for link in download_links:
            try:
                # Download links are short-lived, pre-signed GitHub-owned
                # URLs -- they don't need (and can reject) the org's
                # TEAMSPEND_COPILOT_TOKEN.
                ndjson_text = fetch_with_retry(
                    TOOL,
                    link,
                    {},
                    response_type="text",
                    **fetch_kwargs,
                )
            except AuthenticationError as error:
                raise RuntimeError(
                    f"{TOOL}: report download link for {day} was rejected "
                    f"(expired signed URL?) -- retry the command (org={org})"
                ) from error

            for raw_user in _parse_ndjson(ndjson_text):
                normalized = _normalize_user(raw_user)
                existing = user_totals.get(normalized.user_id)
                if existing:
                    existing.requests = (existing.requests or 0) + (
                        normalized.requests or 0
                    )
                    existing.cost_usd += normalized.cost_usd
                else:
                    user_totals[normalized.user_id] = normalized

    if seat_price_usd:
        for user in user_totals.values():
            user.cost_usd += seat_price_usd

    users_list = list(user_totals.values())
    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users_list),
        is_estimated=True,
        users=users_list,
    )

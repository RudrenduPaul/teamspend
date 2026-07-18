"""
Codex CLI local-file adapter.

Ported from src/adapters/codex.ts.

Codex CLI (github.com/openai/codex, OpenAI's coding agent CLI) has no
admin/team/billing API -- it is a local CLI with its own local session
logs, the same shape as claude_code_personal.py and opencode.py. Verified
directly against openai/codex's own Rust source (not a third-party guess):

- `codex-rs/utils/home-dir/src/lib.rs::find_codex_home` -- resolves via the
  `CODEX_HOME` env var, defaulting to `~/.codex` if unset. Unlike Claude
  Code's `CLAUDE_CONFIG_DIR`, this is a single path, never a
  comma-separated list.
- `codex-rs/rollout/src/lib.rs` -- `SESSIONS_SUBDIR = "sessions"` and
  `ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"`, both scanned below.
- `codex-rs/rollout/src/list.rs` (doc comment) -- on-disk layout is
  `<codex_home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
- `codex-rs/protocol/src/protocol.rs::TokenUsage` / `TokenUsageInfo` -- the
  exact per-turn usage record shape read below (`input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`, `total_tokens`, wrapped in
  `{ total_token_usage, last_token_usage }`).
- `codex-rs/codex-api/src/sse/responses.rs` -- confirms `input_tokens` in
  that struct is copied straight from OpenAI's Responses API
  `usage.input_tokens`, which already *includes* `cached_tokens` as a
  subset (its own test fixture: `input_tokens: 100`, `cached_tokens: 40`),
  not an additional amount.

Cross-checked against ccusage's own Codex guide
(ccusage.com/guide/codex/) and mrexodia/agent-cost-dashboard's
`cost_dashboard.py` (`analyze_codex_jsonl_file`), which parse the
identical record shapes independently -- both agree with the Rust source
on every field name.

**Cold-storage limitation**: `codex-rs/rollout/src/compression.rs`
background-compresses any rollout file older than 7 days
(`MIN_ROLLOUT_AGE`) from `rollout-*.jsonl` to `rollout-*.jsonl.zst`
(zstd). This adapter only reads plain `.jsonl` files -- the same tradeoff
opencode.py already made for OpenCode's newer SQLite store: this package
adds no dependency for a secondary on-disk format. A requested window
reaching back more than ~7 days will under-report or come back empty for
Codex; use the CSV-import fallback to cover that period.
"""
from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..errors import DataUnavailableError
from ..types import AdapterResult, DateWindow, UserUsage, sum_cost

TOOL = "codex"
CODEX_HOME_ENV = "CODEX_HOME"
SESSIONS_SUBDIR = "sessions"
ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"


def resolve_codex_sessions_dirs(
    env: Optional[Dict[str, str]] = None,
) -> List[str]:
    """
    Resolves the directories to scan for local Codex CLI session logs:
    `<CODEX_HOME>/sessions` and `<CODEX_HOME>/archived_sessions`, where
    `CODEX_HOME` defaults to `~/.codex` (see module docstring for the
    source citation). Falls back to `HOME`/`USERPROFILE` off the same
    `env` dict (rather than `Path.home()` directly) so tests can inject a
    fake home directory the same way `resolve_opencode_data_dirs` does.
    """
    if env is None:
        env = dict(os.environ)

    override = env.get(CODEX_HOME_ENV, "").strip()
    if override:
        return [
            str(Path(override, SESSIONS_SUBDIR)),
            str(Path(override, ARCHIVED_SESSIONS_SUBDIR)),
        ]

    home = env.get("HOME") or env.get("USERPROFILE")
    codex_home = Path(home, ".codex") if home else Path.home() / ".codex"
    return [
        str(codex_home / SESSIONS_SUBDIR),
        str(codex_home / ARCHIVED_SESSIONS_SUBDIR),
    ]


def _collect_jsonl_files(directory: str) -> List[Path]:
    """
    Recursively collects every plain `*.jsonl` rollout file under
    `directory` (the real layout nests them `YYYY/MM/DD/rollout-*.jsonl`,
    but this walks arbitrarily deep rather than hardcoding that depth).
    `*.jsonl.zst` (compressed, cold) siblings are deliberately skipped --
    see the module docstring. A missing/unreadable directory yields an
    empty list rather than raising.
    """
    root = Path(directory)
    if not root.is_dir():
        return []
    try:
        return sorted(root.rglob("*.jsonl"))
    except OSError:
        return []


def _within_window(timestamp: str, window: DateWindow) -> bool:
    date = timestamp[:10]
    return window.start <= date <= window.end


def _resolve_local_user_id() -> str:
    """
    Best-effort local identity for the single user this mode reports on --
    same rationale and fallback as claude_code_personal.py/opencode.py: no
    admin API here means no vendor-supplied user_id/email to fall back on.
    """
    try:
        username = getpass.getuser()
        if username and username.strip():
            return username
    except (OSError, KeyError):
        pass
    return "local-user"


def fetch_codex_usage(
    window: DateWindow, sessions_dirs: Optional[List[str]] = None
) -> AdapterResult:
    """
    Reads Codex CLI's own local JSONL rollout logs and reports the single
    local user's token usage for `window` -- no admin API, no network
    call, no credential.

    Codex's `event_msg` records with `payload.type == "token_count"` carry
    per-turn token counts but, unlike Cursor/Claude Code's admin APIs,
    **no cost field at all** -- not even a `cost: 0` placeholder the way
    OpenCode's message files have. teamspend bundles no per-token pricing
    table of its own (the same call opencode.py already made, for the
    same reason: a bundled table drifts from real vendor prices and is
    exactly the kind of guessed data this package avoids). `cost_usd` is
    therefore always `0` and the result is always `is_estimated: True`
    when any usage is found -- token counts are exact, dollars are simply
    not reported by Codex at all.

    `last_token_usage` on each `token_count` event is already the per-turn
    delta (Codex's own `TokenUsageInfo::append_last_usage` sets it
    verbatim per turn, distinct from the cumulative `total_token_usage`),
    so this reads it directly rather than diffing consecutive cumulative
    totals. Sessions old enough for `last_token_usage` to be entirely
    absent predate the current schema and, per the cold-storage limitation
    above, will already have been compressed to `.jsonl.zst` and skipped
    -- such lines are simply skipped here too rather than deriving a delta
    from `total_token_usage`.

    Codex emits each `token_count` event twice in a row with
    byte-identical `info` -- confirmed independently by
    mrexodia/agent-cost-dashboard's own parser, which carries the same
    dedup -- so a repeated `info` blob (matched by structural equality) is
    skipped rather than double-counted.

    `input_tokens` in Codex's schema already includes `cached_input_tokens`
    as a subset (see module docstring), so this stores the net, uncached
    portion as `input_tokens` to avoid double-counting input and
    cache-read tokens the way `cache_read_tokens` already accounts for the
    cached portion.
    """
    if sessions_dirs is None:
        sessions_dirs = resolve_codex_sessions_dirs()

    jsonl_files: List[Path] = []
    for directory in sessions_dirs:
        jsonl_files.extend(_collect_jsonl_files(directory))

    if not jsonl_files:
        checked = ", ".join(sessions_dirs)
        raise DataUnavailableError(
            TOOL,
            f"no Codex CLI session logs (*.jsonl) found under {checked} -- "
            "codex has no admin/team API, only local per-machine rollout "
            "logs (set CODEX_HOME to override)",
        )

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    requests = 0

    for file_path in jsonl_files:
        text = file_path.read_text(encoding="utf-8")
        previous_signature: Optional[str] = None

        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue

            try:
                record: Dict[str, Any] = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                # Skip a corrupted/partial line rather than failing the
                # whole read -- a rollout file can end mid-write if Codex
                # crashes or is killed mid-turn.
                continue

            payload = record.get("payload") or {}
            if record.get("type") != "event_msg" or payload.get("type") != "token_count":
                continue

            info = payload.get("info")
            if not info:
                continue

            signature = json.dumps(info, sort_keys=True)
            if signature == previous_signature:
                # Codex fires each token_count event twice in a row with
                # identical usage -- see module docstring.
                continue
            previous_signature = signature

            usage = info.get("last_token_usage")
            if not usage:
                continue

            timestamp = record.get("timestamp")
            if not timestamp or not _within_window(timestamp, window):
                continue

            raw_input = usage.get("input_tokens") or 0
            cached_input = usage.get("cached_input_tokens") or 0
            input_tokens += max(0, raw_input - cached_input)
            cache_read_tokens += cached_input
            cache_write_tokens += usage.get("cache_write_input_tokens") or 0
            output_tokens += usage.get("output_tokens") or 0
            requests += 1

    if requests == 0:
        return AdapterResult(
            source=TOOL, window=window, total_cost_usd=0, is_estimated=False, users=[]
        )

    users = [
        UserUsage(
            user_id=_resolve_local_user_id(),
            user_email=None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            requests=requests,
            cost_usd=0,
            is_estimated=True,
        )
    ]

    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users),
        is_estimated=True,
        users=users,
    )

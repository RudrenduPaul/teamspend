"""
Claude Code personal-usage adapter -- reads Claude Code's own local JSONL
session logs directly, no admin API, no network call, no credential.

Ported from src/adapters/claude-code-personal.ts. For someone who just
wants their own personal Claude Code spend/usage without org-admin access
to the Cursor Admin API or Anthropic's Claude Enterprise Analytics API that
every other adapter in this package requires.
"""
from __future__ import annotations

import getpass
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..errors import DataUnavailableError
from ..types import AdapterResult, DateWindow, UserUsage, sum_cost

TOOL = "claude-code-personal"


def _path_exists(candidate: Path) -> bool:
    try:
        return candidate.exists()
    except OSError:
        return False


def resolve_projects_dirs() -> List[Path]:
    """
    Resolves the directory (or directories) to scan for Claude Code session
    logs, in the same order Claude Code itself resolves its config dir:

    1. `CLAUDE_CONFIG_DIR` (comma-separated list -- every entry is scanned,
       not just the first). Each entry may either already point at a
       `projects/` directory or be the parent config dir that contains one.
    2. Else, the XDG-style location (`$XDG_CONFIG_HOME/claude/projects`,
       defaulting `XDG_CONFIG_HOME` itself to `~/.config` per the XDG spec)
       IF that directory exists.
    3. Else, the legacy default: `~/.claude/projects`.

    Only one of (2)/(3) is ever returned -- they're alternatives, not both
    scanned -- while (1) can return several directories at once.
    """
    override = os.environ.get("CLAUDE_CONFIG_DIR")
    if override and override.strip():
        dirs = []
        for entry in override.split(","):
            entry = entry.strip()
            if not entry:
                continue
            entry_path = Path(entry)
            dirs.append(
                entry_path
                if entry_path.name == "projects"
                else entry_path / "projects"
            )
        return dirs

    xdg_base_raw = os.environ.get("XDG_CONFIG_HOME", "").strip()
    xdg_base = Path(xdg_base_raw) if xdg_base_raw else Path.home() / ".config"
    xdg_projects_dir = xdg_base / "claude" / "projects"
    if _path_exists(xdg_projects_dir):
        return [xdg_projects_dir]

    return [Path.home() / ".claude" / "projects"]


def _collect_jsonl_files(directory: Path) -> List[Path]:
    """
    Recursively collects every `*.jsonl` file under `directory`, including
    nested `subagents/` subdirectories. A missing/unreadable directory
    yields an empty list rather than raising -- the caller decides what "no
    files anywhere" means (DataUnavailableError), not this low-level walker.
    """
    if not _path_exists(directory):
        return []
    try:
        return sorted(directory.rglob("*.jsonl"))
    except OSError:
        return []


def _within_window(timestamp: str, window: DateWindow) -> bool:
    date = timestamp[:10]
    return window.start <= date <= window.end


def _resolve_local_user_id() -> str:
    """
    Best-effort local identity for the single user this mode reports on.
    There is no admin API here, so there is no vendor-supplied user_id/email
    to fall back on (unlike cursor.py/claude_code.py) -- the OS login name
    is the closest reliable local signal, matching csv_import.py's
    precedent of using whatever identity is directly at hand rather than
    guessing. Falls back to a fixed placeholder if the OS refuses to answer
    (some minimal containers have no passwd entry for the running uid).
    """
    try:
        username = getpass.getuser()
        if username and username.strip():
            return username
    except (OSError, KeyError):
        pass
    return "local-user"


def fetch_claude_code_personal_usage(window: DateWindow) -> AdapterResult:
    """
    Reads Claude Code's own local JSONL session logs and reports the single
    local user's usage for `window` -- no admin API, no network call, no
    credential.

    Entries are deduped by the (message.id, requestId) pair before summing,
    since retried requests can appear more than once in the logs. `costUSD`
    is trusted when present on a line; when it's absent, that line still
    contributes its token counts but NOT a dollar amount, and the whole
    result is flagged `is_estimated` -- matching this codebase's existing
    "never present a guess as an exact number" rule (see
    claude_code.py/cursor.py's suspicious-zero handling for the same
    philosophy).
    """
    projects_dirs = resolve_projects_dirs()

    jsonl_files: List[Path] = []
    for directory in projects_dirs:
        jsonl_files.extend(_collect_jsonl_files(directory))

    if not jsonl_files:
        checked = ", ".join(str(d) for d in projects_dirs)
        raise DataUnavailableError(
            TOOL,
            f"no Claude Code session logs (*.jsonl) found under {checked} "
            "(checked recursively, including subagents/ subdirectories)",
        )

    seen_keys = set()
    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    requests = 0
    cost_usd = 0.0
    is_estimated = False

    for file_path in jsonl_files:
        text = file_path.read_text(encoding="utf-8")
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue

            try:
                entry: Dict[str, Any] = json.loads(line)
            except (json.JSONDecodeError, ValueError):
                # Skip a corrupted/partial line rather than failing the
                # whole read -- Claude Code's own logs can end mid-write if
                # a session crashes.
                continue

            timestamp = entry.get("timestamp")
            if not timestamp or not _within_window(timestamp, window):
                continue

            message = entry.get("message") or {}
            message_id: Optional[str] = message.get("id")
            request_id: Optional[str] = entry.get("requestId")
            if message_id or request_id:
                dedupe_key = f"{message_id or ''}::{request_id or ''}"
                if dedupe_key in seen_keys:
                    continue
                seen_keys.add(dedupe_key)

            usage = message.get("usage") or {}
            input_tokens += usage.get("input_tokens") or 0
            output_tokens += usage.get("output_tokens") or 0
            cache_read_tokens += usage.get("cache_read_input_tokens") or 0
            cache_write_tokens += usage.get("cache_creation_input_tokens") or 0
            requests += 1

            cost = entry.get("costUSD")
            if isinstance(cost, (int, float)) and not isinstance(cost, bool):
                cost_usd += cost
            else:
                is_estimated = True

    user = UserUsage(
        user_id=_resolve_local_user_id(),
        user_email=None,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cache_read_tokens=cache_read_tokens,
        cache_write_tokens=cache_write_tokens,
        requests=requests,
        cost_usd=cost_usd,
        is_estimated=is_estimated,
    )

    users = [user]
    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users),
        is_estimated=any(u.is_estimated for u in users),
        users=users,
    )

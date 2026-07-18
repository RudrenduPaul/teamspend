"""
OpenCode local-file adapter.

Ported from src/adapters/opencode.ts.

OpenCode (github.com/anomalyco/opencode, formerly sst/opencode -- the GitHub
org renamed and the old slug now redirects) has no admin/team/billing API at
all -- confirmed against its own README, which describes only a local CLI
with no organization-level usage endpoint. Every session/message is written
to local JSON files under
`$OPENCODE_DATA_DIR/storage/message/{sessionID}/msg_{messageID}.json`
(default data dir: `~/.local/share/opencode`, including on Windows --
OpenCode follows the XDG layout on every platform). Verified two ways:
ccusage's own OpenCode data-source guide (ccusage.com/guide/opencode/,
already this codebase's cited prior art for adapter quirks) documents this
exact path and the `OPENCODE_DATA_DIR` override; tokscale's README
(github.com/junhoyeo/tokscale) independently lists the same
`~/.local/share/opencode/storage/message/` path as its "legacy/unmigrated"
fallback alongside a newer SQLite `opencode.db` (v1.2+) that tokscale also
reads but this adapter does not -- this package has zero runtime
dependencies by design, and a SQLite reader isn't worth adding against that
constraint, so only the plain-JSON message-file format is supported for now.

The per-message field shapes handled here (tokens.input/output/reasoning,
tokens.cache.read/write, cost, modelID, providerID) are taken verbatim from
OpenCode's own generated SDK types
(packages/sdk/js/src/gen/types.gen.ts, dev branch, AssistantMessage).
"""
from __future__ import annotations

import getpass
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..errors import DataUnavailableError
from ..types import AdapterResult, DateWindow, SessionUsage, UserUsage, sum_cost

TOOL = "opencode"
OPENCODE_DATA_DIR_ENV = "OPENCODE_DATA_DIR"


def resolve_opencode_data_dirs(env: Optional[Dict[str, str]] = None) -> List[str]:
    """
    Resolves the directories to scan for local OpenCode message logs.
    `OPENCODE_DATA_DIR` may name a single directory or a comma-separated
    list (ccusage's own adapter supports the same override, for the same
    reason: OpenCode can be pointed at more than one data root). Falls back
    to the documented default, `~/.local/share/opencode` -- including on
    Windows, where OpenCode still uses the XDG-style relative path under
    `%USERPROFILE%`.
    """
    if env is None:
        env = dict(os.environ)

    env_value = env.get(OPENCODE_DATA_DIR_ENV)
    if env_value and env_value.strip():
        return [d.strip() for d in env_value.split(",") if d.strip()]

    home = env.get("HOME") or env.get("USERPROFILE")
    if not home:
        return []
    return [str(Path(home, ".local", "share", "opencode"))]


def _window_bounds_ms(window: DateWindow) -> "tuple[int, int]":
    start = datetime.fromisoformat(f"{window.start}T00:00:00.000+00:00")
    end = datetime.fromisoformat(f"{window.end}T23:59:59.999+00:00")
    return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


def _list_message_files(data_dir: str) -> List[Path]:
    """
    Lists every message JSON file under each session subdirectory of
    `<data_dir>/storage/message/`. Missing directories (data dir doesn't
    exist, or a session subdirectory disappeared mid-scan) resolve to an
    empty list rather than raising -- this is local disk state being read
    opportunistically, not a versioned API contract, and a half-written or
    already-cleaned-up session shouldn't fail the whole scan.
    """
    message_dir = Path(data_dir, "storage", "message")
    if not message_dir.is_dir():
        return []

    files: List[Path] = []
    for session_dir in sorted(message_dir.iterdir()):
        if not session_dir.is_dir():
            continue
        for entry in sorted(session_dir.iterdir()):
            if entry.is_file() and entry.suffix == ".json":
                files.append(entry)
    return files


def fetch_opencode_spend(
    window: DateWindow, data_dirs: Optional[List[str]] = None
) -> AdapterResult:
    """
    Fetches local OpenCode spend for the given window by scanning message
    JSON files directly on disk -- there is no admin API to call. Unlike the
    Cursor/Claude Code adapters, this can only ever see the current
    machine's own local usage: OpenCode's message files carry no user/email
    field at all (confirmed against its own SDK types -- it's a
    single-developer local tool with no team concept), so every message
    found is attributed to one synthetic user: the OS account running
    `teamspend`. Rolling up spend across a real team means running
    `teamspend` on each person's machine (or collecting their numbers out of
    band and using the CSV-import fallback).

    Raises DataUnavailableError when no local message store is found at all
    (missing data dir, or a data dir with no `storage/message` files), so
    the CSV-import fallback engages the same way it does for a tool whose
    live API can't cover part of the window. A data dir that exists but has
    no messages *inside the requested window* is a different, legitimate
    case (an inactive period) and returns a normal empty-users result
    instead.
    """
    if data_dirs is None:
        data_dirs = resolve_opencode_data_dirs()

    all_files: List[Path] = []
    for data_dir in data_dirs:
        all_files.extend(_list_message_files(data_dir))

    if not all_files:
        resolved = ", ".join(data_dirs) if data_dirs else (
            "(no data directory resolved -- set OPENCODE_DATA_DIR or $HOME)"
        )
        raise DataUnavailableError(
            TOOL,
            f"no local OpenCode message logs found under {resolved} -- "
            "opencode has no admin/team API, only local per-machine session logs",
        )

    start_ms, end_ms = _window_bounds_ms(window)

    input_tokens = 0
    output_tokens = 0
    cache_read_tokens = 0
    cache_write_tokens = 0
    requests = 0
    cost_usd = 0.0
    # Per-session totals, keyed by each message's own sessionID (the same
    # sessionID that names its parent storage/message/{sessionID}/
    # directory). A message with no sessionID still contributes to the flat
    # totals above, just not to this dict.
    session_totals: Dict[str, Dict[str, Any]] = {}

    for file_path in all_files:
        try:
            raw: Dict[str, Any] = json.loads(file_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # Corrupt or partially-written file (e.g. opencode was mid-write
            # when this ran) -- skip it rather than failing the entire
            # snapshot over one bad file among what can be thousands on an
            # active machine.
            continue

        if raw.get("role") != "assistant":
            continue

        created_ms = raw.get("time", {}).get("created") if isinstance(raw.get("time"), dict) else None
        if created_ms is None or created_ms < start_ms or created_ms > end_ms:
            continue

        requests += 1
        tokens = raw.get("tokens") or {}
        cache = tokens.get("cache") or {}
        message_input_tokens = tokens.get("input") or 0
        message_output_tokens = tokens.get("output") or 0
        message_cost = raw.get("cost") or 0
        input_tokens += message_input_tokens
        output_tokens += message_output_tokens
        cache_read_tokens += cache.get("read") or 0
        cache_write_tokens += cache.get("write") or 0
        cost_usd += message_cost

        session_id = raw.get("sessionID")
        if session_id:
            totals = session_totals.setdefault(
                session_id,
                {"cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0, "requests": 0},
            )
            totals["cost_usd"] += message_cost
            totals["input_tokens"] += message_input_tokens
            totals["output_tokens"] += message_output_tokens
            totals["requests"] += 1

    if requests == 0:
        return AdapterResult(
            source=TOOL, window=window, total_cost_usd=0, is_estimated=False, users=[]
        )

    # Only attach `sessions` when at least one message actually carried a
    # sessionID -- an empty list would misleadingly claim "zero sessions"
    # rather than "couldn't group anything."
    sessions: Optional[List[SessionUsage]] = (
        [
            SessionUsage(
                session_id=session_id,
                cost_usd=totals["cost_usd"],
                input_tokens=totals["input_tokens"],
                output_tokens=totals["output_tokens"],
                requests=totals["requests"],
                # Same reasoning as the overall result below: OpenCode has
                # no real cost source of truth, so every session's dollar
                # figure is just as estimated as the aggregate one.
                is_estimated=True,
            )
            for session_id, totals in session_totals.items()
        ]
        if session_totals
        else None
    )

    users = [
        UserUsage(
            user_id=getpass.getuser(),
            user_email=None,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_read_tokens=cache_read_tokens,
            cache_write_tokens=cache_write_tokens,
            requests=requests,
            cost_usd=cost_usd,
            # OpenCode has no admin-billed source of truth for cost the way
            # Cursor/Claude Code do. Per ccusage's own OpenCode guide:
            # "OpenCode stores cost: 0 in message files. Costs are
            # calculated from token counts using LiteLLM pricing."
            # teamspend bundles no per-token pricing table of its own -- one
            # would drift from real vendor prices and would be exactly the
            # kind of guessed data format this adapter is supposed to avoid
            # -- so it only ever sums whatever cost OpenCode itself recorded
            # (frequently $0) and always flags the result as estimated,
            # even on the rare message where that field is genuinely
            # populated.
            is_estimated=True,
            sessions=sessions,
        )
    ]

    return AdapterResult(
        source=TOOL,
        window=window,
        total_cost_usd=sum_cost(users),
        is_estimated=True,
        users=users,
    )

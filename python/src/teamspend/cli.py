#!/usr/bin/env python3
"""
teamspend CLI.

Ported from src/cli.ts (which uses Node's built-in `parseArgs`); this port
uses the stdlib `argparse` to avoid a CLI-framework dependency. Flags,
defaults, and validation error text are kept identical to the npm CLI's.

Console entry point: `teamspend --tools <a>,<b> --before ... --after ...`,
installed via the `teamspend` console-script defined in pyproject.toml.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import os
import re
import sys
from importlib import metadata as _importlib_metadata
from typing import List, Optional, Tuple

from .adapters.claude_code import fetch_claude_code_spend
from .adapters.claude_code_personal import fetch_claude_code_personal_usage
from .adapters.codex import fetch_codex_usage
from .adapters.copilot import fetch_copilot_spend
from .adapters.csv_import import import_from_csv
from .adapters.cursor import fetch_cursor_spend
from .adapters.opencode import fetch_opencode_spend
from .compare import ComparisonReport, PeriodOutcome, build_comparison
from .errors import DataUnavailableError, InvalidCliArgError
from .output import render_terminal_summary, scaffold_gitignore, write_json_report
from .types import AdapterResult, BreakdownMode, DateWindow, ToolId

KNOWN_TOOLS: List[ToolId] = [
    "cursor",
    "claude-code",
    "copilot",
    "opencode",
    "claude-code-personal",
    "codex",
]
KNOWN_BREAKDOWN_MODES: List[BreakdownMode] = ["session"]
DATE_RANGE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$")


def _resolve_version() -> str:
    """
    Reads the installed `teamspend-cli` distribution's version at runtime
    via importlib.metadata, rather than a hardcoded string that silently
    goes stale on every release (a real bug found by /check-repo-sanity:
    `--version` kept reporting "0.1.0" through five releases up to 0.2.2).
    Falls back to "0.0.0-dev" when running from a source checkout with no
    installed distribution metadata (e.g. `python -m teamspend.cli`
    without `pip install -e .` first), rather than raising.
    """
    try:
        return _importlib_metadata.version("teamspend-cli")
    except _importlib_metadata.PackageNotFoundError:
        return "0.0.0-dev"


_VERSION = _resolve_version()


def _parse_date_range(flag: str, value: str) -> DateWindow:
    match = DATE_RANGE_RE.match(value)
    if not match:
        raise InvalidCliArgError(
            f'--{flag} must be in the form YYYY-MM-DD:YYYY-MM-DD, got "{value}"'
        )
    return DateWindow(start=match.group(1), end=match.group(2))


def _validate_tools(raw_tools: str) -> Tuple[ToolId, ToolId]:
    parts = [t.strip() for t in raw_tools.split(",")]
    if len(parts) != 2:
        raise InvalidCliArgError(
            f'--tools must name exactly two tools, got "{raw_tools}"'
        )
    for tool in parts:
        if tool not in KNOWN_TOOLS:
            raise InvalidCliArgError(
                f'Unknown tool "{tool}" -- expected one of: {", ".join(KNOWN_TOOLS)}'
            )
    return parts[0], parts[1]  # type: ignore[return-value]


def _validate_window_order(before: DateWindow, after: DateWindow) -> None:
    if before.start >= after.start:
        raise InvalidCliArgError(
            f"--before ({before.start}) must be earlier than --after ({after.start})"
        )


def _parse_breakdown_mode(raw: Optional[str]) -> Optional[BreakdownMode]:
    """
    Parses --breakdown. Unset (None) is the default (no change from prior
    behavior). A set-but-unrecognized value raises rather than silently
    being ignored, since a typo like `--breakdown sessions` should surface
    immediately instead of quietly reporting the plain flat total the
    caller didn't ask for.
    """
    if raw is None:
        return None
    if raw in KNOWN_BREAKDOWN_MODES:
        return raw  # type: ignore[return-value]
    raise InvalidCliArgError(
        f'--breakdown must be one of: {", ".join(KNOWN_BREAKDOWN_MODES)}, got "{raw}"'
    )


def _strip_sessions_unless_requested(
    result: Optional[AdapterResult], breakdown: Optional[BreakdownMode]
) -> Optional[AdapterResult]:
    """
    Removes per-session data from a fetched result when the caller didn't
    ask for it via --breakdown session. Adapters populate `sessions`
    whenever their underlying data has it, independent of any CLI flag;
    stripping it back out here (rather than teaching every adapter about
    the flag) is what keeps the default JSON report and terminal output
    unchanged from before this feature existed.
    """
    if result is None or breakdown == "session":
        return result
    for user in result.users:
        user.sessions = None
    return result


def _parse_copilot_seat_price() -> Optional[float]:
    """
    Parses TEAMSPEND_COPILOT_SEAT_PRICE_USD, an optional per-seat monthly
    price the caller supplies since GitHub's API never exposes an org's
    actual negotiated seat price. Returns None if unset. Raises
    InvalidCliArgError for a set-but-unparseable or negative value.
    """
    raw = os.environ.get("TEAMSPEND_COPILOT_SEAT_PRICE_USD")
    if not raw:
        return None
    try:
        parsed = float(raw)
    except ValueError:
        parsed = float("nan")
    if not (parsed >= 0):
        raise InvalidCliArgError(
            f'TEAMSPEND_COPILOT_SEAT_PRICE_USD must be a non-negative number, got "{raw}"'
        )
    return parsed


def _fetch_tool(
    tool: ToolId, window: DateWindow, csv_path: Optional[str]
) -> Optional[AdapterResult]:
    env_var = f"TEAMSPEND_{tool.upper().replace('-', '_')}_TOKEN"
    api_key = os.environ.get(env_var)

    try:
        if tool == "cursor":
            if not api_key:
                raise RuntimeError(f"Missing {env_var}")
            return fetch_cursor_spend(window, api_key)
        if tool == "claude-code":
            if not api_key:
                raise RuntimeError(f"Missing {env_var}")
            return fetch_claude_code_spend(window, api_key)
        if tool == "copilot":
            if not api_key:
                raise RuntimeError(f"Missing {env_var}")
            org = os.environ.get("TEAMSPEND_COPILOT_ORG")
            if not org:
                raise RuntimeError("Missing TEAMSPEND_COPILOT_ORG")
            return fetch_copilot_spend(
                window, api_key, org, _parse_copilot_seat_price()
            )
        if tool == "opencode":
            # No API key: opencode has no admin/team API, only local
            # per-machine session logs (see adapters/opencode.py for how
            # those are resolved and read).
            return fetch_opencode_spend(window)
        if tool == "claude-code-personal":
            # Deliberately no credential check -- this mode reads Claude
            # Code's own local JSONL session logs and never calls an admin
            # API, so TEAMSPEND_CLAUDE_CODE_PERSONAL_TOKEN is never
            # required.
            return fetch_claude_code_personal_usage(window)
        if tool == "codex":
            # No API key: Codex CLI has no admin/team API, only local
            # per-machine rollout logs (see adapters/codex.py for how
            # those are resolved and read).
            return fetch_codex_usage(window)
        raise InvalidCliArgError(f'No adapter for tool "{tool}"')
    except DataUnavailableError:
        if csv_path:
            return import_from_csv(csv_path, tool, window)
        raise


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="teamspend",
        add_help=False,
        description=(
            "Compare AI coding tool spend before and after a migration."
        ),
    )
    parser.add_argument("--tools")
    parser.add_argument("--before")
    parser.add_argument("--after")
    parser.add_argument("--json", action="store_true", default=False)
    parser.add_argument("--before-csv", dest="before_csv")
    parser.add_argument("--after-csv", dest="after_csv")
    parser.add_argument("--breakdown")
    parser.add_argument("--version", action="store_true", default=False)
    parser.add_argument("-h", "--help", action="store_true", default=False)
    return parser


_USAGE = (
    "Usage: teamspend --tools <a>,<b> --before YYYY-MM-DD:YYYY-MM-DD "
    "--after YYYY-MM-DD:YYYY-MM-DD [--json] [--before-csv <path>] [--after-csv <path>] "
    "[--breakdown session]"
)


def run(argv: List[str]) -> int:
    """
    Runs the CLI against `argv` (NOT including the program name -- this
    matches Python's usual `sys.argv[1:]` convention, unlike the TypeScript
    original's `process.argv.slice(2)` call site which strips two leading
    entries; both end up passing "just the flags" to their respective
    `run`/`run_cli` functions). Returns the process exit code.
    """
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit:
        return 1

    if args.help:
        print(_USAGE)
        return 0

    if args.version:
        print(f"teamspend {_VERSION}")
        return 0

    try:
        if not args.tools or not args.before or not args.after:
            print(_USAGE, file=sys.stderr)
            return 1

        before_tool, after_tool = _validate_tools(args.tools)
        before_window = _parse_date_range("before", args.before)
        after_window = _parse_date_range("after", args.after)
        _validate_window_order(before_window, after_window)
        breakdown = _parse_breakdown_mode(args.breakdown)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            before_future = executor.submit(
                _fetch_tool, before_tool, before_window, args.before_csv
            )
            after_future = executor.submit(
                _fetch_tool, after_tool, after_window, args.after_csv
            )

            before_result: Optional[AdapterResult] = None
            before_error: Optional[BaseException] = None
            try:
                before_result = before_future.result()
            except BaseException as error:  # noqa: BLE001 -- mirrors Promise.allSettled, any adapter failure becomes a per-side error, never a crash
                before_error = error

            after_result: Optional[AdapterResult] = None
            after_error: Optional[BaseException] = None
            try:
                after_result = after_future.result()
            except BaseException as error:  # noqa: BLE001
                after_error = error

        before = PeriodOutcome(
            label="before",
            tool=before_tool,
            result=_strip_sessions_unless_requested(before_result, breakdown),
            error=before_error,
        )
        after = PeriodOutcome(
            label="after",
            tool=after_tool,
            result=_strip_sessions_unless_requested(after_result, breakdown),
            error=after_error,
        )

        report: ComparisonReport = build_comparison(before, after)
        cwd = os.getcwd()
        scaffolded = scaffold_gitignore(cwd)
        json_path = write_json_report(report, cwd)

        if scaffolded:
            print(
                "Note: teamspend-snapshot-*.json contains per-user email and "
                "spend data -- added to .gitignore.",
                file=sys.stderr,
            )

        # Printed every run, not just on first-run gitignore scaffolding: a
        # .gitignore entry protects the on-disk file, but does nothing about
        # this same per-user email + spend data being printed to stdout,
        # which lands in CI build logs (often world-readable for public
        # repos) if this command is wired into a scheduled workflow.
        print(
            "Note: this output includes per-user email and spend data. If "
            "running in CI, confirm build logs are private.",
            file=sys.stderr,
        )

        if args.json:
            import json as json_module

            from .output import report_to_json_dict

            print(json_module.dumps(report_to_json_dict(report), indent=2))
        else:
            print(render_terminal_summary(report, breakdown))
            print(f"\nFull report: {json_path}")

        return 0 if before.result and after.result else 1
    except Exception as error:  # noqa: BLE001 -- top-level crash guard, mirrors src/cli.ts's catch-all
        print(str(error), file=sys.stderr)
        return 1


def main() -> None:
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":
    main()

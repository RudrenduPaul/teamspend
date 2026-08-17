"""
MCP (Model Context Protocol) stdio server wrapping the teamspend CLI.

Pilot-pattern implementation of the generic MCP server template described in
strategy-b2a-ideas/gtm/mcp-plugins.md ("Generic MCP Server Template"): one
exposed tool that shells out to the underlying CLI with --json appended,
parses the JSON stdout, and returns it as the tool result.

Deliberately shells out to the Node/TypeScript CLI (`npx teamspend`) rather
than calling into this same Python package's own native `teamspend.cli`
module. Per the template, the MCP wrapper's implementation language is
independent of the CLI's: this keeps one wrapper shape reusable across the
whole portfolio regardless of whether a given repo's CLI is Node or Python,
and it exercises the actual published `teamspend` npm binary end to end
rather than a parallel code path.

stdout is reserved for MCP's JSON-RPC framing, so anything this module
logs goes to stderr.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

from mcp.server import MCPServer

# Local-test override: point at a built dist/cli.js instead of `npx teamspend`.
# The npm package may not be globally linked on a dev machine, so testing
# this wrapper against a repo checkout needs a direct `node <path>` command.
# Production default (no env var set) is `npx teamspend`.
_LOCAL_CLI_JS = os.environ.get("TEAMSPEND_CLI_JS")


def _base_command() -> list[str]:
    if _LOCAL_CLI_JS:
        return ["node", _LOCAL_CLI_JS]
    return ["npx", "teamspend"]


_TOOL_DESCRIPTION = """Compare AI-coding-tool spend between a "before" and "after" date window across two tools, using each vendor's own admin/analytics API (or local session logs for the credential-free `claude-code-personal` mode) so the result is a real reported number, not an estimate. Call this when a user asks things like "did switching from Cursor to Claude Code save us money" or "what did our AI coding spend look like before vs. after we rolled out Copilot" -- it answers exactly that comparison in one shot. Do not call it for anything outside a two-tool before/after cost comparison (e.g. general usage analytics, per-line-item billing detail, or tools other than cursor, claude-code, claude-code-personal, copilot, opencode, codex).

Prerequisites: the two admin API tokens for whichever tools are being compared must already be set as environment variables in the server's process (e.g. TEAMSPEND_CURSOR_TOKEN, TEAMSPEND_CLAUDE_CODE_TOKEN, TEAMSPEND_COPILOT_TOKEN + TEAMSPEND_COPILOT_ORG); claude-code-personal needs no token since it reads local session logs instead. Missing credentials do not raise an exception -- the tool still returns successfully, with a `DataUnavailableError` recorded against the affected side (see below) so the caller can see exactly what's missing.

Behavioral notes: this makes outbound network calls to the relevant vendor APIs (skipped for claude-code-personal) and is read-only against the user's own systems, but it also writes a `teamspend-snapshot-*.json` report file to disk in the current working directory on every run (contains per-user email and spend data, permissions set to owner-only 0600). Each call is independent and idempotent -- rerunning with the same args re-fetches fresh data and overwrites the report file, it never accumulates state across calls. On a CLI crash or non-zero exit, the returned dict carries an `error` key plus the captured `stderr` and the exact `command` that was run, rather than raising.

Parameter: `args` is a list[str] of argv exactly as they'd appear on the teamspend command line -- `--json` is appended automatically and must not be included. Required flags are `--tools <a>,<b>` (exactly two of: cursor, claude-code, copilot, opencode, claude-code-personal, codex) and `--before`/`--after` as `YYYY-MM-DD:YYYY-MM-DD` ranges. Optional flags: `--before-csv`/`--after-csv <path>` to backfill a window an API can't reach, `--breakdown session` for a per-session cost breakdown. Real examples:
  ["--tools", "cursor,claude-code", "--before", "2026-04-01:2026-04-30", "--after", "2026-06-01:2026-06-30"]
  ["--tools", "claude-code-personal,opencode", "--before", "2026-01-01:2026-01-31", "--after", "2026-02-01:2026-02-28", "--breakdown", "session"]
  ["--help"]  (discovers every supported flag and tool name directly from the CLI, without a code change)

Returns a dict parsed from the CLI's own `--json` output with keys `before` and `after` (each `{label, tool, result, error}`, where `result` is null and `error` is populated when that side's data was unavailable), plus top-level `deltaUsd`, `deltaPercent`, and `topSpendersAcrossBoth`."""

mcp = MCPServer(name="teamspend")


@mcp.tool(description=_TOOL_DESCRIPTION)
def run(args: list[str]) -> dict[str, Any]:
    """Run the teamspend CLI with `args` and return its parsed `--json`
    output. `--json` is appended automatically, callers should not pass it
    themselves. See the tool description for the full argv shape, real
    examples, prerequisites, and the JSON keys returned."""
    command = [*_base_command(), *args, "--json"]
    print(f"teamspend-mcp: running {command!r}", file=sys.stderr)
    try:
        proc = subprocess.run(command, capture_output=True, text=True, timeout=300)
    except OSError as exc:
        return {"error": f"failed to exec {command!r}: {exc}"}
    if proc.stderr:
        print(f"teamspend-mcp: stderr: {proc.stderr}", file=sys.stderr)
    if proc.returncode != 0:
        return {
            "error": f"teamspend exited with code {proc.returncode}",
            "stderr": proc.stderr.strip(),
            "command": command,
        }
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        return {
            "error": f"could not parse JSON output: {exc}",
            "stdout": proc.stdout,
            "command": command,
        }


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

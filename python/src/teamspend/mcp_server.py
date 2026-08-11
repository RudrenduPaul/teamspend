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


def _capture_help() -> str:
    """Best-effort `--help` capture, used as the tool's dynamic description
    instead of a hardcoded string."""
    fallback = (
        "Compare AI-coding-tool spend between a before/after window across "
        "two tools (cursor, claude-code, copilot, opencode, "
        "claude-code-personal, codex)."
    )
    try:
        proc = subprocess.run(
            [*_base_command(), "--help"],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return proc.stdout.strip() or fallback
    except Exception as exc:  # noqa: BLE001 - degrade to a generic description
        print(f"teamspend-mcp: could not capture --help: {exc}", file=sys.stderr)
        return fallback


mcp = MCPServer(name="teamspend")


@mcp.tool(description=_capture_help())
def run(args: list[str]) -> dict[str, Any]:
    """Run the teamspend CLI with `args` (e.g. ["--tools",
    "claude-code-personal,opencode", "--before", "2020-01-01:2020-01-31",
    "--after", "2020-02-01:2020-02-28"]) and return its parsed `--json`
    output. `--json` is appended automatically, callers should not pass it
    themselves."""
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

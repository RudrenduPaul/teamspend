"""
Programmatic / agent-native entry point.

    from teamspend import fetch_cursor_spend, fetch_claude_code_spend, build_comparison

    before = fetch_cursor_spend(DateWindow("2026-04-01", "2026-04-30"), api_key)
    after = fetch_claude_code_spend(DateWindow("2026-06-01", "2026-06-30"), api_key)

Each adapter returns the same normalized AdapterResult shape regardless of
source vendor, so a caller (CLI, CI script, or an agent framework) can
compare spend across tools without vendor-specific branching.

This is the Python port of the teamspend npm package
(https://www.npmjs.com/package/teamspend). Both distributions talk to the
same two admin APIs (Cursor, Anthropic Claude Enterprise Analytics) and
compute the same before/after delta; see
https://github.com/RudrenduPaul/teamspend for the canonical documentation
and the original TypeScript source.
"""
from importlib import metadata as _importlib_metadata

from .adapters.claude_code import fetch_claude_code_spend
from .adapters.copilot import fetch_copilot_spend
from .adapters.csv_import import import_from_csv
from .adapters.cursor import fetch_cursor_spend
from .compare import ComparisonReport, PeriodOutcome, TopSpenderEntry, build_comparison
from .errors import (
    AuthenticationError,
    CSVRowError,
    CSVSchemaError,
    DataUnavailableError,
    EmptyCSVError,
    InvalidCliArgError,
    RetryExhaustedError,
    SchemaDriftError,
)
from .http_client import fetch_with_retry, require_field
from .output import (
    render_terminal_summary,
    report_to_json_dict,
    scaffold_gitignore,
    write_json_report,
)
from .types import AdapterResult, DateWindow, ToolId, UserUsage, sum_cost, top_spenders

try:
    # Read the version from the installed package's own metadata, same as
    # cli.py's _resolve_version() already does for `teamspend --version`,
    # rather than a separate hand-maintained string here -- this constant
    # was still "0.1.0" while the package had shipped 0.2.3, so
    # `teamspend.__version__` (unlike the CLI's --version) silently
    # reported a stale, wrong version to any caller importing the module.
    __version__ = _importlib_metadata.version("teamspend-cli")
except _importlib_metadata.PackageNotFoundError:
    __version__ = "0.0.0-dev"

__all__ = [
    "__version__",
    # types
    "AdapterResult",
    "DateWindow",
    "ToolId",
    "UserUsage",
    "sum_cost",
    "top_spenders",
    # errors
    "AuthenticationError",
    "RetryExhaustedError",
    "SchemaDriftError",
    "DataUnavailableError",
    "CSVSchemaError",
    "EmptyCSVError",
    "CSVRowError",
    "InvalidCliArgError",
    # http
    "fetch_with_retry",
    "require_field",
    # adapters
    "fetch_cursor_spend",
    "fetch_claude_code_spend",
    "fetch_copilot_spend",
    "import_from_csv",
    # compare
    "PeriodOutcome",
    "ComparisonReport",
    "TopSpenderEntry",
    "build_comparison",
    # output
    "render_terminal_summary",
    "write_json_report",
    "report_to_json_dict",
    "scaffold_gitignore",
]

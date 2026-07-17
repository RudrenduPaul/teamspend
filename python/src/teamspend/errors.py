"""
Named error types for every failure mode the fetch/compare pipeline can hit.

Ported from src/errors.ts. Message text is kept identical to the
TypeScript original so a bug report reads the same regardless of which
distribution (npm or PyPI) produced it.
"""
from __future__ import annotations

from typing import Iterable, List, Sequence


class AuthenticationError(Exception):
    """Raised when an admin API responds 401/403 for a tool's credential."""

    def __init__(self, tool: str, credential_env_var: str) -> None:
        self.tool = tool
        self.credential_env_var = credential_env_var
        super().__init__(
            f"Auth failed for {tool}: check {credential_env_var} is set and valid"
        )


class RetryExhaustedError(Exception):
    """Raised when fetch_with_retry exhausts its retry budget."""

    def __init__(self, tool: str, failure_kind: str, attempts: int) -> None:
        self.tool = tool
        self.failure_kind = failure_kind
        self.attempts = attempts
        super().__init__(f"{tool} failed after {attempts} retries ({failure_kind})")


class SchemaDriftError(Exception):
    """Raised when a vendor API response is missing a field require_field expects."""

    def __init__(
        self,
        tool: str,
        unexpected_field: str,
        tried_aliases: Sequence[str] = (),
    ) -> None:
        self.tool = tool
        self.unexpected_field = unexpected_field
        self.tried_aliases: List[str] = list(tried_aliases)
        alias_suffix = (
            f" (also checked known aliases: {', '.join(self.tried_aliases)})"
            if self.tried_aliases
            else ""
        )
        super().__init__(
            f"{tool} API returned an unexpected shape (field: {unexpected_field})"
            f"{alias_suffix}, teamspend may need an update"
        )


class DataUnavailableError(Exception):
    """Raised when a tool's admin API cannot serve the requested window at all."""

    def __init__(self, tool: str, reason: str) -> None:
        self.tool = tool
        self.reason = reason
        super().__init__(
            f"No API data available for {tool}: {reason}, "
            "provide a CSV file per the documented schema"
        )


class CSVSchemaError(Exception):
    """Raised when an imported CSV is missing one of the required columns."""

    def __init__(self, expected_columns: Iterable[str]) -> None:
        self.expected_columns: List[str] = list(expected_columns)
        super().__init__(
            f"CSV file doesn't match expected columns: {', '.join(self.expected_columns)}"
        )


class EmptyCSVError(Exception):
    """Raised for a zero-byte or whitespace-only CSV file."""

    def __init__(self, path: str) -> None:
        self.path = path
        super().__init__(f"CSV file is empty: {path}")


class CSVRowError(Exception):
    """Raised for a single malformed CSV row (bad cost, empty email)."""

    def __init__(self, row_number: int, reason: str) -> None:
        self.row_number = row_number
        super().__init__(f"CSV row {row_number} is invalid: {reason}")


class InvalidCliArgError(Exception):
    """Raised for a malformed or missing CLI flag."""

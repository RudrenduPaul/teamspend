"""
Shared fetch+retry wrapper used by every admin-API adapter.

Ported from src/http-client.ts. Retries 429 and 5xx/timeout identically
with exponential backoff (base 0.5s, doubling, cap 3 retries), then fails
with a named error rather than ever returning a partial or guessed result.

Uses only `urllib` from the standard library (no `requests` dependency),
matching the npm package's "zero runtime dependencies" design -- the
TypeScript original uses native `fetch` for the same reason.

The real network call is a separate, injectable `transport` parameter so
tests can simulate arbitrary HTTP statuses and network failures without a
real socket, the same technique the TypeScript test suite uses by stubbing
the global `fetch`.
"""
from __future__ import annotations

import json as json_module
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Sequence
from urllib.parse import urlsplit

from .errors import AuthenticationError, RetryExhaustedError, SchemaDriftError

MAX_RETRIES = 3
BASE_DELAY_SECONDS = 0.5
REQUEST_TIMEOUT_SECONDS = 30.0

_SENSITIVE_HEADERS = ("Authorization", "x-api-key")


class _SameOriginRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Strips auth headers before following a redirect to a different host.

    urllib's default HTTPRedirectHandler forwards every original request
    header -- including Authorization/x-api-key -- to wherever a 3xx
    Location points, even a different host. `requests` strips auth headers
    on cross-origin redirects by default; bare urllib does not. Every
    teamspend admin-API call carries a live vendor token, so a compromised
    or misconfigured upstream (or a MITM in front of it) could otherwise
    use a redirect to exfiltrate the token to an attacker-controlled host.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_request = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_request is None:
            return None
        if urlsplit(req.full_url).netloc != urlsplit(newurl).netloc:
            for header in _SENSITIVE_HEADERS:
                # Request.remove_header() does a raw dict .pop() with no case
                # normalization, while add_header() stores keys via
                # .capitalize() ("x-api-key" -> "X-api-key"). Passing the raw
                # header name here silently no-ops for anything whose casing
                # doesn't already match its capitalize()'d form.
                new_request.remove_header(header.capitalize())
        return new_request


_opener = urllib.request.build_opener(_SameOriginRedirectHandler)


@dataclass
class HttpResponse:
    status: int
    body: bytes

    def json(self) -> Any:
        return json_module.loads(self.body.decode("utf-8"))


class TransportError(Exception):
    """Internal: network-level failure (timeout, DNS, connection refused).

    Never raised to a caller of fetch_with_retry -- always converted into a
    RetryExhaustedError("timeout") once retries are exhausted, matching the
    TypeScript original's handling of a rejected fetch() promise.
    """


Transport = Callable[[str, Dict[str, str], float], HttpResponse]


def default_transport(url: str, headers: Dict[str, str], timeout: float) -> HttpResponse:
    """Real network transport. GET only -- every teamspend admin-API call is a GET."""
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with _opener.open(request, timeout=timeout) as response:  # noqa: S310 -- fixed https:// admin-API URLs built from constants, never from unsanitized input
            return HttpResponse(status=response.status, body=response.read())
    except urllib.error.HTTPError as error:
        # HTTPError already carries the response body/status for non-2xx --
        # treat it as a normal (non-2xx) HttpResponse so the retry/auth
        # logic below can inspect the status code uniformly.
        return HttpResponse(status=error.code, body=error.read())
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise TransportError(str(error)) from error


def _is_retryable(status: int) -> Optional[str]:
    if status == 429:
        return "rate-limit"
    if 500 <= status < 600:
        return "server-error"
    return None


def fetch_with_retry(
    tool: str,
    url: str,
    auth_header: Dict[str, str],
    *,
    transport: Optional[Transport] = None,
    sleep: Callable[[float], None] = time.sleep,
) -> Any:
    """
    Fetches `url` with `auth_header`, retrying 429/5xx/timeout up to
    MAX_RETRIES times with exponential backoff. Returns the parsed JSON
    body on success. Raises AuthenticationError immediately on 401/403
    (never retried), RetryExhaustedError once the retry budget is spent.

    `transport` defaults to None and resolves to `default_transport` inside
    the function body (rather than as the parameter's default value) on
    purpose: a default value is bound once, at function-definition time, so
    binding it directly to `default_transport` would freeze a stale
    reference that a test monkeypatching `http_client.default_transport`
    could never actually intercept.
    """
    if transport is None:
        transport = default_transport
    last_failure_kind = "timeout"

    for attempt in range(MAX_RETRIES + 1):
        try:
            response = transport(url, auth_header, REQUEST_TIMEOUT_SECONDS)
        except TransportError:
            last_failure_kind = "timeout"
            if attempt < MAX_RETRIES:
                sleep(BASE_DELAY_SECONDS * (2**attempt))
                continue
            raise RetryExhaustedError(tool, last_failure_kind, attempt + 1)

        if response.status in (401, 403):
            raise AuthenticationError(
                tool, f"TEAMSPEND_{tool.upper().replace('-', '_')}_TOKEN"
            )

        retry_kind = _is_retryable(response.status)
        if retry_kind:
            last_failure_kind = retry_kind
            if attempt < MAX_RETRIES:
                sleep(BASE_DELAY_SECONDS * (2**attempt))
                continue
            raise RetryExhaustedError(tool, retry_kind, attempt + 1)

        if not (200 <= response.status < 300):
            raise RuntimeError(f"{tool} returned unexpected status {response.status}")

        return response.json()

    # Unreachable, but keeps type checkers satisfied about a return path.
    raise RetryExhaustedError(tool, last_failure_kind, MAX_RETRIES + 1)


def require_field(
    obj: Dict[str, Any],
    field_name: str,
    tool: str,
    aliases: Sequence[str] = (),
) -> Any:
    """
    Asserts a field exists on a parsed API response before it is read.
    Raises SchemaDriftError rather than silently coercing/guessing when a
    vendor's response shape changes without notice.

    `aliases` is an optional, ordered list of legacy/alternate key names to
    fall back to if the primary `field_name` is absent, guarding against a
    vendor silently renaming a field. No adapter currently passes aliases --
    Cursor and Anthropic have not renamed anything -- but the mechanism
    exists so a future rename degrades gracefully instead of hard-failing.
    """
    if field_name in obj and obj[field_name] is not None:
        return obj[field_name]
    for alias in aliases:
        if alias in obj and obj[alias] is not None:
            return obj[alias]
    raise SchemaDriftError(tool, field_name, list(aliases))

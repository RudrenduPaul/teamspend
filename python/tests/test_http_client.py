import pytest

from teamspend.errors import AuthenticationError, RetryExhaustedError, SchemaDriftError
from teamspend.http_client import TransportError, fetch_with_retry, require_field

from .conftest import ScriptedTransport, json_response


def test_returns_the_parsed_body_on_a_happy_path_200(no_sleep):
    transport = ScriptedTransport([json_response(200, {"ok": True})])
    result = fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert result == {"ok": True}


def test_throws_authentication_error_naming_the_tool_and_env_var_on_401(no_sleep):
    transport = ScriptedTransport([json_response(401, {})])
    with pytest.raises(AuthenticationError) as excinfo:
        fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert excinfo.value.tool == "cursor"
    assert excinfo.value.credential_env_var == "TEAMSPEND_CURSOR_TOKEN"


def test_retries_a_429_with_backoff_then_succeeds(no_sleep):
    transport = ScriptedTransport(
        [json_response(429, {}), json_response(200, {"ok": True})]
    )
    result = fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert result == {"ok": True}
    assert transport.call_count == 2


def test_fails_with_retry_exhausted_error_after_3_retries_on_repeated_429(no_sleep):
    transport = ScriptedTransport([json_response(429, {})])
    with pytest.raises(RetryExhaustedError) as excinfo:
        fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert excinfo.value.attempts == 4
    assert excinfo.value.failure_kind == "rate-limit"


def test_treats_a_500_identically_to_a_429_retry_then_fail(no_sleep):
    transport = ScriptedTransport([json_response(503, {})])
    with pytest.raises(RetryExhaustedError):
        fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)


def test_treats_a_network_error_identically_to_a_timeout_retry_then_fail(no_sleep):
    transport = ScriptedTransport([TransportError("ECONNRESET")])
    with pytest.raises(RetryExhaustedError) as excinfo:
        fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert excinfo.value.failure_kind == "timeout"


def test_passes_the_timeout_through_to_the_transport_so_a_stalled_connection_cannot_hang(
    no_sleep,
):
    transport = ScriptedTransport([json_response(200, {"ok": True})])
    fetch_with_retry("cursor", "https://x", {}, transport=transport, sleep=no_sleep)
    assert transport.calls[0]["timeout"] == 30.0


def test_sleeps_with_exponential_backoff_between_retries():
    transport = ScriptedTransport(
        [json_response(429, {}), json_response(429, {}), json_response(200, {"ok": True})]
    )
    sleeps = []
    fetch_with_retry(
        "cursor", "https://x", {}, transport=transport, sleep=lambda s: sleeps.append(s)
    )
    assert sleeps == [0.5, 1.0]


def test_returns_the_field_value_when_present():
    assert require_field({"foo": "bar"}, "foo", "cursor") == "bar"


def test_throws_schema_drift_error_naming_the_tool_and_field_when_missing():
    with pytest.raises(SchemaDriftError) as excinfo:
        require_field({}, "foo", "cursor")
    assert excinfo.value.tool == "cursor"
    assert excinfo.value.unexpected_field == "foo"


def test_uses_the_primary_field_when_both_it_and_an_alias_are_present():
    assert (
        require_field({"period": "primary", "month": "legacy"}, "period", "cursor", ["month"])
        == "primary"
    )


def test_falls_back_to_an_alias_when_the_primary_field_is_absent():
    assert (
        require_field({"month": "2026-07"}, "period", "cursor", ["month", "date"])
        == "2026-07"
    )


def test_throws_schema_drift_error_when_neither_the_primary_field_nor_any_alias_is_present():
    with pytest.raises(SchemaDriftError):
        require_field({}, "period", "cursor", ["month", "date"])


def test_includes_the_tried_alias_names_in_the_error_message_when_aliases_were_passed():
    with pytest.raises(SchemaDriftError, match="month, date"):
        require_field({}, "period", "cursor", ["month", "date"])

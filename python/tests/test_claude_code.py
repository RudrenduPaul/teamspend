import json

import pytest

from teamspend.adapters.claude_code import fetch_claude_code_spend
from teamspend.errors import DataUnavailableError
from teamspend.types import DateWindow

from .conftest import ScriptedTransport, json_response


def _user_payload(spend_usd: float, **overrides):
    payload = {
        "user_id": "u1",
        "email": "a@x.com",
        "input_tokens": 90000,
        "output_tokens": 20000,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "spend_usd": spend_usd,
    }
    payload.update(overrides)
    return payload


def test_normalizes_a_happy_path_response_against_the_fixture(fixtures_dir, no_sleep):
    fixture = json.loads((fixtures_dir / "claude-code.fixture.json").read_text())
    transport = ScriptedTransport([json_response(200, fixture)])

    result = fetch_claude_code_spend(
        DateWindow("2026-06-01", "2026-06-30"),
        "test-key",
        transport=transport,
        sleep=no_sleep,
    )

    assert result.source == "claude-code"
    assert len(result.users) == 2
    assert result.total_cost_usd == pytest.approx(288.9 + 198.25, abs=0.01)


def test_flags_a_suspicious_zero_and_flips_the_whole_result_to_estimated(no_sleep):
    transport = ScriptedTransport(
        [json_response(200, {"users": [_user_payload(0, email="flat-seat@x.com")]})]
    )
    result = fetch_claude_code_spend(
        DateWindow("2026-06-01", "2026-06-30"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.users[0].is_estimated is True
    assert result.is_estimated is True


def test_keeps_is_estimated_false_for_a_genuinely_inactive_user(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(
                200,
                {
                    "users": [
                        _user_payload(
                            0, email="inactive@x.com", input_tokens=0, output_tokens=0
                        )
                    ]
                },
            )
        ]
    )
    result = fetch_claude_code_spend(
        DateWindow("2026-06-01", "2026-06-30"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.users[0].is_estimated is False
    assert result.is_estimated is False


def test_leaves_a_normal_nonzero_spend_user_unaffected(no_sleep):
    transport = ScriptedTransport(
        [json_response(200, {"users": [_user_payload(75.4, email="normal@x.com")]})]
    )
    result = fetch_claude_code_spend(
        DateWindow("2026-06-01", "2026-06-30"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.users[0].is_estimated is False
    assert result.is_estimated is False


def test_raises_data_unavailable_error_when_window_predates_analytics_api_start_without_calling(
    no_sleep,
):
    transport = ScriptedTransport([json_response(200, {"users": []})])
    with pytest.raises(DataUnavailableError):
        fetch_claude_code_spend(
            DateWindow("2025-11-01", "2025-11-30"),
            "test-key",
            transport=transport,
            sleep=no_sleep,
        )
    assert transport.call_count == 0

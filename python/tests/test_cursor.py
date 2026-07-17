import json

import pytest

from teamspend.adapters.cursor import fetch_cursor_spend
from teamspend.errors import RetryExhaustedError
from teamspend.types import DateWindow

from .conftest import ScriptedTransport, json_response


def test_normalizes_a_happy_path_response_against_the_fixture(fixtures_dir, no_sleep):
    fixture = json.loads((fixtures_dir / "cursor.fixture.json").read_text())
    transport = ScriptedTransport([json_response(200, fixture)])

    result = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-30"),
        "test-key",
        transport=transport,
        sleep=no_sleep,
    )

    assert result.source == "cursor"
    assert len(result.users) == 2
    assert result.total_cost_usd == pytest.approx(156.2 + 84.1, abs=0.01)
    assert result.is_estimated is False


def test_reports_zero_spend_explicitly_for_an_empty_window(no_sleep):
    transport = ScriptedTransport([json_response(200, {"users": []})])
    result = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-05"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.total_cost_usd == 0
    assert result.users == []


def _user_payload(cost_usd: float, **overrides):
    payload = {
        "user_id": "u1",
        "email": "a@x.com",
        "input_tokens": 1,
        "output_tokens": 1,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "requests": 1,
        "cost_usd": cost_usd,
    }
    payload.update(overrides)
    return payload


def test_paginates_across_a_window_longer_than_30_days_and_sums_the_chunks(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(200, {"users": [_user_payload(10)]}),
            json_response(200, {"users": [_user_payload(5)]}),
        ]
    )
    result = fetch_cursor_spend(
        DateWindow("2026-01-01", "2026-03-01"), "test-key", transport=transport, sleep=no_sleep
    )
    assert transport.call_count == 2
    assert result.total_cost_usd == 15
    assert len(result.users) == 1


def test_flags_a_suspicious_zero_and_flips_the_whole_result_to_estimated(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(
                200,
                {
                    "users": [
                        _user_payload(
                            0,
                            email="flat-seat@x.com",
                            input_tokens=50000,
                            output_tokens=12000,
                            requests=25,
                        )
                    ]
                },
            )
        ]
    )
    result = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-05"), "test-key", transport=transport, sleep=no_sleep
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
                            0,
                            email="inactive@x.com",
                            input_tokens=0,
                            output_tokens=0,
                            requests=0,
                        )
                    ]
                },
            )
        ]
    )
    result = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-05"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.users[0].is_estimated is False
    assert result.is_estimated is False


def test_leaves_a_normal_nonzero_cost_user_unaffected(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(
                200,
                {
                    "users": [
                        _user_payload(
                            42.5,
                            email="normal@x.com",
                            input_tokens=50000,
                            output_tokens=12000,
                            requests=25,
                        )
                    ]
                },
            )
        ]
    )
    result = fetch_cursor_spend(
        DateWindow("2026-04-01", "2026-04-05"), "test-key", transport=transport, sleep=no_sleep
    )
    assert result.users[0].is_estimated is False
    assert result.is_estimated is False


def test_keeps_is_estimated_true_after_merging_across_chunks(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(
                200,
                {
                    "users": [
                        _user_payload(42.5, input_tokens=100, output_tokens=50, requests=10)
                    ]
                },
            ),
            json_response(
                200,
                {
                    "users": [
                        _user_payload(
                            0, input_tokens=50000, output_tokens=12000, requests=25
                        )
                    ]
                },
            ),
        ]
    )
    result = fetch_cursor_spend(
        DateWindow("2026-01-01", "2026-03-01"), "test-key", transport=transport, sleep=no_sleep
    )
    assert transport.call_count == 2
    assert len(result.users) == 1
    assert result.users[0].is_estimated is True
    assert result.is_estimated is True


def test_fails_the_entire_call_if_any_chunk_fails_after_retries(no_sleep):
    transport = ScriptedTransport(
        [
            json_response(200, {"users": [_user_payload(10)]}),
            json_response(500, {}),
        ]
    )
    with pytest.raises(RetryExhaustedError):
        fetch_cursor_spend(
            DateWindow("2026-01-01", "2026-03-01"),
            "test-key",
            transport=transport,
            sleep=no_sleep,
        )

import json

import pytest

from teamspend.adapters.copilot import fetch_copilot_spend
from teamspend.errors import DataUnavailableError, InvalidCliArgError, RetryExhaustedError
from teamspend.types import DateWindow

from .conftest import ScriptedTransport, json_response


def _text_response(status, text):
    from teamspend.http_client import HttpResponse

    return HttpResponse(status=status, body=text.encode("utf-8"))


def _ndjson_response(users):
    body = "\n".join(json.dumps(u) for u in users)
    return _text_response(200, body)


def _report_response(download_links, day="2026-04-01"):
    return json_response(200, {"download_links": download_links, "report_day": day})


def test_normalizes_a_happy_path_response_against_the_fixture(fixtures_dir, no_sleep):
    fixture = json.loads((fixtures_dir / "copilot.fixture.json").read_text())
    transport = ScriptedTransport(
        [
            _report_response(["https://copilot-reports.github.com/report-1.ndjson"]),
            _ndjson_response(fixture["users"]),
        ]
    )

    result = fetch_copilot_spend(
        DateWindow("2026-04-01", "2026-04-01"),
        "test-token",
        "acme",
        transport=transport,
        sleep=no_sleep,
    )

    assert result.source == "copilot"
    assert len(result.users) == 2
    assert result.total_cost_usd == pytest.approx(842.5 * 0.01 + 315.0 * 0.01, abs=1e-5)
    # GitHub's Copilot metrics API has no native cost field at all, so every
    # result is estimated regardless of how clean the underlying numbers are.
    assert result.is_estimated is True
    assert result.users[0].user_email is None


def test_treats_a_404_report_for_the_day_as_zero_users(no_sleep):
    transport = ScriptedTransport([json_response(404, {})])
    result = fetch_copilot_spend(
        DateWindow("2026-04-01", "2026-04-01"),
        "test-token",
        "acme",
        transport=transport,
        sleep=no_sleep,
    )
    assert result.total_cost_usd == 0
    assert result.users == []
    assert result.is_estimated is True


def test_requests_one_report_per_day_and_sums_a_repeat_user_across_days(no_sleep):
    transport = ScriptedTransport(
        [
            _report_response(["https://copilot-reports.github.com/d1.ndjson"], "2026-04-01"),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 100,
                        "user_initiated_interaction_count": 5,
                    }
                ]
            ),
            _report_response(["https://copilot-reports.github.com/d2.ndjson"], "2026-04-02"),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 50,
                        "user_initiated_interaction_count": 3,
                    }
                ]
            ),
        ]
    )

    result = fetch_copilot_spend(
        DateWindow("2026-04-01", "2026-04-02"),
        "test-token",
        "acme",
        transport=transport,
        sleep=no_sleep,
    )

    assert transport.call_count == 4
    assert len(result.users) == 1
    assert result.users[0].requests == 8
    assert result.total_cost_usd == pytest.approx(1.5, abs=1e-5)


def test_fetches_multiple_download_links_for_a_single_day_and_merges_them(no_sleep):
    transport = ScriptedTransport(
        [
            _report_response(
                [
                    "https://copilot-reports.github.com/part-1.ndjson",
                    "https://copilot-reports.github.com/part-2.ndjson",
                ]
            ),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 100,
                        "user_initiated_interaction_count": 5,
                    }
                ]
            ),
            _ndjson_response(
                [
                    {
                        "user_id": 2,
                        "user_login": "b",
                        "ai_credits_used": 20,
                        "user_initiated_interaction_count": 1,
                    }
                ]
            ),
        ]
    )

    result = fetch_copilot_spend(
        DateWindow("2026-04-01", "2026-04-01"),
        "test-token",
        "acme",
        transport=transport,
        sleep=no_sleep,
    )

    assert len(result.users) == 2
    assert result.total_cost_usd == pytest.approx(1.2, abs=1e-5)


def test_auth_failure_on_report_call_raises(no_sleep):
    from teamspend.errors import AuthenticationError

    transport = ScriptedTransport([json_response(401, {})])
    with pytest.raises(AuthenticationError):
        fetch_copilot_spend(
            DateWindow("2026-04-01", "2026-04-01"),
            "bad-token",
            "acme",
            transport=transport,
            sleep=no_sleep,
        )


def test_translates_expired_download_link_auth_failure_into_a_clear_message(no_sleep):
    transport = ScriptedTransport(
        [
            _report_response(["https://copilot-reports.github.com/expired.ndjson"]),
            json_response(403, {}),
        ]
    )

    with pytest.raises(RuntimeError, match="download link for 2026-04-01 was rejected"):
        fetch_copilot_spend(
            DateWindow("2026-04-01", "2026-04-01"),
            "test-token",
            "acme",
            transport=transport,
            sleep=no_sleep,
        )


def test_fails_the_entire_call_if_a_report_call_fails_after_retries(no_sleep):
    transport = ScriptedTransport([json_response(500, {})])
    with pytest.raises(RetryExhaustedError):
        fetch_copilot_spend(
            DateWindow("2026-04-01", "2026-04-01"),
            "test-token",
            "acme",
            transport=transport,
            sleep=no_sleep,
        )


def test_raises_data_unavailable_before_the_metrics_start_date_without_calling_the_api(no_sleep):
    transport = ScriptedTransport([])
    with pytest.raises(DataUnavailableError):
        fetch_copilot_spend(
            DateWindow("2025-09-01", "2025-09-05"),
            "test-token",
            "acme",
            transport=transport,
            sleep=no_sleep,
        )
    assert transport.call_count == 0


def test_adds_an_optional_seat_price_once_per_user_not_once_per_day(no_sleep):
    transport = ScriptedTransport(
        [
            _report_response(["https://copilot-reports.github.com/d.ndjson"], "2026-04-01"),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 0,
                        "user_initiated_interaction_count": 0,
                    }
                ]
            ),
            _report_response(["https://copilot-reports.github.com/d.ndjson"], "2026-04-02"),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 0,
                        "user_initiated_interaction_count": 0,
                    }
                ]
            ),
            _report_response(["https://copilot-reports.github.com/d.ndjson"], "2026-04-03"),
            _ndjson_response(
                [
                    {
                        "user_id": 1,
                        "user_login": "a",
                        "ai_credits_used": 0,
                        "user_initiated_interaction_count": 0,
                    }
                ]
            ),
        ]
    )

    result = fetch_copilot_spend(
        DateWindow("2026-04-01", "2026-04-03"),
        "test-token",
        "acme",
        19,
        transport=transport,
        sleep=no_sleep,
    )

    assert len(result.users) == 1
    # 3 days in the window, but the $19 seat price must appear exactly once.
    assert result.users[0].cost_usd == 19
    assert result.is_estimated is True


def test_rejects_a_negative_seat_price(no_sleep):
    transport = ScriptedTransport([])
    with pytest.raises(InvalidCliArgError):
        fetch_copilot_spend(
            DateWindow("2026-04-01", "2026-04-01"),
            "test-token",
            "acme",
            -5,
            transport=transport,
            sleep=no_sleep,
        )
    assert transport.call_count == 0

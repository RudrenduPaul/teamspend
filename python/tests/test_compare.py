import pytest

from teamspend.compare import PeriodOutcome, build_comparison
from teamspend.types import AdapterResult, DateWindow, UserUsage


def _result(source, total_cost_usd, users=None):
    return AdapterResult(
        source=source,
        window=DateWindow("2026-01-01", "2026-01-31"),
        total_cost_usd=total_cost_usd,
        is_estimated=False,
        users=users or [],
    )


def test_computes_delta_and_percent_when_both_periods_succeed():
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 130), None)

    report = build_comparison(before, after)
    assert report.delta_usd == 30
    assert report.delta_percent == pytest.approx(30, abs=1e-5)


def test_reports_both_windows_empty_explicitly_not_as_a_failure():
    before = PeriodOutcome("before", "cursor", _result("cursor", 0), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 0), None)

    report = build_comparison(before, after)
    assert report.delta_usd == 0
    assert report.before.result.total_cost_usd == 0
    assert report.after.result.total_cost_usd == 0


def test_marks_delta_unavailable_never_silently_omitting_the_failed_side():
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", None, Exception("boom"))

    report = build_comparison(before, after)
    assert report.delta_usd is None
    assert report.delta_percent is None
    assert str(report.after.error) == "boom"


def test_shows_all_available_spenders_when_fewer_than_5_exist_not_padded():
    users = [
        UserUsage(
            user_id="1",
            user_email="a@x.com",
            input_tokens=0,
            output_tokens=0,
            cache_read_tokens=0,
            cache_write_tokens=0,
            requests=0,
            cost_usd=10,
            is_estimated=False,
        )
    ]
    before = PeriodOutcome("before", "cursor", _result("cursor", 10, users), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 0), None)

    report = build_comparison(before, after)
    assert len(report.top_spenders_across_both) == 1

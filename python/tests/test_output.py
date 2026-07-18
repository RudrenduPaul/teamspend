import json
import os
import stat

from teamspend.compare import PeriodOutcome, build_comparison
from teamspend.output import render_terminal_summary, scaffold_gitignore, write_json_report
from teamspend.types import AdapterResult, DateWindow, SessionUsage, UserUsage


def _result(source, total_cost_usd, users=None):
    return AdapterResult(
        source=source,
        window=DateWindow("2026-01-01", "2026-01-31"),
        total_cost_usd=total_cost_usd,
        is_estimated=False,
        users=users or [],
    )


def test_strips_control_characters_from_a_user_email_sourced_from_the_live_api_not_just_csv_import():
    malicious_user = UserUsage(
        user_id="u_evil",
        user_email="\x1b[31mevil@x.com",
        input_tokens=None,
        output_tokens=None,
        cache_read_tokens=None,
        cache_write_tokens=None,
        requests=None,
        cost_usd=999,
        is_estimated=False,
    )
    before = PeriodOutcome("before", "cursor", _result("cursor", 999, [malicious_user]), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 0), None)
    report = build_comparison(before, after)

    output = render_terminal_summary(report)
    assert "\x1b" not in output
    assert "evil@x.com" in output


def test_omits_session_breakdown_when_not_requested_even_if_the_result_has_session_data():
    sessions = [
        SessionUsage(
            session_id="sess-1",
            cost_usd=5,
            input_tokens=100,
            output_tokens=50,
            requests=2,
            is_estimated=False,
        )
    ]
    user = UserUsage(
        user_id="local-user",
        user_email=None,
        input_tokens=100,
        output_tokens=50,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=2,
        cost_usd=5,
        is_estimated=False,
        sessions=sessions,
    )
    before = PeriodOutcome(
        "before", "claude-code-personal", _result("cursor", 5, [user]), None
    )
    after = PeriodOutcome(
        "after", "claude-code-personal", _result("cursor", 5, [user]), None
    )
    report = build_comparison(before, after)

    # No breakdown argument at all -- the exact call shape every
    # pre-existing caller of render_terminal_summary already uses.
    output = render_terminal_summary(report)
    assert "SESSION BREAKDOWN" not in output
    assert "sess-1" not in output


def test_prints_a_per_session_cost_table_sorted_by_cost_descending_when_breakdown_session_is_requested():
    sessions = [
        SessionUsage(
            session_id="cheap-session",
            cost_usd=1,
            input_tokens=10,
            output_tokens=5,
            requests=1,
            is_estimated=False,
        ),
        SessionUsage(
            session_id="expensive-session",
            cost_usd=9,
            input_tokens=900,
            output_tokens=400,
            requests=3,
            is_estimated=True,
        ),
    ]
    user = UserUsage(
        user_id="local-user",
        user_email=None,
        input_tokens=910,
        output_tokens=405,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=4,
        cost_usd=10,
        is_estimated=True,
        sessions=sessions,
    )
    before = PeriodOutcome(
        "before", "claude-code-personal", _result("cursor", 10, [user]), None
    )
    after = PeriodOutcome(
        "after", "claude-code-personal", _result("cursor", 10, [user]), None
    )
    report = build_comparison(before, after)

    output = render_terminal_summary(report, "session")
    assert "SESSION BREAKDOWN" in output
    expensive_index = output.index("expensive-session")
    cheap_index = output.index("cheap-session")
    assert expensive_index < cheap_index
    assert "$9.00" in output
    assert "$1.00" in output
    assert "(estimated)" in output


def test_strips_control_characters_from_a_session_id_sourced_from_a_local_log_same_as_user_email():
    sessions = [
        SessionUsage(
            session_id="\x1b[31mevil-session",
            cost_usd=5,
            input_tokens=100,
            output_tokens=50,
            requests=1,
            is_estimated=False,
        )
    ]
    user = UserUsage(
        user_id="local-user",
        user_email=None,
        input_tokens=100,
        output_tokens=50,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=1,
        cost_usd=5,
        is_estimated=False,
        sessions=sessions,
    )
    before = PeriodOutcome(
        "before", "claude-code-personal", _result("cursor", 5, [user]), None
    )
    after = PeriodOutcome(
        "after", "claude-code-personal", _result("cursor", 5, [user]), None
    )
    report = build_comparison(before, after)

    output = render_terminal_summary(report, "session")
    assert "\x1b" not in output
    assert "evil-session" in output


def test_explains_why_no_breakdown_is_available_for_an_admin_api_based_adapter():
    admin_api_user = UserUsage(
        user_id="u1",
        user_email="a@x.com",
        input_tokens=100,
        output_tokens=50,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=5,
        cost_usd=20,
        is_estimated=False,
        # No `sessions` -- matches what cursor.py/claude_code.py/copilot.py
        # actually produce, since their APIs report aggregate totals only.
    )
    before = PeriodOutcome("before", "cursor", _result("cursor", 20, [admin_api_user]), None)
    after = PeriodOutcome(
        "after", "claude-code", _result("claude-code", 20, [admin_api_user]), None
    )
    report = build_comparison(before, after)

    output = render_terminal_summary(report, "session")
    assert "SESSION BREAKDOWN: not available for cursor" in output
    assert "SESSION BREAKDOWN: not available for claude-code" in output
    assert "SESSION BREAKDOWN (top" not in output


def test_reports_no_session_activity_when_the_adapter_supports_sessions_but_none_fell_in_window():
    user_with_empty_sessions = UserUsage(
        user_id="local-user",
        user_email=None,
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=0,
        requests=0,
        cost_usd=0,
        is_estimated=False,
        sessions=[],
    )
    before = PeriodOutcome(
        "before", "claude-code-personal", _result("cursor", 0, [user_with_empty_sessions]), None
    )
    after = PeriodOutcome(
        "after", "claude-code-personal", _result("cursor", 0, [user_with_empty_sessions]), None
    )
    report = build_comparison(before, after)

    output = render_terminal_summary(report, "session")
    assert "no session activity in this window" in output
    assert "not available for" not in output


def test_shows_data_unavailable_for_a_failed_period_instead_of_silently_omitting_it():
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", None, Exception("auth failed"))
    report = build_comparison(before, after)

    output = render_terminal_summary(report)
    assert "DATA UNAVAILABLE: auth failed" in output
    assert "DELTA: unavailable" in output


def test_always_writes_a_json_file_with_a_timestamped_name(tmp_path):
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 130), None)
    report = build_comparison(before, after)

    json_path = write_json_report(report, str(tmp_path))
    assert json_path.endswith(".json")
    assert "teamspend-snapshot-" in json_path

    contents = json.loads(open(json_path, encoding="utf-8").read())
    assert contents["deltaUsd"] == 30


def test_restricts_the_report_file_to_owner_read_write_only(tmp_path):
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 130), None)
    report = build_comparison(before, after)

    json_path = write_json_report(report, str(tmp_path))
    mode = stat.S_IMODE(os.stat(json_path).st_mode)
    assert mode == 0o600


def test_scaffolds_a_gitignore_entry_when_none_exists(tmp_path):
    scaffolded = scaffold_gitignore(str(tmp_path))
    assert scaffolded is True

    contents = (tmp_path / ".gitignore").read_text(encoding="utf-8")
    assert "teamspend-snapshot-*.json" in contents


def test_does_not_duplicate_the_entry_or_re_warn_on_a_second_run(tmp_path):
    scaffold_gitignore(str(tmp_path))
    second_run = scaffold_gitignore(str(tmp_path))
    assert second_run is False

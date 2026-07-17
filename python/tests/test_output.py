import json
import os
import re
import stat

from teamspend.compare import PeriodOutcome, build_comparison
from teamspend.output import render_terminal_summary, scaffold_gitignore, write_json_report
from teamspend.types import AdapterResult, DateWindow, UserUsage


def _result(source, total_cost_usd):
    return AdapterResult(
        source=source,
        window=DateWindow("2026-01-01", "2026-01-31"),
        total_cost_usd=total_cost_usd,
        is_estimated=False,
        users=[],
    )


def test_shows_data_unavailable_for_a_failed_period_instead_of_silently_omitting_it():
    before = PeriodOutcome("before", "cursor", _result("cursor", 100), None)
    after = PeriodOutcome("after", "claude-code", None, Exception("auth failed"))
    report = build_comparison(before, after)

    output = render_terminal_summary(report)
    assert "DATA UNAVAILABLE: auth failed" in output
    assert "DELTA: unavailable" in output


def test_strips_control_characters_from_a_live_vendor_api_user_email_before_printing():
    malicious_user = UserUsage(
        user_id="u1",
        user_email="evil\x1b[2J\x1b]8;;https://evil.example\x07spoofed\x07@x.com",
        input_tokens=None,
        output_tokens=None,
        cache_read_tokens=None,
        cache_write_tokens=None,
        requests=None,
        cost_usd=100,
        is_estimated=False,
    )
    malicious_result = AdapterResult(
        source="cursor",
        window=DateWindow("2026-01-01", "2026-01-31"),
        total_cost_usd=100,
        is_estimated=False,
        users=[malicious_user],
    )
    before = PeriodOutcome("before", "cursor", malicious_result, None)
    after = PeriodOutcome("after", "claude-code", _result("claude-code", 50), None)
    report = build_comparison(before, after)

    output = render_terminal_summary(report)
    top_spenders_line = next(line for line in output.split("\n") if "evil" in line)
    assert not re.search("[\x00-\x1f]", top_spenders_line)
    assert "evil" in top_spenders_line
    assert "spoofed" in top_spenders_line


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

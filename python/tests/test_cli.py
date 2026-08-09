import json

import pytest

import teamspend
import teamspend.http_client as http_client
from teamspend.cli import run


def test_module_version_matches_cli_version_flag(capsys):
    """Regression: teamspend.__version__ was a separate hardcoded string
    ("0.1.0") that had drifted from the real installed version, even after
    the CLI's own --version flag was fixed to read it dynamically. Both
    must report the same, real, installed version."""
    code = run(["--version"])
    assert code == 0
    cli_reported = capsys.readouterr().out.strip()
    assert cli_reported == f"teamspend {teamspend.__version__}"
    assert teamspend.__version__ != "0.1.0"


def test_rejects_an_unknown_tool_name(capsys):
    code = run(
        [
            "--tools",
            "cursor,unknown-tool",
            "--before",
            "2026-01-01:2026-01-31",
            "--after",
            "2026-02-01:2026-02-28",
        ]
    )
    assert code == 1
    assert 'Unknown tool "unknown-tool"' in capsys.readouterr().err


def test_rejects_a_malformed_date(capsys):
    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "not-a-date",
            "--after",
            "2026-02-01:2026-02-28",
        ]
    )
    assert code == 1
    assert "--before must be in the form" in capsys.readouterr().err


def test_rejects_before_later_than_or_equal_to_after(capsys):
    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2026-03-01:2026-03-31",
            "--after",
            "2026-02-01:2026-02-28",
        ]
    )
    assert code == 1
    assert "must be earlier than" in capsys.readouterr().err


def test_shows_usage_text_when_required_flags_are_missing(capsys):
    code = run([])
    assert code == 1
    assert "Usage: teamspend" in capsys.readouterr().err


def test_runs_end_to_end_with_both_adapters_succeeding_and_writes_the_json_report(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TEAMSPEND_CURSOR_TOKEN", "test-cursor-key")
    monkeypatch.setenv("TEAMSPEND_CLAUDE_CODE_TOKEN", "test-claude-key")

    def fake_transport(url, headers, timeout):
        body = json.dumps(
            {
                "users": [
                    {
                        "user_id": "u1",
                        "email": "a@x.com",
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "requests": 1,
                        "cost_usd": 10,
                        "spend_usd": 10,
                    }
                ]
            }
        ).encode("utf-8")
        return http_client.HttpResponse(status=200, body=body)

    monkeypatch.setattr(http_client, "default_transport", fake_transport)

    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2026-06-01:2026-06-30",
            "--after",
            "2026-07-01:2026-07-31",
        ]
    )
    assert code == 0

    report_files = list(tmp_path.glob("teamspend-snapshot-*.json"))
    assert len(report_files) == 1


def test_falls_back_to_before_csv_when_the_tool_api_token_is_simply_missing(
    tmp_path, monkeypatch
):
    """Regression: the missing-token check raised a plain RuntimeError that
    bypassed the DataUnavailableError CSV fallback, so --before-csv was
    silently ignored whenever the token was simply unset (not just when the
    window predated API history)."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TEAMSPEND_CURSOR_TOKEN", raising=False)
    monkeypatch.setenv("TEAMSPEND_CLAUDE_CODE_TOKEN", "test-claude-key")

    def fake_transport(url, headers, timeout):
        body = json.dumps(
            {
                "users": [
                    {
                        "user_id": "u1",
                        "email": "a@x.com",
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "requests": 1,
                        "cost_usd": 10,
                        "spend_usd": 10,
                    }
                ]
            }
        ).encode("utf-8")
        return http_client.HttpResponse(status=200, body=body)

    monkeypatch.setattr(http_client, "default_transport", fake_transport)

    csv_path = tmp_path / "before.csv"
    csv_path.write_text(
        "date,user_email,cost_usd,is_estimated\n"
        "2025-11-01,jane@example.com,12.50,false\n"
    )

    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2025-11-01:2025-11-30",
            "--after",
            "2026-07-01:2026-07-31",
            "--before-csv",
            str(csv_path),
        ]
    )
    assert code == 0

    report_files = list(tmp_path.glob("teamspend-snapshot-*.json"))
    assert len(report_files) == 1
    report = json.loads(report_files[0].read_text())
    before_users = report["before"]["result"]["users"]
    assert before_users[0]["userEmail"] == "jane@example.com"
    assert before_users[0]["costUsd"] == 12.5


def test_still_reports_data_unavailable_naming_missing_token_when_no_csv_fallback(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TEAMSPEND_CURSOR_TOKEN", raising=False)
    monkeypatch.setenv("TEAMSPEND_CLAUDE_CODE_TOKEN", "test-claude-key")

    def fake_transport(url, headers, timeout):
        body = json.dumps({"users": []}).encode("utf-8")
        return http_client.HttpResponse(status=200, body=body)

    monkeypatch.setattr(http_client, "default_transport", fake_transport)

    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2026-06-01:2026-06-30",
            "--after",
            "2026-07-01:2026-07-31",
        ]
    )
    assert code == 1

    out = capsys.readouterr().out
    assert "DATA UNAVAILABLE" in out
    assert "TEAMSPEND_CURSOR_TOKEN" in out


def test_rejects_an_unrecognized_breakdown_value(capsys):
    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2026-01-01:2026-01-31",
            "--after",
            "2026-02-01:2026-02-28",
            "--breakdown",
            "bogus",
        ]
    )
    assert code == 1
    assert "--breakdown must be one of" in capsys.readouterr().err


def _write_claude_code_personal_fixture(tmp_path, monkeypatch):
    projects_dir = tmp_path / "claude-config" / "projects" / "proj"
    projects_dir.mkdir(parents=True)
    lines = [
        {
            "timestamp": "2026-06-05T10:00:00.000Z",
            "sessionId": "before-session",
            "message": {"id": "m1", "usage": {"input_tokens": 100, "output_tokens": 20}},
            "requestId": "r1",
            "costUSD": 0.5,
        },
        {
            "timestamp": "2026-06-20T10:00:00.000Z",
            "sessionId": "after-session",
            "message": {"id": "m2", "usage": {"input_tokens": 200, "output_tokens": 40}},
            "requestId": "r2",
            "costUSD": 1.5,
        },
    ]
    (projects_dir / "session.jsonl").write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n"
    )
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-config" / "projects"))


def _read_written_report(tmp_path):
    report_files = list(tmp_path.glob("teamspend-snapshot-*.json"))
    assert len(report_files) == 1
    return json.loads(report_files[0].read_text(encoding="utf-8"))


def test_prints_a_per_session_table_and_includes_sessions_in_json_report_for_an_adapter_with_real_session_data(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    _write_claude_code_personal_fixture(tmp_path, monkeypatch)

    code = run(
        [
            "--tools",
            "claude-code-personal,claude-code-personal",
            "--before",
            "2026-06-01:2026-06-10",
            "--after",
            "2026-06-11:2026-06-30",
            "--breakdown",
            "session",
        ]
    )
    assert code == 0

    terminal_output = capsys.readouterr().out
    assert "SESSION BREAKDOWN" in terminal_output
    assert "before-session" in terminal_output
    assert "after-session" in terminal_output

    report = _read_written_report(tmp_path)
    assert "sessions" in report["before"]["result"]["users"][0]
    assert "sessions" in report["after"]["result"]["users"][0]


def test_does_not_include_sessions_in_json_report_when_breakdown_session_is_not_passed(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    _write_claude_code_personal_fixture(tmp_path, monkeypatch)

    code = run(
        [
            "--tools",
            "claude-code-personal,claude-code-personal",
            "--before",
            "2026-06-01:2026-06-10",
            "--after",
            "2026-06-11:2026-06-30",
        ]
    )
    assert code == 0

    terminal_output = capsys.readouterr().out
    assert "SESSION BREAKDOWN" not in terminal_output

    report = _read_written_report(tmp_path)
    assert "sessions" not in report["before"]["result"]["users"][0]


def test_prints_a_clear_explanation_not_a_fake_breakdown_when_tools_have_no_session_data(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TEAMSPEND_CURSOR_TOKEN", "test-cursor-key")
    monkeypatch.setenv("TEAMSPEND_CLAUDE_CODE_TOKEN", "test-claude-key")

    def fake_transport(url, headers, timeout):
        body = json.dumps(
            {
                "users": [
                    {
                        "user_id": "u1",
                        "email": "a@x.com",
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "cache_read_tokens": 0,
                        "cache_write_tokens": 0,
                        "requests": 1,
                        "cost_usd": 10,
                        "spend_usd": 10,
                    }
                ]
            }
        ).encode("utf-8")
        return http_client.HttpResponse(status=200, body=body)

    monkeypatch.setattr(http_client, "default_transport", fake_transport)

    code = run(
        [
            "--tools",
            "cursor,claude-code",
            "--before",
            "2026-06-01:2026-06-30",
            "--after",
            "2026-07-01:2026-07-31",
            "--breakdown",
            "session",
        ]
    )
    assert code == 0

    terminal_output = capsys.readouterr().out
    assert "SESSION BREAKDOWN: not available for cursor" in terminal_output
    assert "SESSION BREAKDOWN: not available for claude-code" in terminal_output

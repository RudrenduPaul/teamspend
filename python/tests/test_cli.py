import json

import pytest

import teamspend.http_client as http_client
from teamspend.cli import run


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

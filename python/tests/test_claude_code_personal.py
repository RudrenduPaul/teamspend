import json

import pytest

from teamspend.adapters.claude_code_personal import fetch_claude_code_personal_usage
from teamspend.errors import DataUnavailableError
from teamspend.types import DateWindow


def _write_jsonl(path, *entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(e) for e in entries) + "\n")


def test_normalizes_a_happy_path_fixture_read_via_a_claude_config_dir_pointing_at_projects(
    tmp_path, monkeypatch, fixtures_dir
):
    fixture_text = (fixtures_dir / "claude-code-personal.fixture.jsonl").read_text()
    projects_dir = tmp_path / "projects" / "my-project"
    projects_dir.mkdir(parents=True)
    (projects_dir / "session.jsonl").write_text(fixture_text)

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "projects"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.source == "claude-code-personal"
    assert len(result.users) == 1
    assert result.total_cost_usd == pytest.approx(0.045 + 0.081 + 0.204, abs=0.001)
    assert result.is_estimated is False
    assert result.users[0].requests == 3
    assert result.users[0].user_email is None


def test_accepts_a_claude_config_dir_entry_that_is_the_parent_config_dir(
    tmp_path, monkeypatch
):
    projects_dir = tmp_path / "config" / "projects" / "proj"
    _write_jsonl(
        projects_dir / "session.jsonl",
        {
            "timestamp": "2026-06-05T10:00:00.000Z",
            "message": {
                "id": "m1",
                "usage": {"input_tokens": 10, "output_tokens": 5},
            },
            "requestId": "r1",
            "costUSD": 0.01,
        },
    )

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "config"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))
    assert result.total_cost_usd == pytest.approx(0.01, abs=0.001)


def test_flags_a_line_missing_costusd_as_estimated_without_losing_token_counts(
    tmp_path, monkeypatch
):
    projects_dir = tmp_path / "projects" / "proj"
    _write_jsonl(
        projects_dir / "session.jsonl",
        {
            "timestamp": "2026-06-05T10:00:00.000Z",
            "message": {
                "id": "m1",
                "usage": {"input_tokens": 100, "output_tokens": 50},
            },
            "requestId": "r1",
            # No costUSD field at all.
        },
    )

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "projects"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.users[0].is_estimated is True
    assert result.is_estimated is True
    assert result.users[0].input_tokens == 100
    assert result.users[0].cost_usd == 0


def test_dedupes_a_retried_entry_sharing_the_same_message_id_request_id_pair(
    tmp_path, monkeypatch
):
    entry = {
        "timestamp": "2026-06-05T10:00:00.000Z",
        "message": {
            "id": "m-retry",
            "usage": {"input_tokens": 100, "output_tokens": 50},
        },
        "requestId": "r-retry",
        "costUSD": 0.02,
    }
    projects_dir = tmp_path / "projects" / "proj"
    # Same entry written twice, simulating a retried request appearing
    # twice in the log.
    _write_jsonl(projects_dir / "session.jsonl", entry, entry)

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "projects"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.users[0].requests == 1
    assert result.total_cost_usd == pytest.approx(0.02, abs=0.001)


def test_filters_out_entries_outside_the_requested_date_window(tmp_path, monkeypatch):
    in_window = {
        "timestamp": "2026-06-15T10:00:00.000Z",
        "message": {"id": "m-in", "usage": {"input_tokens": 10, "output_tokens": 5}},
        "requestId": "r-in",
        "costUSD": 0.03,
    }
    out_of_window = {
        "timestamp": "2026-05-01T10:00:00.000Z",
        "message": {
            "id": "m-out",
            "usage": {"input_tokens": 999, "output_tokens": 999},
        },
        "requestId": "r-out",
        "costUSD": 99,
    }
    projects_dir = tmp_path / "projects" / "proj"
    _write_jsonl(projects_dir / "session.jsonl", in_window, out_of_window)

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "projects"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.users[0].requests == 1
    assert result.total_cost_usd == pytest.approx(0.03, abs=0.001)


def test_collects_entries_from_nested_subagents_subdirectories(tmp_path, monkeypatch):
    subagents_dir = tmp_path / "projects" / "proj" / "subagents"
    _write_jsonl(
        subagents_dir / "sub-session.jsonl",
        {
            "timestamp": "2026-06-05T10:00:00.000Z",
            "message": {
                "id": "m-sub",
                "usage": {"input_tokens": 20, "output_tokens": 10},
            },
            "requestId": "r-sub",
            "costUSD": 0.004,
        },
    )

    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "projects"))

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.users[0].requests == 1
    assert result.total_cost_usd == pytest.approx(0.004, abs=0.001)


def test_raises_data_unavailable_error_naming_the_resolved_directory_when_no_logs_exist(
    tmp_path, monkeypatch
):
    monkeypatch.setenv(
        "CLAUDE_CONFIG_DIR", str(tmp_path / "nonexistent" / "projects")
    )

    with pytest.raises(DataUnavailableError) as exc_info:
        fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert "nonexistent" in str(exc_info.value)
    assert "projects" in str(exc_info.value)


def test_scans_every_entry_in_a_comma_separated_claude_config_dir_list(
    tmp_path, monkeypatch
):
    dir_a = tmp_path / "config-a" / "projects" / "p"
    dir_b = tmp_path / "config-b" / "projects" / "p"
    _write_jsonl(
        dir_a / "a.jsonl",
        {
            "timestamp": "2026-06-02T10:00:00.000Z",
            "message": {"id": "ma", "usage": {"input_tokens": 1, "output_tokens": 1}},
            "requestId": "ra",
            "costUSD": 0.01,
        },
    )
    _write_jsonl(
        dir_b / "b.jsonl",
        {
            "timestamp": "2026-06-03T10:00:00.000Z",
            "message": {"id": "mb", "usage": {"input_tokens": 1, "output_tokens": 1}},
            "requestId": "rb",
            "costUSD": 0.02,
        },
    )

    monkeypatch.setenv(
        "CLAUDE_CONFIG_DIR",
        f"{tmp_path / 'config-a'}, {tmp_path / 'config-b'}",
    )

    result = fetch_claude_code_personal_usage(DateWindow("2026-06-01", "2026-06-30"))

    assert result.users[0].requests == 2
    assert result.total_cost_usd == pytest.approx(0.03, abs=0.001)

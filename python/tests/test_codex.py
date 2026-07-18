import json

import pytest

from teamspend.adapters.codex import fetch_codex_usage, resolve_codex_sessions_dirs
from teamspend.errors import DataUnavailableError
from teamspend.types import DateWindow


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def test_normalizes_a_happy_path_fixture_read_deduping_the_doubled_token_count_event(
    tmp_path, fixtures_dir
):
    fixture_text = (fixtures_dir / "codex.fixture.jsonl").read_text()
    session_dir = tmp_path / "sessions" / "2026" / "06" / "05"
    _write(session_dir / "rollout-2026-06-05T10-00-00-abc123.jsonl", fixture_text)

    result = fetch_codex_usage(
        DateWindow("2026-06-01", "2026-06-30"), [str(tmp_path / "sessions")]
    )

    assert result.source == "codex"
    assert len(result.users) == 1
    # The 10:00:05 token_count event is emitted twice, byte-identical, and
    # must be counted once: input net = 1200 - 400 = 800, output = 300.
    # The 10:02:00 event is distinct: input net = 1200 - 500 = 700,
    # output = 250. The 2026-05-01 event falls outside the window.
    assert result.users[0].requests == 2
    assert result.users[0].input_tokens == 800 + 700
    assert result.users[0].output_tokens == 300 + 250
    assert result.users[0].cache_read_tokens == 400 + 500
    assert result.users[0].cache_write_tokens == 0
    assert result.users[0].user_email is None


def test_always_reports_zero_cost_and_is_estimated_true(tmp_path, fixtures_dir):
    fixture_text = (fixtures_dir / "codex.fixture.jsonl").read_text()
    session_dir = tmp_path / "sessions"
    _write(session_dir / "rollout-a.jsonl", fixture_text)

    result = fetch_codex_usage(
        DateWindow("2026-06-01", "2026-06-30"), [str(session_dir)]
    )

    assert result.total_cost_usd == 0
    assert result.is_estimated is True
    assert result.users[0].cost_usd == 0
    assert result.users[0].is_estimated is True


def test_excludes_token_count_events_outside_the_requested_window(tmp_path, fixtures_dir):
    fixture_text = (fixtures_dir / "codex.fixture.jsonl").read_text()
    session_dir = tmp_path / "sessions"
    _write(session_dir / "rollout-a.jsonl", fixture_text)

    result = fetch_codex_usage(
        DateWindow("2026-05-01", "2026-05-31"), [str(session_dir)]
    )

    # Only the 2026-05-01 event falls in this window.
    assert len(result.users) == 1
    assert result.users[0].requests == 1
    assert result.users[0].input_tokens == 9999
    assert result.users[0].output_tokens == 9999


def test_skips_a_corrupt_partially_written_line_without_failing_the_whole_read(
    tmp_path, fixtures_dir
):
    fixture_text = (fixtures_dir / "codex.fixture.jsonl").read_text()
    session_dir = tmp_path / "sessions"
    _write(session_dir / "rollout-a.jsonl", fixture_text)

    result = fetch_codex_usage(
        DateWindow("2026-01-01", "2026-12-31"), [str(session_dir)]
    )
    assert result is not None


def test_returns_empty_non_estimated_result_when_nothing_falls_in_window(
    tmp_path, fixtures_dir
):
    fixture_text = (fixtures_dir / "codex.fixture.jsonl").read_text()
    session_dir = tmp_path / "sessions"
    _write(session_dir / "rollout-a.jsonl", fixture_text)

    result = fetch_codex_usage(
        DateWindow("2020-01-01", "2020-01-31"), [str(session_dir)]
    )

    assert len(result.users) == 0
    assert result.total_cost_usd == 0
    assert result.is_estimated is False


def test_ignores_compressed_jsonl_zst_rollout_files(tmp_path):
    session_dir = tmp_path / "sessions"
    # Not real zstd bytes -- the point of this test is that this file must
    # never even be picked up as a candidate, not that decoding fails.
    _write(session_dir / "rollout-old.jsonl.zst", "not-real-zstd-bytes")

    with pytest.raises(DataUnavailableError):
        fetch_codex_usage(DateWindow("2026-06-01", "2026-06-30"), [str(session_dir)])


def test_scans_both_sessions_and_archived_sessions_directories(tmp_path):
    sessions_dir = tmp_path / "sessions"
    archived_dir = tmp_path / "archived_sessions"
    sessions_dir.mkdir(parents=True)
    archived_dir.mkdir(parents=True)

    entry = {
        "timestamp": "2026-06-10T00:00:00.000Z",
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 0,
                    "output_tokens": 20,
                    "reasoning_output_tokens": 0,
                    "total_tokens": 120,
                },
                "last_token_usage": {
                    "input_tokens": 100,
                    "cached_input_tokens": 0,
                    "output_tokens": 20,
                    "reasoning_output_tokens": 0,
                    "total_tokens": 120,
                },
            },
        },
    }
    _write(archived_dir / "rollout-archived.jsonl", json.dumps(entry) + "\n")

    result = fetch_codex_usage(
        DateWindow("2026-06-01", "2026-06-30"),
        [str(sessions_dir), str(archived_dir)],
    )

    assert len(result.users) == 1
    assert result.users[0].requests == 1
    assert result.users[0].input_tokens == 100


def test_raises_data_unavailable_error_when_no_jsonl_logs_exist_anywhere(tmp_path):
    empty_dir = tmp_path / "sessions"

    with pytest.raises(DataUnavailableError):
        fetch_codex_usage(DateWindow("2026-06-01", "2026-06-30"), [str(empty_dir)])


def test_resolve_codex_sessions_dirs_defaults_to_dot_codex_when_codex_home_unset():
    dirs = resolve_codex_sessions_dirs({"HOME": "/home/dev"})
    assert dirs == [
        "/home/dev/.codex/sessions",
        "/home/dev/.codex/archived_sessions",
    ]


def test_resolve_codex_sessions_dirs_honors_codex_home_override_as_single_dir():
    dirs = resolve_codex_sessions_dirs(
        {"CODEX_HOME": "/custom/codex-home", "HOME": "/home/dev"}
    )
    assert dirs == [
        "/custom/codex-home/sessions",
        "/custom/codex-home/archived_sessions",
    ]

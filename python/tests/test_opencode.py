import json
import tempfile
from pathlib import Path

import pytest

from teamspend.adapters.opencode import fetch_opencode_spend, resolve_opencode_data_dirs
from teamspend.errors import DataUnavailableError
from teamspend.types import DateWindow

from .conftest import FIXTURES_DIR

OPENCODE_FIXTURE_DIR = str(FIXTURES_DIR / "opencode")


def test_normalizes_local_message_files_within_the_window_into_a_single_synthetic_user():
    result = fetch_opencode_spend(
        DateWindow("2026-06-01", "2026-06-30"), [OPENCODE_FIXTURE_DIR]
    )

    assert result.source == "opencode"
    # Two assistant messages fall inside the window (msg_ab12cd, msg_ab12cf);
    # the user-role message, the before-window message, and the corrupt file
    # are all excluded.
    assert len(result.users) == 1
    assert result.users[0].requests == 2
    assert result.users[0].input_tokens == 18240 + 9000
    assert result.users[0].output_tokens == 2310 + 1500
    assert result.users[0].cache_read_tokens == 12000
    assert result.users[0].cache_write_tokens == 3400
    assert result.total_cost_usd == pytest.approx(0.0842, abs=0.0001)
    assert result.users[0].user_email is None


def test_always_flags_opencode_results_as_estimated_even_with_nonzero_cost():
    result = fetch_opencode_spend(
        DateWindow("2026-06-01", "2026-06-30"), [OPENCODE_FIXTURE_DIR]
    )

    assert result.is_estimated is True
    assert result.users[0].is_estimated is True


def test_excludes_messages_outside_the_requested_window():
    result = fetch_opencode_spend(
        DateWindow("2026-05-01", "2026-05-31"), [OPENCODE_FIXTURE_DIR]
    )

    # Only msg_ff0011 (2026-05-20) falls in this window.
    assert len(result.users) == 1
    assert result.users[0].requests == 1
    assert result.total_cost_usd == pytest.approx(0.031, abs=0.0001)


def test_skips_a_corrupt_partially_written_message_file_without_failing_the_scan():
    # ses_7b03de44/msg_ff0012.json in the fixture directory is deliberately
    # truncated invalid JSON; if it weren't skipped this call would raise.
    result = fetch_opencode_spend(
        DateWindow("2026-01-01", "2026-12-31"), [OPENCODE_FIXTURE_DIR]
    )
    assert result is not None


def test_returns_empty_non_estimated_result_when_data_dir_exists_but_nothing_in_window():
    result = fetch_opencode_spend(
        DateWindow("2020-01-01", "2020-01-31"), [OPENCODE_FIXTURE_DIR]
    )

    assert result.users == []
    assert result.total_cost_usd == 0
    assert result.is_estimated is False


def test_raises_data_unavailable_error_when_no_data_directory_has_any_message_logs():
    with tempfile.TemporaryDirectory(prefix="teamspend-opencode-empty-") as empty_dir:
        with pytest.raises(DataUnavailableError):
            fetch_opencode_spend(DateWindow("2026-06-01", "2026-06-30"), [empty_dir])


def test_raises_data_unavailable_error_when_no_data_directories_resolve_at_all():
    with pytest.raises(DataUnavailableError):
        fetch_opencode_spend(DateWindow("2026-06-01", "2026-06-30"), [])


def test_resolve_defaults_to_local_share_opencode_under_home():
    dirs = resolve_opencode_data_dirs({"HOME": "/home/dev"})
    assert dirs == [str(Path("/home/dev", ".local", "share", "opencode"))]


def test_resolve_falls_back_to_userprofile_without_home():
    dirs = resolve_opencode_data_dirs({"USERPROFILE": "C:\\Users\\dev"})
    assert dirs == [str(Path("C:\\Users\\dev", ".local", "share", "opencode"))]


def test_resolve_parses_a_comma_separated_override_into_multiple_directories():
    dirs = resolve_opencode_data_dirs(
        {
            "OPENCODE_DATA_DIR": "/a/opencode, /b/opencode-stable",
            "HOME": "/home/dev",
        }
    )
    assert dirs == ["/a/opencode", "/b/opencode-stable"]


def test_resolve_returns_empty_list_when_neither_override_nor_home_is_set():
    assert resolve_opencode_data_dirs({}) == []


def test_reads_a_freshly_written_per_session_message_file_like_real_opencode_output():
    with tempfile.TemporaryDirectory(prefix="teamspend-opencode-live-") as data_dir:
        session_dir = Path(data_dir, "storage", "message", "ses_live1")
        session_dir.mkdir(parents=True)
        (session_dir / "msg_live1.json").write_text(
            json.dumps(
                {
                    "id": "msg_live1",
                    "sessionID": "ses_live1",
                    "role": "assistant",
                    "time": {"created": 1780704000000},  # 2026-06-05T12:00:00Z
                    "modelID": "claude-sonnet-4-5",
                    "providerID": "anthropic",
                    "cost": 0.01,
                    "tokens": {
                        "input": 100,
                        "output": 20,
                        "reasoning": 0,
                        "cache": {"read": 0, "write": 0},
                    },
                }
            ),
            encoding="utf-8",
        )

        result = fetch_opencode_spend(
            DateWindow("2026-06-01", "2026-06-30"), [data_dir]
        )
        assert len(result.users) == 1
        assert result.users[0].requests == 1
        assert result.total_cost_usd == pytest.approx(0.01, abs=0.0001)

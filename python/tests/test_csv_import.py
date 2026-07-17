import pytest

from teamspend.adapters.csv_import import import_from_csv
from teamspend.errors import CSVRowError, CSVSchemaError, EmptyCSVError
from teamspend.types import DateWindow


def test_parses_the_fixture_aggregating_per_user_across_multiple_rows(fixtures_dir):
    result = import_from_csv(
        str(fixtures_dir / "csv-import.fixture.csv"),
        "claude-code",
        DateWindow("2025-11-01", "2025-11-30"),
    )

    assert result.source == "claude-code"
    assert len(result.users) == 2

    chen = next(u for u in result.users if u.user_email == "r.chen@acme-corp.com")
    assert chen.cost_usd == pytest.approx(12.5 + 14.1, abs=0.01)
    assert chen.is_estimated is False

    kim = next(u for u in result.users if u.user_email == "j.kim@acme-corp.com")
    assert kim.is_estimated is True


def test_raises_csv_schema_error_when_required_columns_are_missing(tmp_path):
    csv_path = tmp_path / "bad-schema.csv"
    csv_path.write_text("date,cost_usd\n2025-11-01,12.5\n")
    with pytest.raises(CSVSchemaError):
        import_from_csv(str(csv_path), "cursor", DateWindow("2025-11-01", "2025-11-30"))


def test_raises_empty_csv_error_for_an_empty_file(tmp_path):
    csv_path = tmp_path / "empty.csv"
    csv_path.write_text("")
    with pytest.raises(EmptyCSVError):
        import_from_csv(str(csv_path), "cursor", DateWindow("2025-11-01", "2025-11-30"))


def test_raises_csv_row_error_instead_of_silently_producing_nan_for_a_malformed_cost(tmp_path):
    csv_path = tmp_path / "bad-cost.csv"
    csv_path.write_text(
        "date,user_email,cost_usd,is_estimated\n2025-11-01,a@x.com,not-a-number,false\n"
    )
    with pytest.raises(CSVRowError):
        import_from_csv(str(csv_path), "cursor", DateWindow("2025-11-01", "2025-11-30"))


def test_raises_csv_row_error_for_an_empty_user_email(tmp_path):
    csv_path = tmp_path / "bad-email.csv"
    csv_path.write_text("date,user_email,cost_usd,is_estimated\n2025-11-01,,12.50,false\n")
    with pytest.raises(CSVRowError):
        import_from_csv(str(csv_path), "cursor", DateWindow("2025-11-01", "2025-11-30"))


def test_strips_ansi_control_character_escape_sequences_from_a_csv_cell(tmp_path):
    csv_path = tmp_path / "ansi-injection.csv"
    # \x1b is ESC -- a crafted cell could otherwise inject terminal escape
    # sequences into the non-JSON summary output.
    csv_path.write_text(
        "date,user_email,cost_usd,is_estimated\n2025-11-01,evil\x1b[31m@x.com,12.50,false\n"
    )
    result = import_from_csv(str(csv_path), "cursor", DateWindow("2025-11-01", "2025-11-30"))
    assert result.users[0].user_email == "evil[31m@x.com"
    assert "\x1b" not in result.users[0].user_email

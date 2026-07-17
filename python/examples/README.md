# Python examples

Each numbered subdirectory is a real, runnable script against the actual
`teamspend` Python library (`from teamspend import fetch_cursor_spend, ...`),
not pseudocode. They replay the repo's own bundled fixtures under
`../fixtures/` (`cursor.fixture.json`, `claude-code.fixture.json`,
`csv-import.fixture.csv`) through an injectable `transport`, so nothing
external -- no API keys, no network access -- is required to run them.

Install the package first (editable install from this checkout, or `pip
install teamspend` from PyPI both work identically):

```bash
cd python
pip install -e .
```

Then run any example directly:

```bash
python3 examples/01-basic-comparison/compare.py
python3 examples/02-ci-gate/gate.py
python3 examples/03-csv-fallback/csv_fallback.py
```

| Example | What it demonstrates |
| --- | --- |
| [01-basic-comparison](./01-basic-comparison/) | The core library call: `fetch_cursor_spend()` + `fetch_claude_code_spend()` + `build_comparison()`, printing the same terminal summary the CLI prints. |
| [02-ci-gate](./02-ci-gate/) | Using `build_comparison()` as a CI gate: a configurable dollar-delta threshold, real process exit-code propagation, suitable to drop into a CI script directly. |
| [03-csv-fallback](./03-csv-fallback/) | The CSV-import fallback: what `DataUnavailableError` looks like for a window predating Claude Code's Analytics API start date, and how `import_from_csv()` fills that gap from the documented CSV schema. |

To run any of these against your own real data instead of the bundled
fixtures, drop the `transport=` keyword argument from the `fetch_*_spend()`
calls and set `TEAMSPEND_CURSOR_TOKEN` / `TEAMSPEND_CLAUDE_CODE_TOKEN` --
see [../README.md](../README.md#quickstart).

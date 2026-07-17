# Contributing to teamspend

teamspend ships two independently maintained, equally first-class
distributions of the same tool: an npm package (`teamspend`, TypeScript,
repo root) and a PyPI package (`teamspend`, Python, `python/`). Both talk
to the same two admin APIs (Cursor, Anthropic Claude Enterprise Analytics)
and are expected to produce the same normalized numbers against the same
input. Please read this whole file before opening a PR -- which section
applies depends on which codebase you're touching.

## Ground rules

- Every change lands with tests. Neither test suite is optional scaffolding
  -- both are the mechanism that keeps the two implementations in parity.
- An adapter change (a new field mapping, a changed suspicious-zero rule, a
  changed retry policy) must be made in **both** `src/adapters/`
  (TypeScript) and `python/src/teamspend/adapters/` (Python), with
  equivalent test coverage added to both suites. An adapter fix that only
  lands in one language is a silent behavior gap between the two CLIs --
  avoid it.
- Error messages and exit-code behavior should read identically between
  the two CLIs wherever the underlying behavior is the same. If you
  intentionally diverge the two, say so explicitly in the PR description.
- No `eval`/`exec` of anything derived from a vendor API response or an
  imported CSV. teamspend's adapters validate every field with
  `requireField`/`require_field` before use; a fix that starts trusting an
  unvalidated field is not a fix.
- teamspend prints and writes real per-user email and spend data. Any
  change to output formatting must keep the existing sensitivity notes
  (the `.gitignore` scaffolding, the CI-log warning, the `0600` file
  permission) intact unless the PR explicitly discusses removing them.

## Working on the TypeScript package (repo root)

```bash
npm install
npm run build
npm run lint
npm run typecheck
npm test
```

- Source lives under `src/`; adapters under `src/adapters/`; fixtures used
  by both the tests and the Python port's tests under `fixtures/`.
- Tests use `vitest` (`src/**/*.test.ts`, one file per module).
- `npm run build` compiles to `dist/`, which is what the `bin` entry
  (`teamspend`) and the library export both resolve to.

## Working on the Python package (`python/`)

```bash
cd python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

- Source lives under `python/src/teamspend/`, laid out to mirror the
  TypeScript module structure 1:1 (`adapters/`, `compare.py`, `output.py`,
  `cli.py`, `types.py`, `errors.py`, `http_client.py`) so a change in one
  codebase has an obvious counterpart to check in the other.
- Tests use `pytest` (`python/tests/test_*.py`, one file per module),
  reading the same `fixtures/*.json`/`*.csv` files the TypeScript tests
  use (copied into `python/fixtures/` since the published wheel and npm
  tarball each bundle only their own package's files).
- `http_client.fetch_with_retry` takes an injectable `transport` callable
  so tests can simulate arbitrary HTTP statuses and network failures
  without a real socket -- see `python/tests/conftest.py`'s
  `ScriptedTransport` for the pattern used throughout the adapter tests.

## Adding a new tool adapter

Both the roadmap items on the project README (GitHub Copilot, OpenCode)
and any other admin-API integration should follow the existing adapter
shape:

1. A `fetch_<tool>_spend(window, api_key) -> AdapterResult` function (or
   `fetch<Tool>Spend` in TypeScript) that calls `fetchWithRetry`/
   `fetch_with_retry`, validates every field with `requireField`/
   `require_field`, and applies the tool's own suspicious-zero rule if one
   exists.
2. A JSON fixture under `fixtures/` (root, for the TS tests) and
   `python/fixtures/` (copied, for the Python tests) modeled on the real
   vendor API response shape, cited from the vendor's own published docs.
3. Test coverage for: the happy path against the fixture, an empty
   response, any pagination/window-limit quirk the vendor has, the
   suspicious-zero detection (if applicable), and a retry-exhausted
   failure path.
4. A new entry in `KNOWN_TOOLS` (`src/cli.ts`) and `KNOWN_TOOLS`
   (`python/src/teamspend/cli.py`).
5. Update `docs/concepts.md` with the new tool's window limits and
   suspicious-zero rule (or a note that it doesn't have one).

## Reporting a bug

Open an issue with: which distribution (npm or PyPI), the exact command or
library call, and (with sensitive fields redacted) the vendor API response
shape you're seeing if it looks like a schema-drift issue --
`SchemaDriftError`/`teamspend may need an update` in the error message is
the signal that a vendor API shape changed since teamspend's adapters were
last verified against it.

# CLAUDE.md -- teamspend

## Project Identity

- **Idea:** Migration-cost-comparison CLI for AI coding-agent spend. `teamspend snapshot`
  pulls before/after spend from two admin-API-native tools (Cursor, Claude Code in v0.1)
  and produces a direct cost comparison for a team migrating between them, with a
  CSV-import fallback for windows a tool's API doesn't cover.
- **Repo:** RudrenduPaul/teamspend
- **npm package:** teamspend
- **Language:** TypeScript/Node (ESM), ships as an npx-installable CLI
- **License:** Apache 2.0
- **Repo goal:** Prove the migration-cost-snapshot wedge with a real design partner before
  considering the broader ongoing cross-vendor dashboard (Approach B in the design doc).
  This is deliberately narrow scope -- do not expand toward Approach B without new
  validated demand evidence.

## Git Workflow

When asked to commit, push, or "update GitHub" -- just do it. No questions.

- `git add` relevant files -> `git commit` -> `git push origin main` in one shot
- Every commit message ends with:
  Built by Rudrendu Paul and Sourav Nandy, developed with Claude Code
- Never use `Co-Authored-By:` lines.

## Engineering Standards (block all tasks until these pass)

1. **Lint:** `npx eslint . --ext .ts`
2. **Types:** `npx tsc --noEmit --strict` -- zero errors
3. **Tests:** `npx vitest run --coverage` -- 80% lines/statements/functions, 75% branches minimum
4. **Security:** `npm audit` -- no unfixed HIGH or CRITICAL CVEs in the dependency tree
5. **Build:** `npm run build` must succeed before any release

Do NOT mark a task complete if any of these fail. Fix the root cause. Do not suppress
errors or add `@ts-ignore` without a comment explaining why.

## Anti-Sycophancy Rules

1. **No spend total or coverage claim without a fixture-verified run.** Show the command
   that produced any stated number.
2. **Every cost figure must correctly set `isEstimated`.** Never present a seat-derived
   or CSV-imported estimate with the same precision as an exact API-reported figure.
3. **No comparison claim against tokscale, Vantage, or any native console without
   specificity.** Re-verify what each does and doesn't cover before restating it --
   these facts can change (see the strategy doc's §1.3-1.4).
4. **Never claim "no competitors."** tokscale, Vantage's partial coverage, and native
   consoles are real and must be named accurately in any public-facing copy.

## What Claude Must Never Do

- State a fundraising/investor-outreach motive anywhere in this repo
- Log, print, or persist a raw Admin API credential outside the env var/config file the
  user supplied it in
- Ship a new adapter without a fixture proving its normalized output against a
  known-correct expected value
- Present a partial comparison (one tool failed) as if it were complete

## Key Files

| File | Purpose |
|---|---|
| `src/http-client.ts` | Shared fetch+retry+auth wrapper (429/5xx/timeout, backoff, schema-drift guard) |
| `src/adapters/cursor.ts` | Cursor Admin API adapter, 30-day pagination |
| `src/adapters/claude-code.ts` | Anthropic Analytics/Admin API adapter, 2026-01-01 cliff detection |
| `src/adapters/csv-import.ts` | CSV fallback adapter |
| `src/schema.ts` | Normalized cost/usage schema |
| `src/compare.ts` | Before/after diff logic, top-5-spenders ranking |
| `src/output.ts` | Terminal summary + always-on JSON report writer + gitignore scaffold |
| `src/cli.ts` | Entrypoint, flag parsing/validation |
| `fixtures/` | Docs-derived fixtures -- NOT verified against a live account (see design doc) |

## Session Start Checklist

1. Run `git status` and `git log --oneline -5`
2. Run `npx vitest run` to confirm baseline is green before touching anything
3. If a bug is reported: write a failing test that reproduces it first, then fix it
4. Check whether Cursor's, Copilot's, or Anthropic's admin/analytics API surface has
   changed shape -- these are all young APIs (under a year old as of this writing)

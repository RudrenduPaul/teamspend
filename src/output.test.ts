import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  renderTerminalSummary,
  writeJsonReport,
  scaffoldGitignore,
} from "./output.js";
import { buildComparison, type PeriodOutcome } from "./compare.js";
import type { AdapterResult, UserUsage } from "./schema.js";

function makeResult(
  source: "cursor" | "claude-code",
  totalCostUsd: number,
  users: UserUsage[] = [],
): AdapterResult {
  return {
    source,
    window: { start: "2026-01-01", end: "2026-01-31" },
    totalCostUsd,
    isEstimated: false,
    users,
  };
}

describe("renderTerminalSummary", () => {
  it("shows DATA UNAVAILABLE for a failed period instead of silently omitting it", () => {
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 100),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: null,
      error: new Error("auth failed"),
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report);
    expect(output).toContain("DATA UNAVAILABLE: auth failed");
    expect(output).toContain("DELTA: unavailable");
  });

  it("strips control characters from a userEmail sourced from the live API, not just CSV import", () => {
    const maliciousUser: UserUsage = {
      userId: "u_evil",
      userEmail: "\x1b[31mevil@x.com",
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      requests: null,
      costUsd: 999,
      isEstimated: false,
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 999, [maliciousUser]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 0),
      error: null,
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report);
    expect(output).not.toContain("\x1b");
    expect(output).toContain("evil@x.com");
  });
});

describe("writeJsonReport and scaffoldGitignore", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("always writes a JSON file with a timestamped name", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-test-"));
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 100),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 130),
      error: null,
    };
    const report = buildComparison(before, after);

    const jsonPath = await writeJsonReport(report, tmpDir);
    expect(jsonPath).toMatch(/teamspend-snapshot-\d{4}-\d{2}-\d{2}T\d+\.json$/);
    const contents = JSON.parse(await readFile(jsonPath, "utf-8"));
    expect(contents.deltaUsd).toBe(30);
  });

  it("restricts the report file to owner read/write only (per-user data must not be world/group readable)", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-test-"));
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 100),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 130),
      error: null,
    };
    const report = buildComparison(before, after);

    const jsonPath = await writeJsonReport(report, tmpDir);
    const stats = await stat(jsonPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("scaffolds a .gitignore entry when none exists and warns on first run", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-test-"));
    const scaffolded = await scaffoldGitignore(tmpDir);
    expect(scaffolded).toBe(true);

    const contents = await readFile(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(contents).toContain("teamspend-snapshot-*.json");
  });

  it("does not duplicate the entry or re-warn on a second run", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-test-"));
    await scaffoldGitignore(tmpDir);
    const secondRun = await scaffoldGitignore(tmpDir);
    expect(secondRun).toBe(false);
  });
});

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
import type { AdapterResult, SessionUsage, UserUsage } from "./schema.js";

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

  it("omits any session breakdown section when --breakdown session was not requested, even if the result carries session data", () => {
    const sessions: SessionUsage[] = [
      {
        sessionId: "sess-1",
        costUsd: 5,
        inputTokens: 100,
        outputTokens: 50,
        requests: 2,
        isEstimated: false,
      },
    ];
    const userWithSessions: UserUsage = {
      userId: "local-user",
      userEmail: null,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 2,
      costUsd: 5,
      isEstimated: false,
      sessions,
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "claude-code-personal",
      result: makeResult("cursor", 5, [userWithSessions]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code-personal",
      result: makeResult("cursor", 5, [userWithSessions]),
      error: null,
    };
    const report = buildComparison(before, after);

    // No options passed at all -- this is the exact call shape every
    // pre-existing caller of renderTerminalSummary already uses.
    const output = renderTerminalSummary(report);
    expect(output).not.toContain("SESSION BREAKDOWN");
    expect(output).not.toContain("sess-1");
  });

  it("prints a per-session cost table, sorted by cost descending, when --breakdown session is requested and the adapter has session data", () => {
    const sessions: SessionUsage[] = [
      {
        sessionId: "cheap-session",
        costUsd: 1,
        inputTokens: 10,
        outputTokens: 5,
        requests: 1,
        isEstimated: false,
      },
      {
        sessionId: "expensive-session",
        costUsd: 9,
        inputTokens: 900,
        outputTokens: 400,
        requests: 3,
        isEstimated: true,
      },
    ];
    const user: UserUsage = {
      userId: "local-user",
      userEmail: null,
      inputTokens: 910,
      outputTokens: 405,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 4,
      costUsd: 10,
      isEstimated: true,
      sessions,
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "claude-code-personal",
      result: makeResult("cursor", 10, [user]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code-personal",
      result: makeResult("cursor", 10, [user]),
      error: null,
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report, { breakdown: "session" });
    expect(output).toContain("SESSION BREAKDOWN");
    // expensive-session (higher cost) must be listed before cheap-session.
    const expensiveIndex = output.indexOf("expensive-session");
    const cheapIndex = output.indexOf("cheap-session");
    expect(expensiveIndex).toBeGreaterThan(-1);
    expect(cheapIndex).toBeGreaterThan(-1);
    expect(expensiveIndex).toBeLessThan(cheapIndex);
    expect(output).toContain("$9.00");
    expect(output).toContain("$1.00");
    expect(output).toContain("(estimated)");
  });

  it("strips control characters from a sessionId sourced from a local log, same as userEmail", () => {
    const sessions: SessionUsage[] = [
      {
        sessionId: "\x1b[31mevil-session",
        costUsd: 5,
        inputTokens: 100,
        outputTokens: 50,
        requests: 1,
        isEstimated: false,
      },
    ];
    const user: UserUsage = {
      userId: "local-user",
      userEmail: null,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 1,
      costUsd: 5,
      isEstimated: false,
      sessions,
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "claude-code-personal",
      result: makeResult("cursor", 5, [user]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code-personal",
      result: makeResult("cursor", 5, [user]),
      error: null,
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report, { breakdown: "session" });
    expect(output).not.toContain("\x1b");
    expect(output).toContain("evil-session");
  });

  it("explains why no breakdown is available when --breakdown session is requested but the tool's data has no session concept (e.g. an admin-API-based adapter)", () => {
    const adminApiUser: UserUsage = {
      userId: "u1",
      userEmail: "a@x.com",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 5,
      costUsd: 20,
      isEstimated: false,
      // No `sessions` field -- matches what cursor.ts/claude-code.ts/
      // copilot.ts actually produce, since their APIs report aggregate
      // totals only.
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 20, [adminApiUser]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 20, [adminApiUser]),
      error: null,
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report, { breakdown: "session" });
    expect(output).toContain("SESSION BREAKDOWN: not available for cursor");
    expect(output).toContain("SESSION BREAKDOWN: not available for claude-code");
    // Never silently show nothing, and never fabricate fake session rows.
    expect(output).not.toMatch(/SESSION BREAKDOWN \(top/);
  });

  it("reports no session activity (not a capability gap) when the adapter supports sessions but none fell in this window", () => {
    const userWithEmptySessions: UserUsage = {
      userId: "local-user",
      userEmail: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      requests: 0,
      costUsd: 0,
      isEstimated: false,
      sessions: [],
    };
    const before: PeriodOutcome = {
      label: "before",
      tool: "claude-code-personal",
      result: makeResult("cursor", 0, [userWithEmptySessions]),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code-personal",
      result: makeResult("cursor", 0, [userWithEmptySessions]),
      error: null,
    };
    const report = buildComparison(before, after);

    const output = renderTerminalSummary(report, { breakdown: "session" });
    expect(output).toContain("no session activity in this window");
    expect(output).not.toContain("not available for");
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

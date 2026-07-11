import { describe, it, expect } from "vitest";
import { buildComparison, type PeriodOutcome } from "./compare.js";
import type { AdapterResult } from "./schema.js";

function makeResult(
  source: "cursor" | "claude-code",
  totalCostUsd: number,
  users: AdapterResult["users"],
): AdapterResult {
  return {
    source,
    window: { start: "2026-01-01", end: "2026-01-31" },
    totalCostUsd,
    isEstimated: false,
    users,
  };
}

describe("buildComparison", () => {
  it("computes delta and percent when both periods succeed", () => {
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 100, []),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 130, []),
      error: null,
    };

    const report = buildComparison(before, after);
    expect(report.deltaUsd).toBe(30);
    expect(report.deltaPercent).toBeCloseTo(30, 5);
  });

  it("reports both windows empty explicitly, not as a failure", () => {
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 0, []),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 0, []),
      error: null,
    };

    const report = buildComparison(before, after);
    expect(report.deltaUsd).toBe(0);
    expect(report.before.result?.totalCostUsd).toBe(0);
    expect(report.after.result?.totalCostUsd).toBe(0);
  });

  it("marks delta unavailable, never silently omitting the failed side, when one period fails", () => {
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 100, []),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: null,
      error: new Error("boom"),
    };

    const report = buildComparison(before, after);
    expect(report.deltaUsd).toBeNull();
    expect(report.deltaPercent).toBeNull();
    expect(report.after.error?.message).toBe("boom");
  });

  it("shows all available spenders when fewer than 5 exist, not padded", () => {
    const users = [
      {
        userId: "1",
        userEmail: "a@x.com",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
        costUsd: 10,
        isEstimated: false,
      },
    ];
    const before: PeriodOutcome = {
      label: "before",
      tool: "cursor",
      result: makeResult("cursor", 10, users),
      error: null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: "claude-code",
      result: makeResult("claude-code", 0, []),
      error: null,
    };

    const report = buildComparison(before, after);
    expect(report.topSpendersAcrossBoth).toHaveLength(1);
  });
});

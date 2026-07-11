import type { AdapterResult, ToolId } from "./schema.js";
import { topSpenders } from "./schema.js";

export interface PeriodOutcome {
  label: "before" | "after";
  tool: ToolId;
  result: AdapterResult | null;
  error: Error | null;
}

export interface ComparisonReport {
  before: PeriodOutcome;
  after: PeriodOutcome;
  deltaUsd: number | null;
  deltaPercent: number | null;
  topSpendersAcrossBoth: Array<{
    period: "before" | "after";
    userEmail: string | null;
    costUsd: number;
  }>;
}

/**
 * Builds the before/after comparison report from two independently-settled
 * adapter fetches. Never treats a partial failure as a complete comparison —
 * if either side failed, delta is null and the failed side is marked, not
 * silently dropped from the report.
 */
export function buildComparison(
  before: PeriodOutcome,
  after: PeriodOutcome,
): ComparisonReport {
  const beforeCost = before.result?.totalCostUsd ?? null;
  const afterCost = after.result?.totalCostUsd ?? null;

  const deltaUsd =
    beforeCost !== null && afterCost !== null ? afterCost - beforeCost : null;
  const deltaPercent =
    deltaUsd !== null && beforeCost !== null && beforeCost !== 0
      ? (deltaUsd / beforeCost) * 100
      : null;

  const topSpendersAcrossBoth: ComparisonReport["topSpendersAcrossBoth"] = [];
  if (before.result) {
    for (const u of topSpenders(before.result.users, 5)) {
      topSpendersAcrossBoth.push({
        period: "before",
        userEmail: u.userEmail,
        costUsd: u.costUsd,
      });
    }
  }
  if (after.result) {
    for (const u of topSpenders(after.result.users, 5)) {
      topSpendersAcrossBoth.push({
        period: "after",
        userEmail: u.userEmail,
        costUsd: u.costUsd,
      });
    }
  }
  topSpendersAcrossBoth.sort((a, b) => b.costUsd - a.costUsd);

  return {
    before,
    after,
    deltaUsd,
    deltaPercent,
    topSpendersAcrossBoth: topSpendersAcrossBoth.slice(0, 5),
  };
}

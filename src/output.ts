import { writeFile, readFile, appendFile, access } from "node:fs/promises";
import type { ComparisonReport } from "./compare.js";

const GITIGNORE_ENTRY = "teamspend-snapshot-*.json";

/**
 * Scaffolds a .gitignore entry for the report file in the CWD if one doesn't
 * already exist, and returns whether the first-run spend-sensitivity warning
 * should be printed. The report contains per-user email + spend, which is
 * quasi-sensitive data that shouldn't land in a repo by accident during a
 * fast-moving migration.
 */
export async function scaffoldGitignore(cwd: string): Promise<boolean> {
  const gitignorePath = `${cwd}/.gitignore`;
  let alreadyPresent = false;

  try {
    const contents = await readFile(gitignorePath, "utf-8");
    alreadyPresent = contents.includes(GITIGNORE_ENTRY);
  } catch {
    // No .gitignore yet, that's fine, we'll create one.
  }

  if (!alreadyPresent) {
    try {
      await access(gitignorePath);
      await appendFile(gitignorePath, `\n${GITIGNORE_ENTRY}\n`);
    } catch {
      await writeFile(gitignorePath, `${GITIGNORE_ENTRY}\n`);
    }
    return true;
  }

  return false;
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function renderTerminalSummary(report: ComparisonReport): string {
  const lines: string[] = [];
  lines.push("teamspend snapshot -- migration cost comparison");
  lines.push(`Tools: ${report.before.tool} -> ${report.after.tool}`);
  lines.push("");

  for (const outcome of [report.before, report.after]) {
    const label = outcome.label.toUpperCase();
    lines.push(`${label} (${outcome.tool})`);
    if (outcome.result) {
      const estimateNote = outcome.result.isEstimated
        ? "estimated"
        : "exact, usage-based";
      lines.push(
        `  Total spend:      ${formatUsd(outcome.result.totalCostUsd)}  (${estimateNote})`,
      );
      lines.push(`  Active users:      ${outcome.result.users.length}`);
    } else {
      lines.push(
        `  DATA UNAVAILABLE: ${outcome.error?.message ?? "unknown error"}`,
      );
    }
    lines.push("");
  }

  if (report.deltaUsd !== null && report.deltaPercent !== null) {
    const sign = report.deltaUsd >= 0 ? "+" : "-";
    lines.push(
      `DELTA: ${sign}${formatUsd(Math.abs(report.deltaUsd))} (${sign}${Math.abs(report.deltaPercent).toFixed(1)}%)`,
    );
  } else {
    lines.push(
      "DELTA: unavailable -- one or both periods failed to fetch, see above",
    );
  }

  if (report.topSpendersAcrossBoth.length > 0) {
    lines.push("");
    lines.push("TOP SPENDERS (across both periods)");
    report.topSpendersAcrossBoth.forEach((s, i) => {
      lines.push(
        `  ${i + 1}. ${s.userEmail ?? "(unknown)"}     ${s.period}      ${formatUsd(s.costUsd)}`,
      );
    });
  }

  return lines.join("\n");
}

/**
 * Always writes the JSON report file, regardless of --json. --json only
 * changes what prints to the terminal (see renderTerminalSummary vs. this
 * function's return value being printed directly to stdout by the caller).
 */
export async function writeJsonReport(
  report: ComparisonReport,
  cwd: string,
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const path = `${cwd}/teamspend-snapshot-${timestamp}.json`;
  // mode: 0o600 restricts the file to owner read/write only. Without it,
  // Node's default (0o666 masked by the process umask, typically 0o644)
  // leaves per-user email + spend readable by any other local user on a
  // shared host (found during the [redacted ]review).
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  return path;
}

import { readFile } from "node:fs/promises";
import { CSVRowError, CSVSchemaError, EmptyCSVError } from "../errors.js";
import { sumCost } from "../schema.js";
import type {
  AdapterResult,
  DateWindow,
  ToolId,
  UserUsage,
} from "../schema.js";

const EXPECTED_COLUMNS = ["date", "user_email", "cost_usd", "is_estimated"];

interface CSVRow {
  date: string;
  user_email: string;
  cost_usd: string;
  is_estimated: string;
}

/**
 * Strips C0 control characters (0x00-0x1f), including ANSI/OSC terminal
 * escape sequences, from a CSV cell value. Without this, a crafted
 * user_email in an imported CSV could inject escape codes into the
 * non-JSON terminal summary output (found during the [redacted ]review) -
 * JSON.stringify already escapes these, so this only matters for the
 * human-readable render path, but stripping at parse time protects every
 * consumer, not just that one.
 */
function stripControlChars(value: string): string {
  return value.replace(/[\x00-\x1f]/g, "");
}

function parseCSV(text: string): CSVRow[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new EmptyCSVError("<csv content>");
  }

  const header = lines[0]?.split(",").map((h) => h.trim()) ?? [];
  const missingColumns = EXPECTED_COLUMNS.filter(
    (col) => !header.includes(col),
  );
  if (missingColumns.length > 0) {
    throw new CSVSchemaError(EXPECTED_COLUMNS);
  }

  const dateIdx = header.indexOf("date");
  const emailIdx = header.indexOf("user_email");
  const costIdx = header.indexOf("cost_usd");
  const estimatedIdx = header.indexOf("is_estimated");

  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => stripControlChars(c.trim()));
    return {
      date: cells[dateIdx] ?? "",
      user_email: cells[emailIdx] ?? "",
      cost_usd: cells[costIdx] ?? "",
      is_estimated: cells[estimatedIdx] ?? "",
    };
  });
}

/**
 * Imports before-window spend from a CSV file for a tool whose admin API
 * doesn't cover the requested window (e.g. Claude Code before 2026-01-01).
 * Schema: date, user_email, cost_usd, is_estimated. One row per user per day.
 */
export async function importFromCSV(
  csvPath: string,
  source: ToolId,
  window: DateWindow,
): Promise<AdapterResult> {
  const text = await readFile(csvPath, "utf-8");
  if (text.trim().length === 0) {
    throw new EmptyCSVError(csvPath);
  }

  const rows = parseCSV(text);
  const userTotals = new Map<string, UserUsage>();

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // +1 for header row, +1 for 1-based numbering
    if (row.user_email.length === 0) {
      throw new CSVRowError(rowNumber, "user_email is empty");
    }

    const cost = Number.parseFloat(row.cost_usd);
    if (!Number.isFinite(cost)) {
      throw new CSVRowError(rowNumber, `cost_usd "${row.cost_usd}" is not a valid number`);
    }

    const existing = userTotals.get(row.user_email);
    const isEstimated = row.is_estimated.toLowerCase() === "true";

    if (existing) {
      existing.costUsd += cost;
      existing.isEstimated = existing.isEstimated || isEstimated;
    } else {
      userTotals.set(row.user_email, {
        userId: row.user_email,
        userEmail: row.user_email,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        requests: null,
        costUsd: cost,
        isEstimated,
      });
    }
  });

  const users = [...userTotals.values()];
  return {
    source,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: users.some((u) => u.isEstimated),
    users,
  };
}

import { fetchWithRetry, requireField } from "../http-client.js";
import { DataUnavailableError } from "../errors.js";
import { sumCost } from "../schema.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const TOOL = "claude-code";
/** Anthropic's Claude Enterprise Analytics API has no data before this date. */
const ANALYTICS_API_START_DATE = "2026-01-01";

interface ClaudeApiUser {
  email: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  spend_usd: number;
}

interface ClaudeApiResponse {
  users: ClaudeApiUser[];
}

function normalizeUser(raw: ClaudeApiUser): UserUsage {
  const asRecord = raw as unknown as Record<string, unknown>;
  return {
    userId: requireField<string>(asRecord, "user_id", TOOL),
    userEmail: requireField<string>(asRecord, "email", TOOL),
    inputTokens: requireField<number>(asRecord, "input_tokens", TOOL),
    outputTokens: requireField<number>(asRecord, "output_tokens", TOOL),
    cacheReadTokens: requireField<number>(asRecord, "cache_read_tokens", TOOL),
    cacheWriteTokens: requireField<number>(
      asRecord,
      "cache_write_tokens",
      TOOL,
    ),
    requests: null,
    costUsd: requireField<number>(asRecord, "spend_usd", TOOL),
    isEstimated: false,
  };
}

/**
 * Fetches Claude Code spend via Anthropic's Analytics/Admin API. If the
 * window's start predates 2026-01-01 (the Analytics API's hard start date,
 * not a rolling window), throws DataUnavailableError rather than silently
 * returning an incomplete or zeroed result. The caller falls back to the
 * CSV-import path for that portion of the window.
 */
export async function fetchClaudeCodeSpend(
  window: DateWindow,
  apiKey: string,
): Promise<AdapterResult> {
  if (window.start < ANALYTICS_API_START_DATE) {
    throw new DataUnavailableError(
      TOOL,
      `requested window starts ${window.start}, before the Analytics API's ${ANALYTICS_API_START_DATE} start date`,
    );
  }

  const authHeader = { "x-api-key": apiKey };
  const url = `https://api.anthropic.com/v1/organizations/usage_report/claude_code?start=${window.start}&end=${window.end}`;
  const raw = (await fetchWithRetry({
    tool: TOOL,
    url,
    authHeader,
  })) as ClaudeApiResponse;
  const asRecord = raw as unknown as Record<string, unknown>;
  const rawUsers = requireField<ClaudeApiUser[]>(asRecord, "users", TOOL);

  const users = rawUsers.map(normalizeUser);
  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: false,
    users,
  };
}

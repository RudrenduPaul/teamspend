import { fetchWithRetry, requireField } from "../http-client.js";
import { sumCost } from "../schema.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const CURSOR_MAX_WINDOW_DAYS = 30;
const TOOL = "cursor";

interface CursorApiUser {
  email?: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  cost_usd: number;
}

interface CursorApiResponse {
  users: CursorApiUser[];
}

function splitIntoChunks(window: DateWindow): DateWindow[] {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const chunks: DateWindow[] = [];
  let chunkStart = start;

  while (chunkStart <= end) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setDate(chunkEnd.getDate() + CURSOR_MAX_WINDOW_DAYS - 1);
    const clampedEnd = chunkEnd > end ? end : chunkEnd;
    chunks.push({
      start: chunkStart.toISOString().slice(0, 10),
      end: clampedEnd.toISOString().slice(0, 10),
    });
    chunkStart = new Date(clampedEnd);
    chunkStart.setDate(chunkStart.getDate() + 1);
  }

  return chunks;
}

function normalizeUser(raw: CursorApiUser): UserUsage {
  const asRecord = raw as unknown as Record<string, unknown>;
  const inputTokens = requireField<number>(asRecord, "input_tokens", TOOL);
  const outputTokens = requireField<number>(asRecord, "output_tokens", TOOL);
  const requests = requireField<number>(asRecord, "requests", TOOL);
  const costUsd = requireField<number>(asRecord, "cost_usd", TOOL);

  // Cursor plans without usage overage don't expose true per-user cost via
  // the Admin API - it reports a technically-valid but structurally
  // uninformative cost_usd: 0 for a user who clearly has real activity. Flag
  // that specific combination as estimated rather than presenting a
  // misleading exact-looking $0 (see ccusage/ccusage#1113 for the same fix
  // in a different vendor's adapter).
  const isSuspiciousZero =
    costUsd === 0 && (inputTokens > 0 || outputTokens > 0 || requests > 0);

  return {
    userId: requireField<string>(asRecord, "user_id", TOOL),
    userEmail: raw.email ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens: requireField<number>(asRecord, "cache_read_tokens", TOOL),
    cacheWriteTokens: requireField<number>(
      asRecord,
      "cache_write_tokens",
      TOOL,
    ),
    requests,
    costUsd,
    isEstimated: isSuspiciousZero,
  };
}

/**
 * Fetches Cursor Admin API spend for the given window, paginating across
 * 30-day chunks (the API's per-call cap) and summing the result. If any
 * chunk fails after retries are exhausted, the ENTIRE call fails. Never
 * silently sum only the chunks that succeeded, which would under-report
 * spend without any indication the number is incomplete.
 */
export async function fetchCursorSpend(
  window: DateWindow,
  apiKey: string,
): Promise<AdapterResult> {
  const chunks = splitIntoChunks(window);
  const authHeader = { Authorization: `Bearer ${apiKey}` };

  const userTotals = new Map<string, UserUsage>();

  for (const chunk of chunks) {
    const url = `https://api.cursor.com/admin/usage?start=${chunk.start}&end=${chunk.end}`;
    const raw = (await fetchWithRetry({
      tool: TOOL,
      url,
      authHeader,
    })) as CursorApiResponse;
    const asRecord = raw as unknown as Record<string, unknown>;
    const users = requireField<CursorApiUser[]>(asRecord, "users", TOOL);

    for (const rawUser of users) {
      const normalized = normalizeUser(rawUser);
      const existing = userTotals.get(normalized.userId);
      if (existing) {
        existing.inputTokens =
          (existing.inputTokens ?? 0) + (normalized.inputTokens ?? 0);
        existing.outputTokens =
          (existing.outputTokens ?? 0) + (normalized.outputTokens ?? 0);
        existing.cacheReadTokens =
          (existing.cacheReadTokens ?? 0) + (normalized.cacheReadTokens ?? 0);
        existing.cacheWriteTokens =
          (existing.cacheWriteTokens ?? 0) + (normalized.cacheWriteTokens ?? 0);
        existing.requests =
          (existing.requests ?? 0) + (normalized.requests ?? 0);
        existing.costUsd += normalized.costUsd;
      } else {
        userTotals.set(normalized.userId, normalized);
      }
    }
  }

  const users = [...userTotals.values()];
  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: users.some((u) => u.isEstimated),
    users,
  };
}

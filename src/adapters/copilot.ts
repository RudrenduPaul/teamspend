import { fetchWithRetry, requireField } from "../http-client.js";
import {
  AuthenticationError,
  DataUnavailableError,
  InvalidCliArgError,
} from "../errors.js";
import { sumCost } from "../schema.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const TOOL = "copilot";
const COPILOT_API_VERSION = "2026-03-10";

/**
 * GitHub's Copilot metrics reporting has no data before this date for either
 * orgs or enterprises. A requested window starting earlier throws
 * DataUnavailableError without calling the API at all, mirroring
 * claude-code.ts's ANALYTICS_API_START_DATE guard.
 *
 * Source: GitHub Docs, "Data available in Copilot usage metrics" --
 * enterprise/org usage-metrics reports are available starting 2025-10-10.
 */
const COPILOT_METRICS_START_DATE = "2025-10-10";

/**
 * GitHub's own published, fixed conversion rate from an AI credit to USD --
 * not a negotiated or per-org price, the same $0.01/credit rate applies to
 * every Copilot Business/Enterprise org. Source: GitHub Blog, "GitHub
 * Copilot is moving to usage-based billing" (2026) -- "1 AI credit = $0.01
 * USD". Used to turn the `ai_credits_used` field GitHub's metrics API
 * actually returns into a real dollar figure, rather than inventing one.
 */
const COPILOT_CREDIT_USD_RATE = 0.01;

interface CopilotReportIndex {
  download_links: string[];
  report_day?: string;
}

interface CopilotApiUser {
  user_id: string | number;
  user_login: string;
  ai_credits_used: number;
  user_initiated_interaction_count: number;
}

function splitIntoDays(window: DateWindow): string[] {
  const start = new Date(window.start);
  const end = new Date(window.end);
  const days: string[] = [];
  let cursor = start;

  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

/**
 * Per-day, credits-only usage cost for one user. Does NOT include any
 * seat/license price -- that is added once per user, after merging across
 * every day in the window, by the caller (fetchCopilotSpend), so a
 * multi-day window never double- or triple-counts a flat monthly seat fee.
 */
function normalizeUser(raw: CopilotApiUser): UserUsage {
  const asRecord = raw as unknown as Record<string, unknown>;
  const userLogin = requireField<string>(asRecord, "user_login", TOOL);
  const aiCreditsUsed = requireField<number>(
    asRecord,
    "ai_credits_used",
    TOOL,
  );
  const interactionCount = requireField<number>(
    asRecord,
    "user_initiated_interaction_count",
    TOOL,
  );

  return {
    userId: userLogin,
    // GitHub's Copilot metrics API identifies users by user_id/user_login
    // (a GitHub username), never an email address -- unlike Cursor and
    // Claude Code, there is no email field anywhere in this response.
    userEmail: null,
    // Copilot's metrics reports carry no token counts (input/output/cache)
    // at all -- that concept doesn't apply to its per-user report shape,
    // which is credits- and interaction-count-based instead.
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    requests: interactionCount,
    costUsd: aiCreditsUsed * COPILOT_CREDIT_USD_RATE,
    // Always true: see fetchCopilotSpend's isEstimated comment below.
    isEstimated: true,
  };
}

function parseNdjson(text: string): CopilotApiUser[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CopilotApiUser);
}

/**
 * Fetches GitHub Copilot org usage for the given window and converts it to a
 * dollar figure, via the CURRENT (non-deprecated) Copilot usage metrics
 * reports API: GET /orgs/{org}/copilot/metrics/reports/users-1-day. The
 * older /orgs/{org}/copilot/metrics endpoint (which returned inline
 * org-aggregate JSON) was sunset by GitHub on 2026-04-02 and no longer
 * exists.
 *
 * Unlike Cursor and Claude Code, this real API has no arbitrary start/end
 * range parameter and no per-user cost field at all:
 *
 * - It only exposes single-day (`users-1-day?day=YYYY-MM-DD`) or
 *   latest-rolling-28-day (`users-28-day/latest`) granularity. To honor an
 *   arbitrary caller-supplied window, this adapter requests one report per
 *   calendar day in the window and sums per-user totals across days --
 *   the same "chunk the window, sum the chunks" shape as
 *   fetchCursorSpend's 30-day pagination, just chunked by day instead.
 * - Each report call doesn't return data inline. It returns
 *   `{ download_links, report_day }`, where download_links are short-lived,
 *   pre-signed GitHub-owned URLs pointing to NDJSON (newline-delimited
 *   JSON) files -- one JSON user record per line, not a single JSON array.
 *   This adapter fetches and parses each one.
 * - Copilot Business/Enterprise is seat-based billing ($19 or $39/seat/
 *   month, bundling a matching monthly AI-credit allowance) -- GitHub does
 *   not expose an org's actual per-seat contract price via any API, the
 *   same structural gap Cursor's and Claude Code's flat-seat plans have.
 *   The only real, vendor-reported-and-attributable number is
 *   `ai_credits_used`, which this adapter converts to USD at GitHub's own
 *   published, fixed $0.01/credit rate (COPILOT_CREDIT_USD_RATE) -- never
 *   fabricated. If `seatPriceUsd` is supplied, it's added once per user
 *   (not once per day) to also reflect the flat license cost; if omitted,
 *   the reported cost is credits-usage-only and explicitly excludes the
 *   seat fee (see README for the same caveat spelled out for CLI users).
 *
 * `isEstimated` is unconditionally true for every Copilot result, regardless
 * of whether seatPriceUsd was supplied: GitHub's Copilot metrics API has no
 * cost_usd/spend_usd-equivalent field at all (unlike Cursor/Claude Code,
 * which do report a native cost figure that is only sometimes suspicious),
 * so every dollar amount this adapter produces is derived, never vendor-
 * reported, and should never be presented as an exact number.
 */
export async function fetchCopilotSpend(
  window: DateWindow,
  apiKey: string,
  org: string,
  seatPriceUsd?: number,
): Promise<AdapterResult> {
  if (seatPriceUsd !== undefined && !(seatPriceUsd >= 0)) {
    throw new InvalidCliArgError(
      `copilot seat price must be a non-negative number, got ${seatPriceUsd}`,
    );
  }

  if (window.start < COPILOT_METRICS_START_DATE) {
    throw new DataUnavailableError(
      TOOL,
      `requested window starts ${window.start}, before Copilot usage metrics reports' ${COPILOT_METRICS_START_DATE} start date`,
    );
  }

  const authHeader = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
  };

  const userTotals = new Map<string, UserUsage>();

  for (const day of splitIntoDays(window)) {
    const url = `https://api.github.com/orgs/${encodeURIComponent(org)}/copilot/metrics/reports/users-1-day?day=${day}`;
    const report = (await fetchWithRetry({
      tool: TOOL,
      url,
      authHeader,
      emptyOn: [404],
    })) as CopilotReportIndex | null;

    // 404 means "no report for this day" (no Copilot activity, or the org's
    // metrics collection hadn't started yet on that specific day) -- treated
    // as zero users for that day, not a failure, the same way Cursor's
    // adapter treats a 200 { users: [] } response.
    if (report === null) continue;

    const asRecord = report as unknown as Record<string, unknown>;
    const downloadLinks = requireField<string[]>(
      asRecord,
      "download_links",
      TOOL,
    );

    for (const link of downloadLinks) {
      let ndjson: string;
      try {
        // Download links are short-lived, pre-signed GitHub-owned URLs --
        // they carry their own signature/auth in the URL itself and don't
        // need (and can reject) the org's TEAMSPEND_COPILOT_TOKEN.
        ndjson = (await fetchWithRetry({
          tool: TOOL,
          url: link,
          authHeader: {},
          responseType: "text",
        })) as string;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          throw new Error(
            `${TOOL}: report download link for ${day} was rejected (expired signed URL?) -- retry the command (org=${org})`,
          );
        }
        throw error;
      }

      for (const rawUser of parseNdjson(ndjson)) {
        const normalized = normalizeUser(rawUser);
        const existing = userTotals.get(normalized.userId);
        if (existing) {
          existing.requests = (existing.requests ?? 0) + (normalized.requests ?? 0);
          existing.costUsd += normalized.costUsd;
        } else {
          userTotals.set(normalized.userId, normalized);
        }
      }
    }
  }

  if (seatPriceUsd) {
    for (const user of userTotals.values()) {
      user.costUsd += seatPriceUsd;
    }
  }

  const users = [...userTotals.values()];
  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: true,
    users,
  };
}

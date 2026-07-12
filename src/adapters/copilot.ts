import { fetchWithRetry, requireField } from "../http-client.js";
import { sumCost } from "../schema.js";
import { DataUnavailableError } from "../errors.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const TOOL = "copilot";
const GITHUB_API_BASE = "https://api.github.com";
const MEMBERS_PAGE_SIZE = 100;

/**
 * GitHub's billing usage endpoints keep only the trailing 24 months. Unlike
 * Claude Code's hard analytics-start-date cliff, this is a rolling window
 * measured from "now", so it is computed at call time rather than pinned to
 * a constant.
 */
const BILLING_HISTORY_MONTHS = 24;

interface GitHubOrgMember {
  login: string;
}

interface GitHubBillingUsageItem {
  date: string;
  product: string;
  netAmount: number;
}

interface GitHubBillingUsageResponse {
  usageItems: GitHubBillingUsageItem[];
}

function githubAuthHeader(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * GitHub's org member list is paginated (100/page, Link-header driven).
 * teamspend paginates by incrementing `page` until a short page comes back,
 * which avoids needing http-client's fetchWithRetry to expose response
 * headers just for Link parsing.
 */
async function listOrgMembers(
  org: string,
  apiKey: string,
): Promise<string[]> {
  const logins: string[] = [];
  let page = 1;

  for (;;) {
    const url = `${GITHUB_API_BASE}/orgs/${org}/members?per_page=${MEMBERS_PAGE_SIZE}&page=${page}`;
    const raw = (await fetchWithRetry({
      tool: TOOL,
      url,
      authHeader: githubAuthHeader(apiKey),
    })) as GitHubOrgMember[];

    if (!Array.isArray(raw)) {
      throw new DataUnavailableError(
        TOOL,
        `expected an array of org members, got ${typeof raw}`,
      );
    }
    if (raw.length === 0) break;

    for (const member of raw) {
      logins.push(requireField<string>(member as unknown as Record<string, unknown>, "login", TOOL));
    }

    if (raw.length < MEMBERS_PAGE_SIZE) break;
    page += 1;
  }

  return logins;
}

/** {year, month} pairs (1-12) covering every calendar month touched by the window, inclusive. */
function monthsInWindow(window: DateWindow): Array<{ year: number; month: number }> {
  const start = new Date(`${window.start}T00:00:00Z`);
  const end = new Date(`${window.end}T00:00:00Z`);
  const months: Array<{ year: number; month: number }> = [];

  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));

  while (cursor <= endCursor) {
    months.push({ year: cursor.getUTCFullYear(), month: cursor.getUTCMonth() + 1 });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }

  return months;
}

function oldestAvailableMonth(): { year: number; month: number } {
  const now = new Date();
  const cutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - BILLING_HISTORY_MONTHS, 1),
  );
  return { year: cutoff.getUTCFullYear(), month: cutoff.getUTCMonth() + 1 };
}

/**
 * Sums one user's real Copilot billing line items for the exact requested
 * window. GitHub's billing/usage endpoint only accepts whole-month queries
 * (year+month), but each returned line item carries its own `date`, so
 * teamspend fetches the covering month(s) and filters/sums down to the
 * precise day range instead of over-reporting a whole month's cost for a
 * partial-month window.
 *
 * Product-name matching is intentionally case-insensitive substring match
 * ("copilot") rather than an exact string: GitHub's public docs describe
 * the `product` field's possible values loosely, and a stricter exact-match
 * risks silently dropping every row if GitHub's casing differs from what
 * was verified against third-party client code, not GitHub's own raw API
 * response, during this adapter's development.
 */
async function fetchUserCopilotCost(
  login: string,
  window: DateWindow,
  months: Array<{ year: number; month: number }>,
  apiKey: string,
): Promise<number> {
  let total = 0;

  for (const { year, month } of months) {
    const url = `${GITHUB_API_BASE}/users/${login}/settings/billing/usage?year=${year}&month=${month}`;
    const raw = (await fetchWithRetry({
      tool: TOOL,
      url,
      authHeader: githubAuthHeader(apiKey),
    })) as GitHubBillingUsageResponse;
    const asRecord = raw as unknown as Record<string, unknown>;
    const items = requireField<GitHubBillingUsageItem[]>(
      asRecord,
      "usageItems",
      TOOL,
    );

    for (const item of items) {
      const product = requireField<string>(
        item as unknown as Record<string, unknown>,
        "product",
        TOOL,
      );
      if (!product.toLowerCase().includes("copilot")) continue;

      const date = requireField<string>(
        item as unknown as Record<string, unknown>,
        "date",
        TOOL,
      );
      if (date < window.start || date > window.end) continue;

      total += requireField<number>(
        item as unknown as Record<string, unknown>,
        "netAmount",
        TOOL,
      );
    }
  }

  return total;
}

/**
 * Fetches real per-user GitHub Copilot spend for the given org and window.
 *
 * Unlike Cursor and Claude Code, a single GitHub PAT is not itself
 * org-scoped, so this adapter needs the org login as a second input
 * (TEAMSPEND_COPILOT_ORG), resolved by cli.ts alongside the token env var.
 *
 * GitHub does not expose per-user cost on the org-scoped billing endpoint
 * (`/organizations/{org}/settings/billing/usage` returns aggregate totals
 * only, no `user` field) -- real per-user attribution requires calling the
 * per-user endpoint once per org member. This means a Copilot snapshot
 * makes members.length x months.length HTTP calls, materially slower than
 * Cursor/Claude Code's single-chunked-call model; this is a real GitHub API
 * shape constraint, not an implementation shortcut, and is documented in
 * the README rather than hidden.
 *
 * Unlike Cursor/Claude Code's vendor-reported cost_usd field, this dollar
 * figure comes directly from GitHub's own billing ledger (net_amount after
 * discounts), so there is no vendor-side "suspicious zero" ambiguity to
 * flag here the way there is for flat-seat Cursor/Claude.ai plans --
 * isEstimated is always false for Copilot.
 */
export async function fetchCopilotSpend(
  window: DateWindow,
  apiKey: string,
  org: string,
): Promise<AdapterResult> {
  const oldest = oldestAvailableMonth();
  const oldestKey = oldest.year * 12 + oldest.month;
  const windowStartKey =
    Number(window.start.slice(0, 4)) * 12 + Number(window.start.slice(5, 7));
  if (windowStartKey < oldestKey) {
    throw new DataUnavailableError(
      TOOL,
      `requested window starts ${window.start}, before GitHub's ${BILLING_HISTORY_MONTHS}-month billing usage retention cutoff`,
    );
  }

  const members = await listOrgMembers(org, apiKey);
  const months = monthsInWindow(window);

  const users: UserUsage[] = [];
  for (const login of members) {
    const costUsd = await fetchUserCopilotCost(login, window, months, apiKey);
    users.push({
      userId: login,
      userEmail: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      requests: null,
      costUsd,
      isEstimated: false,
    });
  }

  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: users.some((u) => u.isEstimated),
    users,
  };
}

/** Tools teamspend can pull spend data from. */
export type ToolId = "cursor" | "claude-code" | "copilot" | "opencode";

export interface DateWindow {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

export interface UserUsage {
  userId: string;
  userEmail: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  requests: number | null;
  costUsd: number;
  isEstimated: boolean;
}

/** Normalized shape every adapter (and the CSV-import fallback) maps into. */
export interface AdapterResult {
  source: ToolId;
  window: DateWindow;
  totalCostUsd: number;
  isEstimated: boolean;
  users: UserUsage[];
}

export function sumCost(users: UserUsage[]): number {
  return users.reduce((total, user) => total + user.costUsd, 0);
}

export function topSpenders(users: UserUsage[], limit: number): UserUsage[] {
  return [...users].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}

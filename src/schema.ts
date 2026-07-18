/**
 * Tools teamspend can pull spend data from. `claude-code-personal` is not a
 * separate vendor -- it's a credential-free local-file read mode for Claude
 * Code's own JSONL session logs, for someone who wants their personal usage
 * without org-admin API access (see src/adapters/claude-code-personal.ts).
 * `codex` (OpenAI's Codex CLI) is the same shape as `opencode` -- no
 * admin/team API, only local per-machine session logs (see
 * src/adapters/codex.ts).
 */
export type ToolId =
  | "cursor"
  | "claude-code"
  | "copilot"
  | "opencode"
  | "claude-code-personal"
  | "codex";

export interface DateWindow {
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
}

/**
 * Cost attributed to a single session/conversation -- a bounded unit of one
 * interaction, and the most honest proxy teamspend can offer for "cost per
 * task." This is NOT a measure of task success, quality, or ROI: no vendor
 * exposes whether a session's output was actually good, so teamspend never
 * claims to know that. It only ever reports what a session cost.
 */
export interface SessionUsage {
  sessionId: string;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  requests: number | null;
  isEstimated: boolean;
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
  /**
   * Per-session (per-conversation) cost breakdown, populated only by
   * adapters whose underlying data source actually exposes a session
   * identifier -- local-log-based adapters (claude-code-personal,
   * opencode), which parse a real sessionId/sessionID out of each log
   * entry. Admin-API-based adapters (cursor, claude-code, copilot) report
   * aggregate per-user totals only, with no session concept anywhere in
   * their response shape, so they leave this field undefined rather than
   * fabricating session boundaries that don't exist. Optional so every
   * adapter that predates this field keeps working unchanged.
   */
  sessions?: SessionUsage[];
}

/** Normalized shape every adapter (and the CSV-import fallback) maps into. */
export interface AdapterResult {
  source: ToolId;
  window: DateWindow;
  totalCostUsd: number;
  isEstimated: boolean;
  users: UserUsage[];
}

/** Supported values for the CLI's `--breakdown` flag. */
export type BreakdownMode = "session";

export function sumCost(users: UserUsage[]): number {
  return users.reduce((total, user) => total + user.costUsd, 0);
}

export function topSpenders(users: UserUsage[], limit: number): UserUsage[] {
  return [...users].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}

export function topSessions(
  sessions: SessionUsage[],
  limit: number,
): SessionUsage[] {
  return [...sessions].sort((a, b) => b.costUsd - a.costUsd).slice(0, limit);
}

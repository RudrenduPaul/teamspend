import { readdir, readFile, stat } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { DataUnavailableError } from "../errors.js";
import { sumCost } from "../schema.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const TOOL = "claude-code-personal";

interface ClaudeCodeLogUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ClaudeCodeLogEntry {
  timestamp?: string;
  message?: {
    id?: string;
    usage?: ClaudeCodeLogUsage;
  };
  requestId?: string;
  costUSD?: number;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the directory (or directories) to scan for Claude Code session
 * logs, in the same order Claude Code itself resolves its config dir:
 *
 * 1. `CLAUDE_CONFIG_DIR` (comma-separated list -- every entry is scanned,
 *    not just the first). Each entry may either already point at a
 *    `projects/` directory or be the parent config dir that contains one.
 * 2. Else, the XDG-style location (`$XDG_CONFIG_HOME/claude/projects`,
 *    defaulting `XDG_CONFIG_HOME` itself to `~/.config` per the XDG spec)
 *    IF that directory exists.
 * 3. Else, the legacy default: `~/.claude/projects`.
 *
 * Only one of (2)/(3) is ever returned -- they're alternatives, not both
 * scanned -- while (1) can return several directories at once.
 */
export async function resolveProjectsDirs(): Promise<string[]> {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    return override
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) =>
        path.basename(entry) === "projects"
          ? entry
          : path.join(entry, "projects"),
      );
  }

  const xdgBase =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(homedir(), ".config");
  const xdgProjectsDir = path.join(xdgBase, "claude", "projects");
  if (await pathExists(xdgProjectsDir)) {
    return [xdgProjectsDir];
  }

  return [path.join(homedir(), ".claude", "projects")];
}

/**
 * Recursively collects every `*.jsonl` file under `dir`, including nested
 * `subagents/` subdirectories. A missing/unreadable directory yields an
 * empty list rather than throwing -- the caller decides what "no files
 * anywhere" means (DataUnavailableError), not this low-level walker.
 */
async function collectJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

function withinWindow(timestamp: string, window: DateWindow): boolean {
  const date = timestamp.slice(0, 10);
  return date >= window.start && date <= window.end;
}

/**
 * Best-effort local identity for the single user this mode reports on.
 * There is no admin API here, so there is no vendor-supplied user_id/email
 * to fall back on (unlike cursor.ts/claude-code.ts) -- os.userInfo().username
 * is the closest reliable local signal, matching csv-import.ts's precedent
 * of using whatever identity is directly at hand rather than guessing.
 * Falls back to a fixed placeholder if the OS refuses to answer (some
 * minimal containers have no passwd entry for the running uid).
 */
function resolveLocalUserId(): string {
  try {
    const info = userInfo();
    if (info.username && info.username.trim().length > 0) {
      return info.username;
    }
  } catch {
    // userInfo() throws on some platforms/containers without a passwd entry.
  }
  return "local-user";
}

/**
 * Reads Claude Code's own local JSONL session logs and reports the single
 * local user's usage for `window` -- no admin API, no network call, no
 * credential. For people who just want their own personal Claude Code
 * spend/usage without team/admin access.
 *
 * Entries are deduped by the (message.id, requestId) pair before summing,
 * since retried requests can appear more than once in the logs. `costUSD`
 * is trusted when present on a line; when it's absent, that line still
 * contributes its token counts but NOT a dollar amount, and the whole
 * result is flagged `isEstimated` -- matching this codebase's existing
 * "never present a guess as an exact number" rule (see cursor.ts/
 * claude-code.ts's suspicious-zero handling for the same philosophy).
 */
export async function fetchClaudeCodePersonalUsage(
  window: DateWindow,
): Promise<AdapterResult> {
  const projectsDirs = await resolveProjectsDirs();

  const jsonlFiles: string[] = [];
  for (const dir of projectsDirs) {
    jsonlFiles.push(...(await collectJsonlFiles(dir)));
  }

  if (jsonlFiles.length === 0) {
    throw new DataUnavailableError(
      TOOL,
      `no Claude Code session logs (*.jsonl) found under ${projectsDirs.join(", ")} (checked recursively, including subagents/ subdirectories)`,
    );
  }

  const seenKeys = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requests = 0;
  let costUsd = 0;
  let isEstimated = false;

  for (const file of jsonlFiles) {
    const contents = await readFile(file, "utf-8");
    const lines = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const line of lines) {
      let entry: ClaudeCodeLogEntry;
      try {
        entry = JSON.parse(line) as ClaudeCodeLogEntry;
      } catch {
        // Skip a corrupted/partial line rather than failing the whole read
        // -- Claude Code's own logs can end mid-write if a session crashes.
        continue;
      }

      if (!entry.timestamp || !withinWindow(entry.timestamp, window)) {
        continue;
      }

      const messageId = entry.message?.id;
      const requestId = entry.requestId;
      if (messageId || requestId) {
        const dedupeKey = `${messageId ?? ""}::${requestId ?? ""}`;
        if (seenKeys.has(dedupeKey)) {
          continue;
        }
        seenKeys.add(dedupeKey);
      }

      const usage = entry.message?.usage;
      inputTokens += usage?.input_tokens ?? 0;
      outputTokens += usage?.output_tokens ?? 0;
      cacheReadTokens += usage?.cache_read_input_tokens ?? 0;
      cacheWriteTokens += usage?.cache_creation_input_tokens ?? 0;
      requests += 1;

      if (typeof entry.costUSD === "number") {
        costUsd += entry.costUSD;
      } else {
        isEstimated = true;
      }
    }
  }

  const user: UserUsage = {
    userId: resolveLocalUserId(),
    userEmail: null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    requests,
    costUsd,
    isEstimated,
  };

  const users = [user];
  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: users.some((u) => u.isEstimated),
    users,
  };
}

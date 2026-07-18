import { readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { DataUnavailableError } from "../errors.js";
import { sumCost } from "../schema.js";
import type { AdapterResult, DateWindow, UserUsage } from "../schema.js";

const TOOL = "codex";

/**
 * Codex CLI (github.com/openai/codex, OpenAI's coding agent CLI) has no
 * admin/team/billing API -- it is a local CLI with its own local session
 * logs, the same shape as claude-code-personal.ts and opencode.ts. Verified
 * directly against openai/codex's own Rust source (not a third-party
 * guess):
 *
 * - `codex-rs/utils/home-dir/src/lib.rs::find_codex_home` -- resolves via
 *   the `CODEX_HOME` env var, defaulting to `~/.codex` if unset. Unlike
 *   Claude Code's `CLAUDE_CONFIG_DIR`, this is a single path, never a
 *   comma-separated list.
 * - `codex-rs/rollout/src/lib.rs` -- `SESSIONS_SUBDIR = "sessions"` and
 *   `ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"`, both scanned below.
 * - `codex-rs/rollout/src/list.rs` (doc comment) -- on-disk layout is
 *   `<codex_home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
 * - `codex-rs/protocol/src/protocol.rs::TokenUsage` / `TokenUsageInfo` --
 *   the exact per-turn usage record shape read below (`input_tokens`,
 *   `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
 *   `reasoning_output_tokens`, `total_tokens`, wrapped in
 *   `{ total_token_usage, last_token_usage }`).
 * - `codex-rs/codex-api/src/sse/responses.rs` -- confirms `input_tokens`
 *   in that struct is copied straight from OpenAI's Responses API
 *   `usage.input_tokens`, which already *includes* `cached_tokens` as a
 *   subset (its own test fixture: `input_tokens: 100`,
 *   `cached_tokens: 40`), not an additional amount.
 *
 * Cross-checked against ccusage's own Codex guide
 * (ccusage.com/guide/codex/) and mrexodia/agent-cost-dashboard's
 * `cost_dashboard.py` (`analyze_codex_jsonl_file`), which parse the
 * identical record shapes independently -- both agree with the Rust
 * source on every field name.
 *
 * **Cold-storage limitation**: `codex-rs/rollout/src/compression.rs`
 * background-compresses any rollout file older than 7 days
 * (`MIN_ROLLOUT_AGE`) from `rollout-*.jsonl` to `rollout-*.jsonl.zst`
 * (zstd). This adapter only reads plain `.jsonl` files -- the same
 * tradeoff opencode.ts already made for OpenCode's newer SQLite store:
 * this package adds no dependency (native or WASM) for a secondary
 * on-disk format. A requested window reaching back more than ~7 days will
 * under-report or come back empty for Codex; use the CSV-import fallback
 * to cover that period.
 */
const CODEX_HOME_ENV = "CODEX_HOME";
const SESSIONS_SUBDIR = "sessions";
const ARCHIVED_SESSIONS_SUBDIR = "archived_sessions";

interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface CodexTokenUsageInfo {
  total_token_usage?: CodexTokenUsage;
  last_token_usage?: CodexTokenUsage;
}

interface CodexEventMsgPayload {
  type?: string;
  info?: CodexTokenUsageInfo;
}

interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: CodexEventMsgPayload;
}

/**
 * Resolves the directories to scan for local Codex CLI session logs:
 * `<CODEX_HOME>/sessions` and `<CODEX_HOME>/archived_sessions`, where
 * `CODEX_HOME` defaults to `~/.codex` (see module doc comment for the
 * source citation). Falls back to `HOME`/`USERPROFILE` off the same `env`
 * object (rather than calling `os.homedir()` directly) so tests can inject
 * a fake home directory the same way `resolveOpenCodeDataDirs` does.
 */
export function resolveCodexSessionsDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env[CODEX_HOME_ENV]?.trim();
  if (override && override.length > 0) {
    return [
      path.join(override, SESSIONS_SUBDIR),
      path.join(override, ARCHIVED_SESSIONS_SUBDIR),
    ];
  }

  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  const codexHome = path.join(home, ".codex");
  return [
    path.join(codexHome, SESSIONS_SUBDIR),
    path.join(codexHome, ARCHIVED_SESSIONS_SUBDIR),
  ];
}

/**
 * Recursively collects every plain `*.jsonl` rollout file under `dir` (the
 * real layout nests them `YYYY/MM/DD/rollout-*.jsonl`, but this walks
 * arbitrarily deep rather than hardcoding that depth). `*.jsonl.zst`
 * (compressed, cold) siblings are deliberately skipped -- see the module
 * doc comment. A missing/unreadable directory yields an empty list rather
 * than throwing -- the caller decides what "no files anywhere" means
 * (DataUnavailableError), not this low-level walker.
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
 * Best-effort local identity for the single user this mode reports on --
 * same rationale and fallback as claude-code-personal.ts/opencode.ts: no
 * admin API here means no vendor-supplied user_id/email to fall back on.
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
 * Reads Codex CLI's own local JSONL rollout logs and reports the single
 * local user's token usage for `window` -- no admin API, no network call,
 * no credential.
 *
 * Codex's `event_msg` records with `payload.type === "token_count"` carry
 * per-turn token counts but, unlike Cursor/Claude Code's admin APIs,
 * **no cost field at all** -- not even a `cost: 0` placeholder the way
 * OpenCode's message files have. teamspend bundles no per-token pricing
 * table of its own (the same call opencode.ts already made, for the same
 * reason: a bundled table drifts from real vendor prices and is exactly
 * the kind of guessed data this package avoids). `costUsd` is therefore
 * always `0` and the result is always `isEstimated: true` when any usage
 * is found -- token counts are exact, dollars are simply not reported by
 * Codex at all.
 *
 * `last_token_usage` on each `token_count` event is already the per-turn
 * delta (Codex's own `TokenUsageInfo::append_last_usage` sets it verbatim
 * per turn, distinct from the cumulative `total_token_usage`), so this
 * reads it directly rather than diffing consecutive cumulative totals.
 * Sessions old enough for `last_token_usage` to be entirely absent predate
 * the current schema and, per the cold-storage limitation above, will
 * already have been compressed to `.jsonl.zst` and skipped -- such lines
 * are simply skipped here too rather than deriving a delta from
 * `total_token_usage`.
 *
 * Codex emits each `token_count` event twice in a row with byte-identical
 * `info` -- confirmed independently by mrexodia/agent-cost-dashboard's own
 * parser, which carries the same dedup -- so a repeated `info` blob
 * (matched by structural equality, not object identity) is skipped rather
 * than double-counted.
 *
 * `input_tokens` in Codex's schema already includes `cached_input_tokens`
 * as a subset (see module doc comment), so this stores the net, uncached
 * portion as `inputTokens` to avoid double-counting input and cache-read
 * tokens the way `cacheReadTokens` already accounts for the cached
 * portion.
 */
export async function fetchCodexUsage(
  window: DateWindow,
  sessionsDirs: string[] = resolveCodexSessionsDirs(),
): Promise<AdapterResult> {
  const jsonlFiles: string[] = [];
  for (const dir of sessionsDirs) {
    jsonlFiles.push(...(await collectJsonlFiles(dir)));
  }

  if (jsonlFiles.length === 0) {
    throw new DataUnavailableError(
      TOOL,
      `no Codex CLI session logs (*.jsonl) found under ${sessionsDirs.join(", ")} -- codex has no admin/team API, only local per-machine rollout logs (set CODEX_HOME to override)`,
    );
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requests = 0;

  for (const file of jsonlFiles) {
    const contents = await readFile(file, "utf-8");
    const lines = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    let previousSignature: string | null = null;

    for (const line of lines) {
      let record: CodexRecord;
      try {
        record = JSON.parse(line) as CodexRecord;
      } catch {
        // Skip a corrupted/partial line rather than failing the whole
        // read -- a rollout file can end mid-write if Codex crashes or is
        // killed mid-turn.
        continue;
      }

      if (
        record.type !== "event_msg" ||
        record.payload?.type !== "token_count"
      ) {
        continue;
      }

      const info = record.payload.info;
      if (!info) continue;

      const signature = JSON.stringify(info);
      if (signature === previousSignature) {
        // Codex fires each token_count event twice in a row with
        // identical usage -- see module doc comment.
        continue;
      }
      previousSignature = signature;

      const usage = info.last_token_usage;
      if (!usage) continue;

      const timestamp = record.timestamp;
      if (!timestamp || !withinWindow(timestamp, window)) continue;

      const rawInput = usage.input_tokens ?? 0;
      const cachedInput = usage.cached_input_tokens ?? 0;
      inputTokens += Math.max(0, rawInput - cachedInput);
      cacheReadTokens += cachedInput;
      cacheWriteTokens += usage.cache_write_input_tokens ?? 0;
      outputTokens += usage.output_tokens ?? 0;
      requests += 1;
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
    costUsd: 0,
    isEstimated: true,
  };

  const users = requests > 0 ? [user] : [];
  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: users.length > 0,
    users,
  };
}

import { readFile, readdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { DataUnavailableError } from "../errors.js";
import { sumCost } from "../schema.js";
import type {
  AdapterResult,
  DateWindow,
  SessionUsage,
  UserUsage,
} from "../schema.js";

const TOOL = "opencode";

/**
 * OpenCode (github.com/anomalyco/opencode, formerly sst/opencode -- the
 * GitHub org renamed and the old slug now redirects) has no admin/team/
 * billing API at all -- confirmed against its own README, which describes
 * only a local CLI with no organization-level usage endpoint. Every
 * session/message is written to local JSON files under
 * `$OPENCODE_DATA_DIR/storage/message/{sessionID}/msg_{messageID}.json`
 * (default data dir: `~/.local/share/opencode`, including on Windows --
 * OpenCode follows the XDG layout on every platform). Verified two ways:
 * ccusage's own OpenCode data-source guide (ccusage.com/guide/opencode/,
 * already this codebase's cited prior art for adapter quirks -- see the
 * ccusage/ccusage#1113 reference in cursor.ts) documents this exact path
 * and the `OPENCODE_DATA_DIR` override; tokscale's README
 * (github.com/junhoyeo/tokscale) independently lists the same
 * `~/.local/share/opencode/storage/message/` path as its "legacy/
 * unmigrated" fallback alongside a newer SQLite `opencode.db` (v1.2+) that
 * tokscale also reads but this adapter does not -- adding a SQLite
 * dependency (native bindings, or Node's built-in `node:sqlite` which needs
 * Node 22.5+) isn't worth it against this package's `>=18.3.0` engine
 * floor, so only the plain-JSON message-file format is supported for now.
 *
 * The per-message field shapes below (tokens.input/output/reasoning,
 * tokens.cache.read/write, cost, modelID, providerID) are taken verbatim
 * from OpenCode's own generated SDK types
 * (packages/sdk/js/src/gen/types.gen.ts, dev branch, AssistantMessage).
 */
const OPENCODE_DATA_DIR_ENV = "OPENCODE_DATA_DIR";

interface OpenCodeTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface OpenCodeMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  time?: { created?: number; completed?: number };
  cost?: number;
  tokens?: OpenCodeTokens;
}

/**
 * Resolves the directories to scan for local OpenCode message logs.
 * `OPENCODE_DATA_DIR` may name a single directory or a comma-separated list
 * (ccusage's own adapter supports the same override for the same reason:
 * OpenCode can be pointed at more than one data root). Falls back to the
 * documented default, `~/.local/share/opencode` -- including on Windows,
 * where OpenCode still uses the XDG-style relative path under
 * `%USERPROFILE%`.
 */
export function resolveOpenCodeDataDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const envValue = env[OPENCODE_DATA_DIR_ENV];
  if (envValue && envValue.trim().length > 0) {
    return envValue
      .split(",")
      .map((dir) => dir.trim())
      .filter((dir) => dir.length > 0);
  }

  const home = env.HOME ?? env.USERPROFILE;
  if (!home) return [];
  return [join(home, ".local", "share", "opencode")];
}

function windowBoundsMs(window: DateWindow): { startMs: number; endMs: number } {
  return {
    startMs: new Date(`${window.start}T00:00:00.000Z`).getTime(),
    endMs: new Date(`${window.end}T23:59:59.999Z`).getTime(),
  };
}

/**
 * Lists every message JSON file under each session subdirectory of
 * `<dataDir>/storage/message/`. Missing directories (data dir doesn't
 * exist, or a session subdirectory disappeared mid-scan) resolve to an
 * empty list rather than throwing -- this is local disk state being read
 * opportunistically, not a versioned API contract, and a half-written or
 * already-cleaned-up session shouldn't fail the whole scan.
 */
async function listMessageFiles(dataDir: string): Promise<string[]> {
  const messageDir = join(dataDir, "storage", "message");
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(messageDir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const sessionDir of sessionDirs) {
    const sessionPath = join(messageDir, sessionDir);
    let entries: string[];
    try {
      entries = await readdir(sessionPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".json")) {
        files.push(join(sessionPath, entry));
      }
    }
  }
  return files;
}

/**
 * Fetches local OpenCode spend for the given window by scanning message
 * JSON files directly on disk -- there is no admin API to call. Unlike the
 * Cursor/Claude Code adapters, this can only ever see the current machine's
 * own local usage: OpenCode's message files carry no user/email field at
 * all (confirmed against its own SDK types -- it's a single-developer local
 * tool with no team concept), so every message found is attributed to one
 * synthetic user: the OS account running `teamspend`. Rolling up spend
 * across a real team means running `teamspend` on each person's machine (or
 * collecting their numbers out of band and using the CSV-import fallback).
 *
 * Throws DataUnavailableError when no local message store is found at all
 * (missing data dir, or a data dir with no `storage/message` files), so the
 * CSV-import fallback engages the same way it does for a tool whose live
 * API can't cover part of the window. A data dir that exists but has no
 * messages *inside the requested window* is a different, legitimate case
 * (an inactive period) and returns a normal empty-users result instead.
 */
export async function fetchOpenCodeSpend(
  window: DateWindow,
  dataDirs: string[] = resolveOpenCodeDataDirs(),
): Promise<AdapterResult> {
  const allFiles: string[] = [];
  for (const dir of dataDirs) {
    allFiles.push(...(await listMessageFiles(dir)));
  }

  if (allFiles.length === 0) {
    throw new DataUnavailableError(
      TOOL,
      `no local OpenCode message logs found under ${dataDirs.length > 0 ? dataDirs.join(", ") : "(no data directory resolved -- set OPENCODE_DATA_DIR or $HOME)"} -- opencode has no admin/team API, only local per-machine session logs`,
    );
  }

  const { startMs, endMs } = windowBoundsMs(window);

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let requests = 0;
  let costUsd = 0;
  // Per-session totals, keyed by each message's own sessionID (the same
  // sessionID that names its parent storage/message/{sessionID}/ directory).
  // A message with no sessionID (shouldn't happen in real OpenCode output,
  // but the field is optional on the type) still contributes to the flat
  // totals above, just not to this map.
  const sessionTotals = new Map<
    string,
    { costUsd: number; inputTokens: number; outputTokens: number; requests: number }
  >();

  for (const file of allFiles) {
    let raw: OpenCodeMessage;
    try {
      raw = JSON.parse(await readFile(file, "utf-8")) as OpenCodeMessage;
    } catch {
      // Corrupt or partially-written file (e.g. opencode was mid-write when
      // this ran) -- skip it rather than failing the entire snapshot over
      // one bad file among what can be thousands on an active machine.
      continue;
    }

    if (raw.role !== "assistant") continue;
    const createdMs = raw.time?.created;
    if (createdMs === undefined || createdMs < startMs || createdMs > endMs) {
      continue;
    }

    requests += 1;
    const messageInputTokens = raw.tokens?.input ?? 0;
    const messageOutputTokens = raw.tokens?.output ?? 0;
    const messageCost = raw.cost ?? 0;
    inputTokens += messageInputTokens;
    outputTokens += messageOutputTokens;
    cacheReadTokens += raw.tokens?.cache?.read ?? 0;
    cacheWriteTokens += raw.tokens?.cache?.write ?? 0;
    costUsd += messageCost;

    if (raw.sessionID) {
      const existing = sessionTotals.get(raw.sessionID) ?? {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
      };
      existing.costUsd += messageCost;
      existing.inputTokens += messageInputTokens;
      existing.outputTokens += messageOutputTokens;
      existing.requests += 1;
      sessionTotals.set(raw.sessionID, existing);
    }
  }

  if (requests === 0) {
    return { source: TOOL, window, totalCostUsd: 0, isEstimated: false, users: [] };
  }

  // Only attach `sessions` when at least one message actually carried a
  // sessionID -- an empty array would misleadingly claim "zero sessions"
  // rather than "couldn't group anything."
  const sessions: SessionUsage[] | undefined =
    sessionTotals.size > 0
      ? [...sessionTotals.entries()].map(([sessionId, totals]) => ({
          sessionId,
          costUsd: totals.costUsd,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          requests: totals.requests,
          // Same reasoning as the overall result below: OpenCode has no
          // real cost source of truth, so every session's dollar figure is
          // just as estimated as the aggregate one.
          isEstimated: true,
        }))
      : undefined;

  const users: UserUsage[] = [
    {
      userId: userInfo().username,
      userEmail: null,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      requests,
      costUsd,
      // OpenCode has no admin-billed source of truth for cost the way
      // Cursor/Claude Code do. Per ccusage's own OpenCode guide: "OpenCode
      // stores cost: 0 in message files. Costs are calculated from token
      // counts using LiteLLM pricing." teamspend bundles no per-token
      // pricing table of its own -- one would drift from real vendor
      // prices and would be exactly the kind of guessed data format this
      // adapter is supposed to avoid -- so it only ever sums whatever cost
      // OpenCode itself recorded (frequently $0) and always flags the
      // result as estimated, even on the rare message where that field is
      // genuinely populated.
      isEstimated: true,
      // Conditionally spread rather than always assigning `sessions:
      // sessions` -- with exactOptionalPropertyTypes, an explicit
      // `undefined` value is not the same as the key being absent.
      ...(sessions ? { sessions } : {}),
    },
  ];

  return {
    source: TOOL,
    window,
    totalCostUsd: sumCost(users),
    isEstimated: true,
    users,
  };
}

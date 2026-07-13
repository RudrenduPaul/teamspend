#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchCursorSpend } from "./adapters/cursor.js";
import { fetchClaudeCodeSpend } from "./adapters/claude-code.js";
import { importFromCSV } from "./adapters/csv-import.js";
import { buildComparison, type PeriodOutcome } from "./compare.js";
import {
  renderTerminalSummary,
  writeJsonReport,
  scaffoldGitignore,
} from "./output.js";
import { InvalidCliArgError, DataUnavailableError } from "./errors.js";
import type { DateWindow, ToolId } from "./schema.js";

const KNOWN_TOOLS: ToolId[] = ["cursor", "claude-code"];
const DATE_RANGE_RE = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;

const USAGE =
  "Usage: teamspend snapshot --tools <a>,<b> --before YYYY-MM-DD:YYYY-MM-DD --after YYYY-MM-DD:YYYY-MM-DD [--json] [--before-csv <path>] [--after-csv <path>]";

const HELP_TEXT = `${USAGE}

teamspend compares AI coding tool spend before and after a migration, pulled
directly from each vendor's own admin API.

Commands:
  snapshot    Compare spend between two tools over two date windows (the only command)

Options for "snapshot":
  --tools <a>,<b>       Exactly two of: ${KNOWN_TOOLS.join(", ")}
  --before <range>      Before-migration window, YYYY-MM-DD:YYYY-MM-DD
  --after <range>       After-migration window, YYYY-MM-DD:YYYY-MM-DD
  --json                Print the full report as JSON instead of a terminal summary
  --before-csv <path>   CSV fallback for the before window, if the tool's API doesn't cover it
  --after-csv <path>    CSV fallback for the after window
  --help, -h            Show this help

Environment variables (set the ones for the tools you're comparing):
  TEAMSPEND_CURSOR_TOKEN         Cursor Admin API key
  TEAMSPEND_CLAUDE_CODE_TOKEN    Anthropic Admin/Analytics API key

Example:
  teamspend snapshot --tools cursor,claude-code --before 2026-04-01:2026-04-30 --after 2026-06-01:2026-06-30

Docs: https://github.com/RudrenduPaul/teamspend`;

function parseDateRange(flag: string, value: string): DateWindow {
  const match = DATE_RANGE_RE.exec(value);
  if (!match?.[1] || !match?.[2]) {
    throw new InvalidCliArgError(
      `--${flag} must be in the form YYYY-MM-DD:YYYY-MM-DD, got "${value}"`,
    );
  }
  return { start: match[1], end: match[2] };
}

function validateTools(rawTools: string): [ToolId, ToolId] {
  const parts = rawTools.split(",").map((t) => t.trim());
  if (parts.length !== 2) {
    throw new InvalidCliArgError(
      `--tools must name exactly two tools, got "${rawTools}"`,
    );
  }
  for (const tool of parts) {
    if (!KNOWN_TOOLS.includes(tool as ToolId)) {
      throw new InvalidCliArgError(
        `Unknown tool "${tool}" -- expected one of: ${KNOWN_TOOLS.join(", ")}`,
      );
    }
  }
  return parts as [ToolId, ToolId];
}

function validateWindowOrder(before: DateWindow, after: DateWindow): void {
  if (before.start >= after.start) {
    throw new InvalidCliArgError(
      `--before (${before.start}) must be earlier than --after (${after.start})`,
    );
  }
}

async function fetchTool(
  tool: ToolId,
  window: DateWindow,
  csvPath: string | undefined,
): Promise<PeriodOutcome["result"]> {
  const envVar = `TEAMSPEND_${tool.toUpperCase().replace(/-/g, "_")}_TOKEN`;
  const apiKey = process.env[envVar];

  try {
    if (tool === "cursor") {
      if (!apiKey) throw new Error(`Missing ${envVar}`);
      return await fetchCursorSpend(window, apiKey);
    }
    if (tool === "claude-code") {
      if (!apiKey) throw new Error(`Missing ${envVar}`);
      return await fetchClaudeCodeSpend(window, apiKey);
    }
    throw new InvalidCliArgError(`No adapter for tool "${tool}"`);
  } catch (error) {
    if (error instanceof DataUnavailableError && csvPath) {
      return await importFromCSV(csvPath, tool, window);
    }
    throw error;
  }
}

type SubcommandResolution =
  | { handled: true; exitCode: number }
  | { handled: false; args: string[] };

/**
 * Consumes the leading "snapshot" subcommand token and handles --help at
 * either position (`teamspend --help` or `teamspend snapshot --help`),
 * before flag parsing ever sees them. Node's parseArgs (strict, no
 * positionals by default) would otherwise reject "snapshot" itself as an
 * unexpected positional argument -- which is exactly what every README
 * example command did before this fix, since nothing consumed that token.
 */
function resolveSubcommand(argv: string[]): SubcommandResolution {
  if (argv.length === 0) {
    console.error(USAGE);
    return { handled: true, exitCode: 1 };
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    console.log(HELP_TEXT);
    return { handled: true, exitCode: 0 };
  }

  const [subcommand, ...rest] = argv;
  if (subcommand !== "snapshot") {
    console.error(
      `Unknown command "${subcommand}" -- teamspend only has one command: "snapshot". Run "teamspend --help" for usage.`,
    );
    return { handled: true, exitCode: 1 };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(HELP_TEXT);
    return { handled: true, exitCode: 0 };
  }

  return { handled: false, args: rest };
}

export async function run(argv: string[]): Promise<number> {
  const subcommand = resolveSubcommand(argv);
  if (subcommand.handled) return subcommand.exitCode;

  let parsed;
  try {
    parsed = parseArgs({
      args: subcommand.args,
      options: {
        tools: { type: "string" },
        before: { type: "string" },
        after: { type: "string" },
        json: { type: "boolean", default: false },
        "before-csv": { type: "string" },
        "after-csv": { type: "string" },
      },
    });
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const { values } = parsed;

  try {
    if (!values.tools || !values.before || !values.after) {
      console.error(USAGE);
      return 1;
    }

    const [beforeTool, afterTool] = validateTools(values.tools);
    const beforeWindow = parseDateRange("before", values.before);
    const afterWindow = parseDateRange("after", values.after);
    validateWindowOrder(beforeWindow, afterWindow);

    const [beforeSettled, afterSettled] = await Promise.allSettled([
      fetchTool(beforeTool, beforeWindow, values["before-csv"]),
      fetchTool(afterTool, afterWindow, values["after-csv"]),
    ]);

    const before: PeriodOutcome = {
      label: "before",
      tool: beforeTool,
      result: beforeSettled.status === "fulfilled" ? beforeSettled.value : null,
      error:
        beforeSettled.status === "rejected"
          ? (beforeSettled.reason as Error)
          : null,
    };
    const after: PeriodOutcome = {
      label: "after",
      tool: afterTool,
      result: afterSettled.status === "fulfilled" ? afterSettled.value : null,
      error:
        afterSettled.status === "rejected"
          ? (afterSettled.reason as Error)
          : null,
    };

    const report = buildComparison(before, after);
    const cwd = process.cwd();
    const scaffolded = await scaffoldGitignore(cwd);
    const jsonPath = await writeJsonReport(report, cwd);

    if (scaffolded) {
      console.error(
        "Note: teamspend-snapshot-*.json contains per-user email and spend data -- added to .gitignore.",
      );
    }

    // Printed every run, not just on first-run gitignore scaffolding: a
    // .gitignore entry protects the on-disk file, but does nothing about
    // this same per-user email + spend data being printed to stdout, which
    // lands in CI build logs (often world-readable for public repos) if
    // this command is wired into a scheduled workflow (found during the
    // [redacted ]review).
    console.error(
      "Note: this output includes per-user email and spend data. If running in CI, confirm build logs are private.",
    );

    if (values.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderTerminalSummary(report));
      console.log(`\nFull report: ${jsonPath}`);
    }

    return before.result && after.result ? 0 : 1;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

// Resolve both sides through realpathSync before comparing. A plain
// `import.meta.url === file://${process.argv[1]}` string comparison breaks
// on macOS whenever the invocation path traverses a symlink (e.g.
// /tmp -> /private/tmp), since import.meta.url resolves the real path while
// process.argv[1] keeps the as-typed one, so the strings silently never
// match and the CLI no-ops with no error. (import.meta.main would sidestep
// this too, but it requires Node 22.18+/24.2+ and is still Early
// Development stability, too new for this package's >=18.3.0 floor.)
const isMainModule = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? "");
  } catch {
    return false;
  }
})();

if (isMainModule) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}

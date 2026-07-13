import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./cli.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("run (CLI validation)", () => {
  let tmpDir: string;
  let originalCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-cli-test-"));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an unknown tool name", async () => {
    const code = await run([
      "snapshot",
      "--tools",
      "cursor,unknown-tool",
      "--before",
      "2026-01-01:2026-01-31",
      "--after",
      "2026-02-01:2026-02-28",
    ]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown tool "unknown-tool"'),
    );
  });

  it("rejects a malformed date", async () => {
    const code = await run([
      "snapshot",
      "--tools",
      "cursor,claude-code",
      "--before",
      "not-a-date",
      "--after",
      "2026-02-01:2026-02-28",
    ]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--before must be in the form"),
    );
  });

  it("rejects --before later than or equal to --after", async () => {
    const code = await run([
      "snapshot",
      "--tools",
      "cursor,claude-code",
      "--before",
      "2026-03-01:2026-03-31",
      "--after",
      "2026-02-01:2026-02-28",
    ]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("must be earlier than"),
    );
  });

  it("shows usage text when invoked with no arguments at all", async () => {
    const code = await run([]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: teamspend snapshot"),
    );
  });

  it("shows usage text when the snapshot subcommand is missing required flags", async () => {
    const code = await run(["snapshot"]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: teamspend snapshot"),
    );
  });

  it("prints full help and exits 0 for `teamspend --help`", async () => {
    const logSpy = vi.spyOn(console, "log");
    const code = await run(["--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
  });

  it("prints full help and exits 0 for `teamspend snapshot --help`", async () => {
    const logSpy = vi.spyOn(console, "log");
    const code = await run(["snapshot", "--help"]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Commands:"));
  });

  it("rejects an unknown subcommand with a clear error naming the only real one", async () => {
    const code = await run(["bogus-command"]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Unknown command "bogus-command"'),
    );
  });

  it("runs end-to-end with both adapters succeeding and writes the JSON report", async () => {
    process.env.TEAMSPEND_CURSOR_TOKEN = "test-cursor-key";
    process.env.TEAMSPEND_CLAUDE_CODE_TOKEN = "test-claude-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "a@x.com",
              input_tokens: 1,
              output_tokens: 1,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              requests: 1,
              cost_usd: 10,
              spend_usd: 10,
            },
          ],
        }),
      ),
    );

    const code = await run([
      "snapshot",
      "--tools",
      "cursor,claude-code",
      "--before",
      "2026-06-01:2026-06-30",
      "--after",
      "2026-07-01:2026-07-31",
    ]);
    expect(code).toBe(0);

    delete process.env.TEAMSPEND_CURSOR_TOKEN;
    delete process.env.TEAMSPEND_CLAUDE_CODE_TOKEN;
  });
});

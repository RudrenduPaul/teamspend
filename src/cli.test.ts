import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "./cli.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("run (CLI validation)", () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalConfigDir: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-cli-test-"));
    originalCwd = process.cwd();
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.chdir(tmpDir);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects an unknown tool name", async () => {
    const code = await run([
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

  it("shows usage text when required flags are missing", async () => {
    const code = await run([]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Usage: teamspend snapshot"),
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

  it("falls back to --before-csv when the tool's API token is simply missing, not just when the window predates API history (regression: missing-token check threw a plain Error that bypassed the DataUnavailableError CSV fallback)", async () => {
    delete process.env.TEAMSPEND_CURSOR_TOKEN;
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

    const csvPath = path.join(tmpDir, "before.csv");
    await writeFile(
      csvPath,
      "date,user_email,cost_usd,is_estimated\n2025-11-01,jane@example.com,12.50,false\n",
    );

    const code = await run([
      "--tools",
      "cursor,claude-code",
      "--before",
      "2025-11-01:2025-11-30",
      "--after",
      "2026-07-01:2026-07-31",
      "--before-csv",
      csvPath,
    ]);
    expect(code).toBe(0);

    const files = (await readdir(tmpDir)).filter((f) =>
      f.startsWith("teamspend-snapshot-"),
    );
    expect(files).toHaveLength(1);
    const contents = await readFile(path.join(tmpDir, files[0] as string), "utf-8");
    const report = JSON.parse(contents) as Record<string, unknown>;
    const before = report.before as {
      result: { users: Array<{ userEmail: string; costUsd: number }> };
    };
    expect(before.result.users[0]?.userEmail).toBe("jane@example.com");
    expect(before.result.users[0]?.costUsd).toBe(12.5);

    delete process.env.TEAMSPEND_CLAUDE_CODE_TOKEN;
  });

  it("still reports DATA UNAVAILABLE naming the missing token when no CSV fallback is provided", async () => {
    delete process.env.TEAMSPEND_CURSOR_TOKEN;
    process.env.TEAMSPEND_CLAUDE_CODE_TOKEN = "test-claude-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        jsonResponse(200, {
          users: [],
        }),
      ),
    );

    const code = await run([
      "--tools",
      "cursor,claude-code",
      "--before",
      "2026-06-01:2026-06-30",
      "--after",
      "2026-07-01:2026-07-31",
    ]);
    expect(code).toBe(1);

    const terminalOutput = logSpy.mock.calls.map((call) => call[0]).join("\n");
    expect(terminalOutput).toContain("DATA UNAVAILABLE");
    expect(terminalOutput).toContain("TEAMSPEND_CURSOR_TOKEN");

    delete process.env.TEAMSPEND_CLAUDE_CODE_TOKEN;
  });

  it("rejects an unrecognized --breakdown value", async () => {
    const code = await run([
      "--tools",
      "cursor,claude-code",
      "--before",
      "2026-01-01:2026-01-31",
      "--after",
      "2026-02-01:2026-02-28",
      "--breakdown",
      "bogus",
    ]);
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--breakdown must be one of"),
    );
  });

  describe("--breakdown session", () => {
    async function writeClaudeCodePersonalFixture(): Promise<void> {
      const projectsDir = path.join(tmpDir, "claude-config", "projects", "proj");
      await mkdir(projectsDir, { recursive: true });
      const lines = [
        {
          timestamp: "2026-06-05T10:00:00.000Z",
          sessionId: "before-session",
          message: { id: "m1", usage: { input_tokens: 100, output_tokens: 20 } },
          requestId: "r1",
          costUSD: 0.5,
        },
        {
          timestamp: "2026-06-20T10:00:00.000Z",
          sessionId: "after-session",
          message: { id: "m2", usage: { input_tokens: 200, output_tokens: 40 } },
          requestId: "r2",
          costUSD: 1.5,
        },
      ];
      await writeFile(
        path.join(projectsDir, "session.jsonl"),
        lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      );
      process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "claude-config", "projects");
    }

    async function readWrittenReport(): Promise<Record<string, unknown>> {
      const files = (await readdir(tmpDir)).filter((f) =>
        f.startsWith("teamspend-snapshot-"),
      );
      expect(files).toHaveLength(1);
      const contents = await readFile(path.join(tmpDir, files[0] as string), "utf-8");
      return JSON.parse(contents) as Record<string, unknown>;
    }

    it("prints a per-session table and includes the full session array in the JSON report for an adapter with real session data", async () => {
      await writeClaudeCodePersonalFixture();

      const code = await run([
        "--tools",
        "claude-code-personal,claude-code-personal",
        "--before",
        "2026-06-01:2026-06-10",
        "--after",
        "2026-06-11:2026-06-30",
        "--breakdown",
        "session",
      ]);
      expect(code).toBe(0);

      const terminalOutput = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(terminalOutput).toContain("SESSION BREAKDOWN");
      expect(terminalOutput).toContain("before-session");
      expect(terminalOutput).toContain("after-session");

      const report = await readWrittenReport();
      const before = report.before as { result: { users: Array<{ sessions?: unknown }> } };
      const after = report.after as { result: { users: Array<{ sessions?: unknown }> } };
      expect(before.result.users[0]?.sessions).toBeDefined();
      expect(after.result.users[0]?.sessions).toBeDefined();
    });

    it("does not include per-session data in the JSON report when --breakdown session is not passed, even though the adapter produced it", async () => {
      await writeClaudeCodePersonalFixture();

      const code = await run([
        "--tools",
        "claude-code-personal,claude-code-personal",
        "--before",
        "2026-06-01:2026-06-10",
        "--after",
        "2026-06-11:2026-06-30",
      ]);
      expect(code).toBe(0);

      const terminalOutput = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(terminalOutput).not.toContain("SESSION BREAKDOWN");

      const report = await readWrittenReport();
      const before = report.before as { result: { users: Array<{ sessions?: unknown }> } };
      expect(before.result.users[0]?.sessions).toBeUndefined();
    });

    it("prints a clear explanation, not a fake or empty breakdown, when the requested tools have no session-level data", async () => {
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
        "--tools",
        "cursor,claude-code",
        "--before",
        "2026-06-01:2026-06-30",
        "--after",
        "2026-07-01:2026-07-31",
        "--breakdown",
        "session",
      ]);
      expect(code).toBe(0);

      const terminalOutput = logSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(terminalOutput).toContain("SESSION BREAKDOWN: not available for cursor");
      expect(terminalOutput).toContain(
        "SESSION BREAKDOWN: not available for claude-code",
      );

      delete process.env.TEAMSPEND_CURSOR_TOKEN;
      delete process.env.TEAMSPEND_CLAUDE_CODE_TOKEN;
    });
  });
});

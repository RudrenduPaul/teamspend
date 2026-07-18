import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchClaudeCodePersonalUsage } from "./claude-code-personal.js";
import { DataUnavailableError } from "../errors.js";

const FIXTURE_PATH = new URL(
  "../../fixtures/claude-code-personal.fixture.jsonl",
  import.meta.url,
);

describe("fetchClaudeCodePersonalUsage", () => {
  let tmpDir: string;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tmpDir = await mkdtemp(
      path.join(tmpdir(), "teamspend-claude-code-personal-test-"),
    );
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
  });

  it("normalizes a happy-path fixture read via a CLAUDE_CONFIG_DIR pointing straight at a projects/ dir", async () => {
    const projectsDir = path.join(tmpDir, "projects", "my-project");
    await mkdir(projectsDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(path.join(projectsDir, "session.jsonl"), fixtureContents);

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "projects");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.source).toBe("claude-code-personal");
    expect(result.users).toHaveLength(1);
    expect(result.totalCostUsd).toBeCloseTo(0.045 + 0.081 + 0.204, 3);
    expect(result.isEstimated).toBe(false);
    expect(result.users[0]?.requests).toBe(3);
    expect(result.users[0]?.userEmail).toBeNull();
  });

  it("also accepts a CLAUDE_CONFIG_DIR entry that is the parent config dir, not the projects/ dir itself", async () => {
    const projectsDir = path.join(tmpDir, "config", "projects", "proj");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      path.join(projectsDir, "session.jsonl"),
      '{"timestamp":"2026-06-05T10:00:00.000Z","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"requestId":"r1","costUSD":0.01}\n',
    );

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "config");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.totalCostUsd).toBeCloseTo(0.01, 3);
  });

  it("flags a line missing costUSD as estimated without losing its token counts", async () => {
    const projectsDir = path.join(tmpDir, "projects", "proj");
    await mkdir(projectsDir, { recursive: true });
    await writeFile(
      path.join(projectsDir, "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-06-05T10:00:00.000Z",
          message: {
            id: "m1",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          requestId: "r1",
          // No costUSD field at all.
        }),
        "",
      ].join("\n"),
    );

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "projects");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.users[0]?.isEstimated).toBe(true);
    expect(result.isEstimated).toBe(true);
    expect(result.users[0]?.inputTokens).toBe(100);
    expect(result.users[0]?.costUsd).toBe(0);
  });

  it("dedupes a retried entry sharing the same (message.id, requestId) pair rather than double-counting it", async () => {
    const projectsDir = path.join(tmpDir, "projects", "proj");
    await mkdir(projectsDir, { recursive: true });
    const entry = {
      timestamp: "2026-06-05T10:00:00.000Z",
      message: {
        id: "m-retry",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      requestId: "r-retry",
      costUSD: 0.02,
    };
    // Same line written twice, simulating a retried request appearing twice
    // in the log.
    await writeFile(
      path.join(projectsDir, "session.jsonl"),
      `${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`,
    );

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "projects");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.users[0]?.requests).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.02, 3);
  });

  it("filters out entries whose timestamp falls outside the requested date window", async () => {
    const projectsDir = path.join(tmpDir, "projects", "proj");
    await mkdir(projectsDir, { recursive: true });
    const inWindow = {
      timestamp: "2026-06-15T10:00:00.000Z",
      message: {
        id: "m-in",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      requestId: "r-in",
      costUSD: 0.03,
    };
    const outOfWindow = {
      timestamp: "2026-05-01T10:00:00.000Z",
      message: {
        id: "m-out",
        usage: {
          input_tokens: 999,
          output_tokens: 999,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      requestId: "r-out",
      costUSD: 99,
    };
    await writeFile(
      path.join(projectsDir, "session.jsonl"),
      `${JSON.stringify(inWindow)}\n${JSON.stringify(outOfWindow)}\n`,
    );

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "projects");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.users[0]?.requests).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.03, 3);
  });

  it("collects entries from nested subagents/ subdirectories, not just the top-level project dir", async () => {
    const subagentsDir = path.join(tmpDir, "projects", "proj", "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await writeFile(
      path.join(subagentsDir, "sub-session.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-06-05T10:00:00.000Z",
        message: {
          id: "m-sub",
          usage: {
            input_tokens: 20,
            output_tokens: 10,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
        requestId: "r-sub",
        costUSD: 0.004,
      })}\n`,
    );

    process.env.CLAUDE_CONFIG_DIR = path.join(tmpDir, "projects");

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.users[0]?.requests).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.004, 3);
  });

  it("throws DataUnavailableError naming the resolved directory when no .jsonl logs exist anywhere", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(
      tmpDir,
      "nonexistent",
      "projects",
    );

    await expect(
      fetchClaudeCodePersonalUsage({ start: "2026-06-01", end: "2026-06-30" }),
    ).rejects.toThrow(DataUnavailableError);

    await expect(
      fetchClaudeCodePersonalUsage({ start: "2026-06-01", end: "2026-06-30" }),
    ).rejects.toThrow(/nonexistent.*projects/);
  });

  it("scans every entry in a comma-separated CLAUDE_CONFIG_DIR list, not just the first", async () => {
    const dirA = path.join(tmpDir, "config-a", "projects", "p");
    const dirB = path.join(tmpDir, "config-b", "projects", "p");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(
      path.join(dirA, "a.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-06-02T10:00:00.000Z",
        message: { id: "ma", usage: { input_tokens: 1, output_tokens: 1 } },
        requestId: "ra",
        costUSD: 0.01,
      })}\n`,
    );
    await writeFile(
      path.join(dirB, "b.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-06-03T10:00:00.000Z",
        message: { id: "mb", usage: { input_tokens: 1, output_tokens: 1 } },
        requestId: "rb",
        costUSD: 0.02,
      })}\n`,
    );

    process.env.CLAUDE_CONFIG_DIR = `${path.join(tmpDir, "config-a")}, ${path.join(tmpDir, "config-b")}`;

    const result = await fetchClaudeCodePersonalUsage({
      start: "2026-06-01",
      end: "2026-06-30",
    });

    expect(result.users[0]?.requests).toBe(2);
    expect(result.totalCostUsd).toBeCloseTo(0.03, 3);
  });
});

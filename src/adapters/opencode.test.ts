import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOpenCodeSpend, resolveOpenCodeDataDirs } from "./opencode.js";
import { DataUnavailableError } from "../errors.js";

const FIXTURE_DIR = new URL("../../fixtures/opencode", import.meta.url).pathname;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOpenCodeSpend", () => {
  it("normalizes local message files within the window into a single synthetic user", async () => {
    const result = await fetchOpenCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      [FIXTURE_DIR],
    );

    expect(result.source).toBe("opencode");
    // Two assistant messages fall inside the window (msg_ab12cd, msg_ab12cf);
    // the user-role message, the before-window message, and the corrupt
    // file are all excluded.
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.requests).toBe(2);
    expect(result.users[0]?.inputTokens).toBe(18240 + 9000);
    expect(result.users[0]?.outputTokens).toBe(2310 + 1500);
    expect(result.users[0]?.cacheReadTokens).toBe(12000);
    expect(result.users[0]?.cacheWriteTokens).toBe(3400);
    expect(result.totalCostUsd).toBeCloseTo(0.0842 + 0, 4);
    expect(result.users[0]?.userEmail).toBeNull();
  });

  it("always flags OpenCode results as estimated, even when a nonzero cost is present", async () => {
    const result = await fetchOpenCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      [FIXTURE_DIR],
    );

    expect(result.isEstimated).toBe(true);
    expect(result.users[0]?.isEstimated).toBe(true);
  });

  it("excludes messages outside the requested window", async () => {
    const result = await fetchOpenCodeSpend(
      { start: "2026-05-01", end: "2026-05-31" },
      [FIXTURE_DIR],
    );

    // Only msg_ff0011 (2026-05-20) falls in this window.
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.requests).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.031, 4);
  });

  it("skips a corrupt/partially-written message file without failing the scan", async () => {
    // ses_7b03de44/msg_ff0012.json in the fixture directory is deliberately
    // truncated invalid JSON; if it weren't skipped this call would throw.
    await expect(
      fetchOpenCodeSpend({ start: "2026-01-01", end: "2026-12-31" }, [
        FIXTURE_DIR,
      ]),
    ).resolves.toBeDefined();
  });

  it("returns an empty, non-estimated result when the data dir exists but nothing falls in the window", async () => {
    const result = await fetchOpenCodeSpend(
      { start: "2020-01-01", end: "2020-01-31" },
      [FIXTURE_DIR],
    );

    expect(result.users).toHaveLength(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.isEstimated).toBe(false);
  });

  it("throws DataUnavailableError when no data directory has any message logs", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "teamspend-opencode-empty-"));
    try {
      await expect(
        fetchOpenCodeSpend({ start: "2026-06-01", end: "2026-06-30" }, [
          emptyDir,
        ]),
      ).rejects.toThrow(DataUnavailableError);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("throws DataUnavailableError when no data directories resolve at all", async () => {
    await expect(
      fetchOpenCodeSpend({ start: "2026-06-01", end: "2026-06-30" }, []),
    ).rejects.toThrow(DataUnavailableError);
  });
});

describe("resolveOpenCodeDataDirs", () => {
  it("defaults to ~/.local/share/opencode under HOME", () => {
    const dirs = resolveOpenCodeDataDirs({ HOME: "/home/dev" });
    expect(dirs).toEqual(["/home/dev/.local/share/opencode"]);
  });

  it("falls back to USERPROFILE on platforms without HOME", () => {
    const dirs = resolveOpenCodeDataDirs({ USERPROFILE: "C:\\Users\\dev" });
    expect(dirs).toEqual([join("C:\\Users\\dev", ".local", "share", "opencode")]);
  });

  it("parses a comma-separated OPENCODE_DATA_DIR override into multiple directories", () => {
    const dirs = resolveOpenCodeDataDirs({
      OPENCODE_DATA_DIR: "/a/opencode, /b/opencode-stable",
      HOME: "/home/dev",
    });
    expect(dirs).toEqual(["/a/opencode", "/b/opencode-stable"]);
  });

  it("returns an empty list when neither the override nor HOME/USERPROFILE is set", () => {
    expect(resolveOpenCodeDataDirs({})).toEqual([]);
  });
});

describe("real filesystem integration", () => {
  it("reads a freshly written per-session message file the same way real opencode output would land on disk", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "teamspend-opencode-live-"));
    const sessionDir = join(dataDir, "storage", "message", "ses_live1");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "msg_live1.json"),
      JSON.stringify({
        id: "msg_live1",
        sessionID: "ses_live1",
        role: "assistant",
        time: { created: Date.parse("2026-06-10T00:00:00.000Z") },
        modelID: "claude-sonnet-4-5",
        providerID: "anthropic",
        cost: 0.01,
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );

    try {
      const result = await fetchOpenCodeSpend(
        { start: "2026-06-01", end: "2026-06-30" },
        [dataDir],
      );
      expect(result.users).toHaveLength(1);
      expect(result.users[0]?.requests).toBe(1);
      expect(result.totalCostUsd).toBeCloseTo(0.01, 4);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

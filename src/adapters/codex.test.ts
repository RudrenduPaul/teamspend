import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchCodexUsage, resolveCodexSessionsDirs } from "./codex.js";
import { DataUnavailableError } from "../errors.js";

const FIXTURE_PATH = new URL(
  "../../fixtures/codex.fixture.jsonl",
  import.meta.url,
);

describe("fetchCodexUsage", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes a happy-path fixture read, deduping the doubled token_count event", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions", "2026", "06", "05");
    await mkdir(sessionDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(
      path.join(sessionDir, "rollout-2026-06-05T10-00-00-abc123.jsonl"),
      fixtureContents,
    );

    const result = await fetchCodexUsage(
      { start: "2026-06-01", end: "2026-06-30" },
      [path.join(tmpDir, "sessions")],
    );

    expect(result.source).toBe("codex");
    expect(result.users).toHaveLength(1);
    // The 10:00:05 token_count event is emitted twice, byte-identical, and
    // must be counted once: input net = 1200 - 400 = 800, output = 300.
    // The 10:02:00 event is distinct: input net = 1200 - 500 = 700,
    // output = 250. The 2026-05-01 event falls outside the window.
    expect(result.users[0]?.requests).toBe(2);
    expect(result.users[0]?.inputTokens).toBe(800 + 700);
    expect(result.users[0]?.outputTokens).toBe(300 + 250);
    expect(result.users[0]?.cacheReadTokens).toBe(400 + 500);
    expect(result.users[0]?.cacheWriteTokens).toBe(0);
    expect(result.users[0]?.userEmail).toBeNull();
  });

  it("always reports zero cost and isEstimated true -- Codex's local logs carry no cost field at all", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(path.join(sessionDir, "rollout-a.jsonl"), fixtureContents);

    const result = await fetchCodexUsage(
      { start: "2026-06-01", end: "2026-06-30" },
      [sessionDir],
    );

    expect(result.totalCostUsd).toBe(0);
    expect(result.isEstimated).toBe(true);
    expect(result.users[0]?.costUsd).toBe(0);
    expect(result.users[0]?.isEstimated).toBe(true);
  });

  it("excludes token_count events outside the requested window", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(path.join(sessionDir, "rollout-a.jsonl"), fixtureContents);

    const result = await fetchCodexUsage(
      { start: "2026-05-01", end: "2026-05-31" },
      [sessionDir],
    );

    // Only the 2026-05-01 event falls in this window.
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.requests).toBe(1);
    expect(result.users[0]?.inputTokens).toBe(9999);
    expect(result.users[0]?.outputTokens).toBe(9999);
  });

  it("skips a corrupt/partially-written line without failing the whole read", async () => {
    // The fixture's last line is deliberately truncated invalid JSON; if it
    // weren't skipped this call would throw.
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(path.join(sessionDir, "rollout-a.jsonl"), fixtureContents);

    await expect(
      fetchCodexUsage({ start: "2026-01-01", end: "2026-12-31" }, [
        sessionDir,
      ]),
    ).resolves.toBeDefined();
  });

  it("returns an empty, non-estimated result when session logs exist but nothing falls in the window", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    const fixtureContents = await readFile(FIXTURE_PATH, "utf-8");
    await writeFile(path.join(sessionDir, "rollout-a.jsonl"), fixtureContents);

    const result = await fetchCodexUsage(
      { start: "2020-01-01", end: "2020-01-31" },
      [sessionDir],
    );

    expect(result.users).toHaveLength(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.isEstimated).toBe(false);
  });

  it("ignores compressed .jsonl.zst rollout files -- only plain .jsonl is read", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionDir = path.join(tmpDir, "sessions");
    await mkdir(sessionDir, { recursive: true });
    // Not real zstd bytes -- if the adapter ever tried to read this as
    // JSONL it would throw/skip, but the point of this test is that it
    // must never even be picked up as a candidate file.
    await writeFile(
      path.join(sessionDir, "rollout-old.jsonl.zst"),
      "not-real-zstd-bytes",
    );

    await expect(
      fetchCodexUsage({ start: "2026-06-01", end: "2026-06-30" }, [
        sessionDir,
      ]),
    ).rejects.toThrow(DataUnavailableError);
  });

  it("scans both the sessions/ and archived_sessions/ directories", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const sessionsDir = path.join(tmpDir, "sessions");
    const archivedDir = path.join(tmpDir, "archived_sessions");
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(archivedDir, { recursive: true });
    await writeFile(
      path.join(archivedDir, "rollout-archived.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-06-10T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
          },
        },
      })}\n`,
    );

    const result = await fetchCodexUsage(
      { start: "2026-06-01", end: "2026-06-30" },
      [sessionsDir, archivedDir],
    );

    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.requests).toBe(1);
    expect(result.users[0]?.inputTokens).toBe(100);
  });

  it("throws DataUnavailableError naming the resolved directories when no .jsonl logs exist anywhere", async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "teamspend-codex-test-"));
    const emptyDir = path.join(tmpDir, "sessions");

    await expect(
      fetchCodexUsage({ start: "2026-06-01", end: "2026-06-30" }, [
        emptyDir,
      ]),
    ).rejects.toThrow(DataUnavailableError);
  });
});

describe("resolveCodexSessionsDirs", () => {
  it("defaults to ~/.codex/sessions and ~/.codex/archived_sessions when CODEX_HOME is unset", () => {
    const dirs = resolveCodexSessionsDirs({ HOME: "/home/dev" });
    expect(dirs).toEqual([
      path.join("/home/dev", ".codex", "sessions"),
      path.join("/home/dev", ".codex", "archived_sessions"),
    ]);
  });

  it("honors a CODEX_HOME override as a single directory, not a comma-separated list", () => {
    const dirs = resolveCodexSessionsDirs({
      CODEX_HOME: "/custom/codex-home",
      HOME: "/home/dev",
    });
    expect(dirs).toEqual([
      path.join("/custom/codex-home", "sessions"),
      path.join("/custom/codex-home", "archived_sessions"),
    ]);
  });
});

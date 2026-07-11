import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fetchClaudeCodeSpend } from "./claude-code.js";
import { DataUnavailableError } from "../errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchClaudeCodeSpend", () => {
  it("normalizes a happy-path response against the fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../fixtures/claude-code.fixture.json", import.meta.url),
        "utf-8",
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, fixture)),
    );

    const result = await fetchClaudeCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      "test-key",
    );

    expect(result.source).toBe("claude-code");
    expect(result.users).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(288.9 + 198.25, 2);
  });

  it("throws DataUnavailableError when the window predates 2026-01-01, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchClaudeCodeSpend(
        { start: "2025-11-01", end: "2025-11-30" },
        "test-key",
      ),
    ).rejects.toThrow(DataUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

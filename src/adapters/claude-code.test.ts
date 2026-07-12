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

  it("flags a user with real token activity but $0 reported spend as estimated, and flips the result to estimated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "flat-seat@x.com",
              input_tokens: 90000,
              output_tokens: 20000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              spend_usd: 0,
            },
          ],
        }),
      ),
    );

    const result = await fetchClaudeCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      "test-key",
    );

    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.isEstimated).toBe(true);
    expect(result.isEstimated).toBe(true);
  });

  it("keeps isEstimated false for a genuinely inactive user with zero tokens and $0 spend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "inactive@x.com",
              input_tokens: 0,
              output_tokens: 0,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              spend_usd: 0,
            },
          ],
        }),
      ),
    );

    const result = await fetchClaudeCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      "test-key",
    );

    expect(result.users[0]?.isEstimated).toBe(false);
    expect(result.isEstimated).toBe(false);
  });

  it("leaves a normal nonzero-spend user unaffected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "normal@x.com",
              input_tokens: 90000,
              output_tokens: 20000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              spend_usd: 75.4,
            },
          ],
        }),
      ),
    );

    const result = await fetchClaudeCodeSpend(
      { start: "2026-06-01", end: "2026-06-30" },
      "test-key",
    );

    expect(result.users[0]?.isEstimated).toBe(false);
    expect(result.isEstimated).toBe(false);
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

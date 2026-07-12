import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fetchCursorSpend } from "./cursor.js";
import { RetryExhaustedError } from "../errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCursorSpend", () => {
  it("normalizes a happy-path response against the fixture", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../fixtures/cursor.fixture.json", import.meta.url),
        "utf-8",
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, fixture)),
    );

    const result = await fetchCursorSpend(
      { start: "2026-04-01", end: "2026-04-30" },
      "test-key",
    );

    expect(result.source).toBe("cursor");
    expect(result.users).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(156.2 + 84.1, 2);
    expect(result.isEstimated).toBe(false);
  });

  it("reports zero spend explicitly for an empty window, never omitting the tool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { users: [] })),
    );
    const result = await fetchCursorSpend(
      { start: "2026-04-01", end: "2026-04-05" },
      "test-key",
    );
    expect(result.totalCostUsd).toBe(0);
    expect(result.users).toEqual([]);
  });

  it("paginates across a window longer than 30 days and sums the chunks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
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
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
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
              cost_usd: 5,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCursorSpend(
      { start: "2026-01-01", end: "2026-03-01" },
      "test-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.totalCostUsd).toBe(15);
    expect(result.users).toHaveLength(1);
  });

  it("flags a user with real activity but $0 reported cost as estimated, and flips the result to estimated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "flat-seat@x.com",
              input_tokens: 50000,
              output_tokens: 12000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              requests: 25,
              cost_usd: 0,
            },
          ],
        }),
      ),
    );

    const result = await fetchCursorSpend(
      { start: "2026-04-01", end: "2026-04-05" },
      "test-key",
    );

    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.isEstimated).toBe(true);
    expect(result.isEstimated).toBe(true);
  });

  it("keeps isEstimated false for a genuinely inactive user with zero tokens/requests and $0 cost", async () => {
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
              requests: 0,
              cost_usd: 0,
            },
          ],
        }),
      ),
    );

    const result = await fetchCursorSpend(
      { start: "2026-04-01", end: "2026-04-05" },
      "test-key",
    );

    expect(result.users[0]?.isEstimated).toBe(false);
    expect(result.isEstimated).toBe(false);
  });

  it("leaves a normal nonzero-cost user unaffected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "normal@x.com",
              input_tokens: 50000,
              output_tokens: 12000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              requests: 25,
              cost_usd: 42.5,
            },
          ],
        }),
      ),
    );

    const result = await fetchCursorSpend(
      { start: "2026-04-01", end: "2026-04-05" },
      "test-key",
    );

    expect(result.users[0]?.isEstimated).toBe(false);
    expect(result.isEstimated).toBe(false);
  });

  it("keeps isEstimated true after merging across chunks when only a later chunk for the same user is suspicious-zero", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "a@x.com",
              input_tokens: 100,
              output_tokens: 50,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              requests: 10,
              cost_usd: 42.5,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          users: [
            {
              user_id: "u1",
              email: "a@x.com",
              input_tokens: 50000,
              output_tokens: 12000,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              requests: 25,
              cost_usd: 0,
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCursorSpend(
      { start: "2026-01-01", end: "2026-03-01" },
      "test-key",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.isEstimated).toBe(true);
    expect(result.isEstimated).toBe(true);
  });

  it("fails the entire call if any chunk fails after retries, never silently summing partial pages", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
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
            },
          ],
        }),
      )
      .mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchCursorSpend(
      { start: "2026-01-01", end: "2026-03-01" },
      "test-key",
    );
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});

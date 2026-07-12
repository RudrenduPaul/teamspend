import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fetchCopilotSpend } from "./copilot.js";
import { DataUnavailableError } from "../errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function loadFixture(): Promise<{
  members: Array<{ login: string }>;
  billingUsage: Record<string, { usageItems: unknown[] }>;
}> {
  return JSON.parse(
    await readFile(
      new URL("../../fixtures/copilot.fixture.json", import.meta.url),
      "utf-8",
    ),
  );
}

/**
 * Builds a fetch mock that serves the fixture's member list on the first
 * call, then each member's billingUsage response in member order for every
 * subsequent call (one call per member per calendar month in the window).
 */
function stubFixtureFetch(
  fixture: Awaited<ReturnType<typeof loadFixture>>,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValueOnce(
    jsonResponse(200, fixture.members),
  );
  for (const member of fixture.members) {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, fixture.billingUsage[member.login]),
    );
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchCopilotSpend", () => {
  it("normalizes fixture data, filtering to Copilot-only line items within the window", async () => {
    const fixture = await loadFixture();
    stubFixtureFetch(fixture);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-30" },
      "test-key",
      "acme-corp",
    );

    expect(result.source).toBe("copilot");
    expect(result.users).toHaveLength(2);
    expect(result.isEstimated).toBe(false);

    const rChen = result.users.find((u) => u.userId === "r-chen");
    // 4.8 + 2.4 from the two Copilot line items; the Actions line item is excluded.
    expect(rChen?.costUsd).toBeCloseTo(7.2, 2);
    expect(rChen?.userEmail).toBeNull();
    expect(rChen?.inputTokens).toBeNull();

    const jKim = result.users.find((u) => u.userId === "j-kim");
    expect(jKim?.costUsd).toBeCloseTo(1.2, 2);

    expect(result.totalCostUsd).toBeCloseTo(8.4, 2);
  });

  it("excludes a Copilot line item whose date falls outside the requested window", async () => {
    const fixture = await loadFixture();
    stubFixtureFetch(fixture);

    // Narrow window that only covers r-chen's second Copilot line item (04-22).
    const result = await fetchCopilotSpend(
      { start: "2026-04-20", end: "2026-04-30" },
      "test-key",
      "acme-corp",
    );

    const rChen = result.users.find((u) => u.userId === "r-chen");
    expect(rChen?.costUsd).toBeCloseTo(2.4, 2);
    const jKim = result.users.find((u) => u.userId === "j-kim");
    expect(jKim?.costUsd).toBe(0);
  });

  it("makes one billing call per member per calendar month spanned by the window", async () => {
    const fixture = await loadFixture();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(200, fixture.members),
    );
    // Two members x two months (April, May) = 4 billing calls, plus 1 members call = 5.
    for (let i = 0; i < fixture.members.length * 2; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { usageItems: [] }));
    }
    vi.stubGlobal("fetch", fetchMock);

    await fetchCopilotSpend(
      { start: "2026-04-25", end: "2026-05-05" },
      "test-key",
      "acme-corp",
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("paginates the org member list past a full 100-member page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, i) => ({
      login: `user-${i}`,
    }));
    const secondPage = [{ login: "user-100" }];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, firstPage))
      .mockResolvedValueOnce(jsonResponse(200, secondPage));
    // 101 members, each needs a billing call for the single-month window.
    for (let i = 0; i < 101; i++) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { usageItems: [] }));
    }
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-30" },
      "test-key",
      "acme-corp",
    );

    expect(result.users).toHaveLength(101);
    // 2 member-list pages + 101 billing calls.
    expect(fetchMock).toHaveBeenCalledTimes(103);
  });

  it("rejects a window older than GitHub's 24-month billing usage retention without making any request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));

    await expect(
      fetchCopilotSpend(
        { start: "2020-01-01", end: "2020-01-31" },
        "test-key",
        "acme-corp",
      ),
    ).rejects.toThrow(DataUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports zero spend explicitly for an org with no members, never omitting the tool", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, [])));

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-30" },
      "test-key",
      "acme-corp",
    );

    expect(result.source).toBe("copilot");
    expect(result.users).toEqual([]);
    expect(result.totalCostUsd).toBe(0);
  });
});

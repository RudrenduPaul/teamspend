import { describe, it, expect, vi, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fetchCopilotSpend } from "./copilot.js";
import { DataUnavailableError, InvalidCliArgError, RetryExhaustedError } from "../errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

function ndjson(users: unknown[]): string {
  return users.map((u) => JSON.stringify(u)).join("\n");
}

const REPORT_URL_RE =
  /^https:\/\/api\.github\.com\/orgs\/acme\/copilot\/metrics\/reports\/users-1-day\?day=(\d{4}-\d{2}-\d{2})$/;
const DOWNLOAD_URL_RE = /^https:\/\/copilot-reports\.github\.com\//;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCopilotSpend", () => {
  it("normalizes a happy-path response against the fixture (single-day window)", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("../../fixtures/copilot.fixture.json", import.meta.url),
        "utf-8",
      ),
    );

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (REPORT_URL_RE.test(url)) {
        return jsonResponse(200, {
          download_links: ["https://copilot-reports.github.com/report-1.ndjson"],
          report_day: "2026-04-01",
        });
      }
      if (DOWNLOAD_URL_RE.test(url)) {
        return textResponse(200, ndjson(fixture.users));
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-01" },
      "test-token",
      "acme",
    );

    expect(result.source).toBe("copilot");
    expect(result.users).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(842.5 * 0.01 + 315.0 * 0.01, 5);
    // GitHub's Copilot metrics API has no native cost field at all, so
    // every result is estimated regardless of how clean the underlying
    // credits numbers are.
    expect(result.isEstimated).toBe(true);
    expect(result.users[0]?.userEmail).toBeNull();
    expect(result.users.find((u) => u.userId === "r-chen")?.costUsd).toBeCloseTo(
      8.425,
      5,
    );
  });

  it("treats a 404 report-for-the-day as zero users rather than a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse(404, {}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-01" },
      "test-token",
      "acme",
    );

    expect(result.totalCostUsd).toBe(0);
    expect(result.users).toEqual([]);
    expect(result.isEstimated).toBe(true);
  });

  it("requests one report per calendar day and sums a repeat user's credits across days", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const dayMatch = REPORT_URL_RE.exec(url);
      if (dayMatch) {
        return jsonResponse(200, {
          download_links: [`https://copilot-reports.github.com/${dayMatch[1]}.ndjson`],
          report_day: dayMatch[1],
        });
      }
      if (url.includes("2026-04-01.ndjson")) {
        return textResponse(
          200,
          ndjson([
            {
              user_id: 1,
              user_login: "a",
              ai_credits_used: 100,
              user_initiated_interaction_count: 5,
            },
          ]),
        );
      }
      if (url.includes("2026-04-02.ndjson")) {
        return textResponse(
          200,
          ndjson([
            {
              user_id: 1,
              user_login: "a",
              ai_credits_used: 50,
              user_initiated_interaction_count: 3,
            },
          ]),
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-02" },
      "test-token",
      "acme",
    );

    // 2 report-index calls (one per day) + 2 NDJSON downloads.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.users).toHaveLength(1);
    expect(result.users[0]?.requests).toBe(8);
    expect(result.totalCostUsd).toBeCloseTo(1.5, 5);
  });

  it("fetches multiple download_links for a single day and merges them", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (REPORT_URL_RE.test(url)) {
        return jsonResponse(200, {
          download_links: [
            "https://copilot-reports.github.com/part-1.ndjson",
            "https://copilot-reports.github.com/part-2.ndjson",
          ],
          report_day: "2026-04-01",
        });
      }
      if (url.includes("part-1")) {
        return textResponse(
          200,
          ndjson([
            {
              user_id: 1,
              user_login: "a",
              ai_credits_used: 100,
              user_initiated_interaction_count: 5,
            },
          ]),
        );
      }
      if (url.includes("part-2")) {
        return textResponse(
          200,
          ndjson([
            {
              user_id: 2,
              user_login: "b",
              ai_credits_used: 20,
              user_initiated_interaction_count: 1,
            },
          ]),
        );
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-01" },
      "test-token",
      "acme",
    );

    expect(result.users).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(1.2, 5);
  });

  it("throws AuthenticationError-derived message when the org token is invalid on the report call", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(401, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCopilotSpend({ start: "2026-04-01", end: "2026-04-01" }, "bad-token", "acme"),
    ).rejects.toThrow(/Auth failed for copilot/);
  });

  it("translates an expired/rejected download-link auth failure into a retry-the-command message, not a raw token error", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (REPORT_URL_RE.test(url)) {
        return jsonResponse(200, {
          download_links: ["https://copilot-reports.github.com/expired.ndjson"],
          report_day: "2026-04-01",
        });
      }
      return jsonResponse(403, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCopilotSpend({ start: "2026-04-01", end: "2026-04-01" }, "test-token", "acme"),
    ).rejects.toThrow(/download link for 2026-04-01 was rejected/);
  });

  it("fails the entire call if a report-index call fails after retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-01" },
      "test-token",
      "acme",
    );
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it("throws DataUnavailableError when the window predates Copilot metrics' start date, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCopilotSpend(
        { start: "2025-09-01", end: "2025-09-05" },
        "test-token",
        "acme",
      ),
    ).rejects.toThrow(DataUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds an optional seat price once per user, not once per day, and still marks the result estimated", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const dayMatch = REPORT_URL_RE.exec(url);
      if (dayMatch) {
        return jsonResponse(200, {
          download_links: [`https://copilot-reports.github.com/${dayMatch[1]}.ndjson`],
          report_day: dayMatch[1],
        });
      }
      return textResponse(
        200,
        ndjson([
          {
            user_id: 1,
            user_login: "a",
            ai_credits_used: 0,
            user_initiated_interaction_count: 0,
          },
        ]),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCopilotSpend(
      { start: "2026-04-01", end: "2026-04-03" },
      "test-token",
      "acme",
      19,
    );

    expect(result.users).toHaveLength(1);
    // 3 days in the window, but the $19 seat price must appear exactly once.
    expect(result.users[0]?.costUsd).toBe(19);
    expect(result.isEstimated).toBe(true);
  });

  it("rejects a negative seat price with InvalidCliArgError", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCopilotSpend(
        { start: "2026-04-01", end: "2026-04-01" },
        "test-token",
        "acme",
        -5,
      ),
    ).rejects.toThrow(InvalidCliArgError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

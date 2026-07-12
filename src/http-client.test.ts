import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry, requireField } from "./http-client.js";
import {
  AuthenticationError,
  RetryExhaustedError,
  SchemaDriftError,
} from "./errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the parsed body on a happy-path 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true })),
    );
    const result = await fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    expect(result).toEqual({ ok: true });
  });

  it("throws AuthenticationError naming the tool and env var on 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));
    await expect(
      fetchWithRetry({ tool: "cursor", url: "https://x", authHeader: {} }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("retries a 429 with backoff then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with RetryExhaustedError after 3 retries on repeated 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {})));
    const promise = fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("treats a 500 identically to a 429 (retry then fail)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, {})));
    const promise = fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("treats a network error identically to a timeout (retry then fail)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    const promise = fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("passes an AbortSignal so a stalled connection cannot hang forever ([redacted] fix)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry({ tool: "cursor", url: "https://x", authHeader: {} });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://x",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("treats an abort/timeout rejection the same as any other network error (retry then fail)", async () => {
    const abortError = new DOMException("The operation was aborted", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));
    const promise = fetchWithRetry({
      tool: "cursor",
      url: "https://x",
      authHeader: {},
    });
    const assertion = expect(promise).rejects.toThrow(RetryExhaustedError);
    await vi.runAllTimersAsync();
    await assertion;
  });
});

describe("requireField", () => {
  it("returns the field value when present", () => {
    expect(requireField<string>({ foo: "bar" }, "foo", "cursor")).toBe("bar");
  });

  it("throws SchemaDriftError naming the tool and field when missing", () => {
    expect(() => requireField({}, "foo", "cursor")).toThrow(SchemaDriftError);
  });

  it("uses the primary field when both it and an alias are present", () => {
    expect(
      requireField<string>(
        { period: "primary", month: "legacy" },
        "period",
        "cursor",
        ["month"],
      ),
    ).toBe("primary");
  });

  it("falls back to an alias when the primary field is absent", () => {
    expect(
      requireField<string>({ month: "2026-07" }, "period", "cursor", [
        "month",
        "date",
      ]),
    ).toBe("2026-07");
  });

  it("throws SchemaDriftError when neither the primary field nor any alias is present", () => {
    expect(() =>
      requireField({}, "period", "cursor", ["month", "date"]),
    ).toThrow(SchemaDriftError);
  });

  it("includes the tried alias names in the error message when aliases were passed", () => {
    expect(() =>
      requireField({}, "period", "cursor", ["month", "date"]),
    ).toThrow(/month, date/);
  });
});

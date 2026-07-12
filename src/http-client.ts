import {
  AuthenticationError,
  RetryExhaustedError,
  SchemaDriftError,
} from "./errors.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

function isRetryable(status: number): "rate-limit" | "server-error" | null {
  if (status === 429) return "rate-limit";
  if (status >= 500 && status < 600) return "server-error";
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchWithRetryOptions {
  tool: string;
  url: string;
  authHeader: Record<string, string>;
}

/**
 * Shared fetch+retry wrapper used by every admin-API adapter. Retries 429 and
 * 5xx/timeout identically with exponential backoff (base 500ms, doubling,
 * cap 3), then fails with a named error rather than ever returning a partial
 * or guessed result.
 */
export async function fetchWithRetry(
  options: FetchWithRetryOptions,
): Promise<unknown> {
  const { tool, url, authHeader } = options;
  let lastFailureKind: "rate-limit" | "server-error" | "timeout" = "timeout";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Without a signal, a stalled connection (a slow proxy, a degraded but
      // not erroring admin API) never settles and this await never resolves
      // or rejects, so none of the retry/backoff logic below ever engages
      // and the process hangs indefinitely (found during the CSO security
      // review). AbortSignal.timeout rejects with a DOMException, which
      // falls through to the generic catch block below and is correctly
      // treated as the existing "timeout" failure kind.
      const response = await fetch(url, {
        headers: authHeader,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 401 || response.status === 403) {
        throw new AuthenticationError(
          tool,
          `TEAMSPEND_${tool.toUpperCase().replace(/-/g, "_")}_TOKEN`,
        );
      }

      const retryKind = isRetryable(response.status);
      if (retryKind) {
        lastFailureKind = retryKind;
        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new RetryExhaustedError(tool, retryKind, attempt + 1);
      }

      if (!response.ok) {
        throw new Error(
          `${tool} returned unexpected status ${response.status}`,
        );
      }

      return await response.json();
    } catch (error) {
      if (
        error instanceof AuthenticationError ||
        error instanceof RetryExhaustedError
      ) {
        throw error;
      }
      // Network error / timeout, treated identically to a 5xx.
      lastFailureKind = "timeout";
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw new RetryExhaustedError(tool, lastFailureKind, attempt + 1);
    }
  }

  // Unreachable, but keeps TypeScript's control-flow analysis satisfied.
  throw new RetryExhaustedError(tool, lastFailureKind, MAX_RETRIES + 1);
}

/**
 * Asserts a field exists on a parsed API response before it is read.
 * Throws SchemaDriftError rather than silently coercing/guessing when a
 * vendor's response shape changes without notice.
 *
 * `aliases` is an optional, ordered list of legacy/alternate key names to
 * fall back to if the primary `field` is absent, guarding against a vendor
 * silently renaming a field (as happened upstream in rtk-ai/rtk#2732, where
 * ccusage renamed `month`/`date`/`week` to `period`). No adapter currently
 * passes aliases -- Cursor and Anthropic have not renamed anything -- but
 * the mechanism exists so a future rename degrades gracefully instead of
 * hard-failing.
 */
export function requireField<T>(
  obj: Record<string, unknown>,
  field: string,
  tool: string,
  aliases: readonly string[] = [],
): T {
  if (field in obj && obj[field] !== undefined) {
    return obj[field] as T;
  }
  for (const alias of aliases) {
    if (alias in obj && obj[alias] !== undefined) {
      return obj[alias] as T;
    }
  }
  throw new SchemaDriftError(tool, field, aliases);
}

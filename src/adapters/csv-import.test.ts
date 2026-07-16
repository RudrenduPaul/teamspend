import { describe, it, expect } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { importFromCSV } from "./csv-import.js";
import { CSVRowError, CSVSchemaError, EmptyCSVError } from "../errors.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../fixtures/csv-import.fixture.csv", import.meta.url),
);

describe("importFromCSV", () => {
  it("parses the fixture, aggregating per-user across multiple rows", async () => {
    const result = await importFromCSV(FIXTURE_PATH, "claude-code", {
      start: "2025-11-01",
      end: "2025-11-30",
    });

    expect(result.source).toBe("claude-code");
    expect(result.users).toHaveLength(2);
    const chen = result.users.find(
      (u) => u.userEmail === "r.chen@acme-corp.com",
    );
    expect(chen?.costUsd).toBeCloseTo(12.5 + 14.1, 2);
    expect(chen?.isEstimated).toBe(false);

    const kim = result.users.find((u) => u.userEmail === "j.kim@acme-corp.com");
    expect(kim?.isEstimated).toBe(true);
  });

  it("throws CSVSchemaError when required columns are missing", async () => {
    const tmpPath = fileURLToPath(
      new URL("../../fixtures/tmp-bad-schema.csv", import.meta.url),
    );
    await writeFile(tmpPath, "date,cost_usd\n2025-11-01,12.5\n");
    try {
      await expect(
        importFromCSV(tmpPath, "cursor", {
          start: "2025-11-01",
          end: "2025-11-30",
        }),
      ).rejects.toThrow(CSVSchemaError);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("throws EmptyCSVError for an empty file", async () => {
    const tmpPath = fileURLToPath(
      new URL("../../fixtures/tmp-empty.csv", import.meta.url),
    );
    await writeFile(tmpPath, "");
    try {
      await expect(
        importFromCSV(tmpPath, "cursor", {
          start: "2025-11-01",
          end: "2025-11-30",
        }),
      ).rejects.toThrow(EmptyCSVError);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("throws CSVRowError instead of silently producing NaN for a malformed cost value", async () => {
    const tmpPath = fileURLToPath(
      new URL("../../fixtures/tmp-bad-cost.csv", import.meta.url),
    );
    await writeFile(
      tmpPath,
      "date,user_email,cost_usd,is_estimated\n2025-11-01,a@x.com,not-a-number,false\n",
    );
    try {
      await expect(
        importFromCSV(tmpPath, "cursor", {
          start: "2025-11-01",
          end: "2025-11-30",
        }),
      ).rejects.toThrow(CSVRowError);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("throws CSVRowError for an empty user_email instead of grouping under an empty key", async () => {
    const tmpPath = fileURLToPath(
      new URL("../../fixtures/tmp-bad-email.csv", import.meta.url),
    );
    await writeFile(
      tmpPath,
      "date,user_email,cost_usd,is_estimated\n2025-11-01,,12.50,false\n",
    );
    try {
      await expect(
        importFromCSV(tmpPath, "cursor", {
          start: "2025-11-01",
          end: "2025-11-30",
        }),
      ).rejects.toThrow(CSVRowError);
    } finally {
      await unlink(tmpPath);
    }
  });

  it("strips ANSI/control-character escape sequences from a CSV cell", async () => {
    const tmpPath = fileURLToPath(
      new URL("../../fixtures/tmp-ansi-injection.csv", import.meta.url),
    );
    // \x1b is ESC -- a crafted cell could otherwise inject terminal escape
    // sequences into the non-JSON summary output.
    await writeFile(
      tmpPath,
      "date,user_email,cost_usd,is_estimated\n2025-11-01,evil\x1b[31m@x.com,12.50,false\n",
    );
    try {
      const result = await importFromCSV(tmpPath, "cursor", {
        start: "2025-11-01",
        end: "2025-11-30",
      });
      expect(result.users[0]?.userEmail).toBe("evil[31m@x.com");
      expect(result.users[0]?.userEmail).not.toContain("\x1b");
    } finally {
      await unlink(tmpPath);
    }
  });
});

import { describe, it, expect } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { importFromCSV } from "./csv-import.js";
import { CSVSchemaError, EmptyCSVError } from "../errors.js";

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
});

export class AuthenticationError extends Error {
  constructor(
    public readonly tool: string,
    public readonly credentialEnvVar: string,
  ) {
    super(
      `Auth failed for ${tool}: check ${credentialEnvVar} is set and valid`,
    );
    this.name = "AuthenticationError";
  }
}

export class RetryExhaustedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly failureKind: "rate-limit" | "server-error" | "timeout",
    public readonly attempts: number,
  ) {
    super(`${tool} failed after ${attempts} retries (${failureKind})`);
    this.name = "RetryExhaustedError";
  }
}

export class SchemaDriftError extends Error {
  constructor(
    public readonly tool: string,
    public readonly unexpectedField: string,
  ) {
    super(
      `${tool} API returned an unexpected shape (field: ${unexpectedField}) — teamspend may need an update`,
    );
    this.name = "SchemaDriftError";
  }
}

export class DataUnavailableError extends Error {
  constructor(
    public readonly tool: string,
    public readonly reason: string,
  ) {
    super(
      `No API data available for ${tool}: ${reason} — provide a CSV file per the documented schema`,
    );
    this.name = "DataUnavailableError";
  }
}

export class CSVSchemaError extends Error {
  constructor(public readonly expectedColumns: string[]) {
    super(
      `CSV file doesn't match expected columns: ${expectedColumns.join(", ")}`,
    );
    this.name = "CSVSchemaError";
  }
}

export class EmptyCSVError extends Error {
  constructor(public readonly path: string) {
    super(`CSV file is empty: ${path}`);
    this.name = "EmptyCSVError";
  }
}

export class CSVRowError extends Error {
  constructor(
    public readonly rowNumber: number,
    reason: string,
  ) {
    super(`CSV row ${rowNumber} is invalid: ${reason}`);
    this.name = "CSVRowError";
  }
}

export class InvalidCliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCliArgError";
  }
}

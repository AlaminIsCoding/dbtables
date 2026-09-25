import { describe, expect, it } from "vitest";

import {
  createOperationId,
  isSuccessfulOperationState,
  isTerminalOperationState,
  type ConnectionDescriptor,
  type QueryResult,
} from "./index";

const SECRET_PATTERN = /password|passwd|secret|token|credential/i;

describe("frontend domain types", () => {
  it("describes a SQLite connection without secret material", () => {
    const descriptor: ConnectionDescriptor = {
      engine: "sqlite",
      filePath: "/tmp/app.sqlite",
    };

    expect(descriptor.engine).toBe("sqlite");
    expect(JSON.stringify(descriptor)).not.toMatch(SECRET_PATTERN);
  });

  it("describes a server connection with TLS and without secret material", () => {
    const descriptor: ConnectionDescriptor = {
      engine: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      username: "app_user",
      tls: "preferred",
    };

    expect(descriptor.tls).toBe("preferred");
    expect(JSON.stringify(descriptor)).not.toMatch(SECRET_PATTERN);
  });

  it("keeps an unknown write outcome distinct from success", () => {
    const result: QueryResult = {
      operationId: "op-1",
      state: "outcome_unknown",
      truncated: false,
    };

    expect(isSuccessfulOperationState(result.state)).toBe(false);
    expect(isTerminalOperationState(result.state)).toBe(true);
  });

  it("treats queued and running as non-terminal", () => {
    expect(isTerminalOperationState("queued")).toBe(false);
    expect(isTerminalOperationState("running")).toBe(false);
    expect(isTerminalOperationState("succeeded")).toBe(true);
  });

  it("mints distinct operation identifiers", () => {
    const first = createOperationId();
    const second = createOperationId();

    expect(first).not.toHaveLength(0);
    expect(second).not.toHaveLength(0);
    expect(first).not.toEqual(second);
  });
});

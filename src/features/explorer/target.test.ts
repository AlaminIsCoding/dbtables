import { describe, expect, it } from "vitest";

import type { QueryError } from "../../domain";
import type { ActiveConnection } from "../connections";
import { toExplorerTarget } from "./target";

const redactedError: QueryError = {
  category: "authentication",
  message: "the server rejected the credentials",
};

describe("toExplorerTarget", () => {
  it("maps disconnected and connecting states without a connection token", () => {
    expect(
      toExplorerTarget({ status: "disconnected" }),
    ).toEqual({ status: "disconnected" });
    expect(
      toExplorerTarget({ status: "connecting", profileId: "p1" }),
    ).toEqual({ status: "connecting" });
  });

  it("carries the connection token for a connected state", () => {
    const active: ActiveConnection = {
      status: "connected",
      profileId: "p1",
      connectionId: "conn-1",
    };

    expect(toExplorerTarget(active)).toEqual({
      status: "connected",
      connectionId: "conn-1",
    });
  });

  it("passes the redacted error through unchanged", () => {
    const active: ActiveConnection = {
      status: "error",
      error: redactedError,
    };

    expect(toExplorerTarget(active)).toEqual({
      status: "error",
      error: redactedError,
    });
  });
});

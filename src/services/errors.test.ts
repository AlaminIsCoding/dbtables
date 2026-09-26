import { describe, expect, it } from "vitest";

import type { QueryError } from "../domain";
import { isQueryError, toQueryError } from "./errors";

describe("toQueryError", () => {
  it("passes a structured backend error through unchanged", () => {
    const backendError: QueryError = {
      category: "syntax",
      message: "the SQL statement has a syntax error",
      code: "1",
      engineDetail: "near WHERE: syntax error",
    };

    expect(toQueryError(backendError)).toEqual(backendError);
    expect(isQueryError(backendError)).toBe(true);
  });

  it("wraps a JavaScript error as an internal failure", () => {
    expect(toQueryError(new Error("backend unavailable"))).toEqual({
      category: "internal",
      message: "backend unavailable",
    });
  });

  it("wraps a string rejection", () => {
    expect(toQueryError("nope")).toEqual({
      category: "internal",
      message: "nope",
    });
  });

  it("falls back for unknown rejections", () => {
    expect(toQueryError(undefined)).toEqual({
      category: "internal",
      message: "The backend request failed.",
    });
    expect(isQueryError({ category: "not-a-category", message: "x" })).toBe(
      false,
    );
  });
});

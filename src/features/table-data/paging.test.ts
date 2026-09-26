import { describe, expect, it } from "vitest";

import type { TablePage } from "../../domain";
import {
  buildTablePageRequest,
  canGoBack,
  canGoNext,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  HARD_MAX_PAGE_SIZE,
  hasRowIdentity,
  nextOffsetFor,
  pageRangeLabel,
  previousOffset,
} from "./paging";

function page(overrides: Partial<TablePage> = {}): TablePage {
  return {
    operationId: "op",
    columns: [{ name: "id" }],
    rows: [[{ type: "integer", value: 1 }]],
    offset: 0,
    limit: 25,
    truncated: false,
    ...overrides,
  };
}

describe("table data paging", () => {
  it("clamps page sizes into the supported range", () => {
    expect(clampPageSize(25)).toBe(25);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(HARD_MAX_PAGE_SIZE + 500)).toBe(HARD_MAX_PAGE_SIZE);
  });

  it("builds a bounded request with a fresh operation id", () => {
    const request = buildTablePageRequest({
      object: { name: "users", kind: "table" },
      limit: HARD_MAX_PAGE_SIZE + 1,
      offset: -4,
      filters: [],
      sort: [],
    });

    expect(request.limit).toBe(HARD_MAX_PAGE_SIZE);
    expect(request.offset).toBe(0);
    expect(request.operationId.length).toBeGreaterThan(0);
    expect(request.filters).toBeUndefined();
    expect(request.sort).toBeUndefined();
  });

  it("carries filters and sort when present", () => {
    const request = buildTablePageRequest({
      object: { name: "users", kind: "table" },
      limit: 25,
      offset: 25,
      filters: [{ column: "name", operator: "like", values: [{ type: "text", value: "%a%" }] }],
      sort: [{ column: "id", direction: "descending" }],
    });

    expect(request.offset).toBe(25);
    expect(request.filters).toHaveLength(1);
    expect(request.sort?.[0]).toEqual({ column: "id", direction: "descending" });
  });

  it("prefers the backend next offset and falls back to truncation", () => {
    expect(nextOffsetFor(page({ nextOffset: 40 }))).toBe(40);
    expect(
      nextOffsetFor(page({ truncated: true, offset: 10, rows: [[{ type: "null" }]] })),
    ).toBe(11);
    expect(nextOffsetFor(page({ truncated: false }))).toBeNull();
  });

  it("reports whether paging is possible in each direction", () => {
    expect(canGoBack(0)).toBe(false);
    expect(canGoBack(25)).toBe(true);
    expect(previousOffset(25, 25)).toBe(0);
    expect(previousOffset(10, 25)).toBe(0);

    expect(canGoNext(null)).toBe(false);
    expect(canGoNext(page({ truncated: true }))).toBe(true);
    expect(canGoNext(page({ nextOffset: 50 }))).toBe(true);
    expect(canGoNext(page({ truncated: false }))).toBe(false);
  });

  it("labels the visible range without inventing a total", () => {
    expect(pageRangeLabel(0, 50, 320)).toBe("Rows 1-50 of 320");
    expect(pageRangeLabel(50, 25)).toBe("Rows 51-75");
    expect(pageRangeLabel(0, 0)).toBe("No rows");
    expect(pageRangeLabel(25, 0)).toBe("No rows at offset 25");
  });

  it("distinguishes a missing row identity from one present", () => {
    expect(hasRowIdentity(page({ rowIdentity: ["id"] }))).toBe(true);
    expect(hasRowIdentity(page({ rowIdentity: [] }))).toBe(false);
    expect(hasRowIdentity(null)).toBe(false);
  });
});

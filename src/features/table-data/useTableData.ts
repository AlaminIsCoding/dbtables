import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ObjectRef,
  QueryError,
  SortDirection,
  SortKey,
  TableFilter,
  TablePage,
} from "../../domain";
import { toQueryError } from "../../services/errors";
import { fetchTablePage } from "../../services/tableData";
import {
  buildTablePageRequest,
  canGoBack,
  canGoNext,
  clampPageSize,
  DEFAULT_PAGE_SIZE,
  hasRowIdentity,
  nextOffsetFor,
  previousOffset,
} from "./paging";
import { singleSortKey } from "./filters";

/** Connection and object the browser fetches pages for. */
export interface TableDataTarget {
  connectionId: string;
  object: ObjectRef;
}

/** Loading/ready/error state for the current page request. */
export type TableDataStatus = "loading" | "ready" | "error";

export interface TableDataController {
  /** Object being browsed. */
  object: ObjectRef;
  /** Current page, or `null` while loading or after a failure. */
  page: TablePage | null;
  /** Whether the page request is in flight. */
  isLoading: boolean;
  /** Normalized error for the last failed request. */
  error: QueryError | null;
  /** Columns for the current page, or empty before the first response. */
  columns: TablePage["columns"];
  /** Rows for the current page, or empty before the first response. */
  rows: NonNullable<TablePage["rows"]>;
  /** Page size in rows. */
  pageSize: number;
  /** Replaces the page size and returns to the first page. */
  setPageSize: (size: number) => void;
  /** Offset of the current window. */
  offset: number;
  /** Whether a previous page can be requested. */
  canGoBack: boolean;
  /** Whether a further page exists. */
  canGoNext: boolean;
  /** Requests the next page. */
  goNext: () => void;
  /** Requests the previous page. */
  goBack: () => void;
  /** Reloads the current window, discarding any cached page. */
  refresh: () => void;
  /** Active filters. */
  filters: TableFilter[];
  /** Adds a filter and returns to the first page. */
  addFilter: (filter: TableFilter) => void;
  /** Removes a filter by index and returns to the first page. */
  removeFilter: (index: number) => void;
  /** Removes all filters and returns to the first page. */
  clearFilters: () => void;
  /** Active ordering. */
  sort: SortKey[];
  /** Applies a single ordering column and returns to the first page. */
  applySort: (column: string, direction: SortDirection) => void;
  /** Removes the ordering and returns to the first page. */
  clearSort: () => void;
  /** Whether the header columns form a safe row identity. */
  hasRowIdentity: boolean;
}

function objectKeyOf(target: TableDataTarget): string {
  const { object } = target;
  return [
    target.connectionId,
    object.database ?? "",
    object.schema ?? "",
    object.kind,
    object.name,
  ].join("\u0000");
}

/**
 * Owns read-only table browsing state for one connection and object.
 *
 * Each request is bounded: the page size is clamped and the backend enforces its
 * own ceiling. Filter/sort changes and a page-size change reset to the first
 * page so the window stays predictable. When the connection or object changes,
 * all state resets and in-flight responses for the previous target are
 * discarded, so a stale page is never shown for a new object. The controller
 * never issues a mutation; it only fetches pages.
 */
export function useTableDataController(
  target: TableDataTarget,
): TableDataController {
  const { connectionId, object } = target;
  const objectKey = objectKeyOf(target);

  const [pageSize, setPageSizeState] = useState<number>(DEFAULT_PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<TableFilter[]>([]);
  const [sort, setSort] = useState<SortKey[]>([]);
  const [page, setPage] = useState<TablePage | null>(null);
  const [error, setError] = useState<QueryError | null>(null);
  const [status, setStatus] = useState<TableDataStatus>("loading");
  const [reloadToken, setReloadToken] = useState(0);

  const requestIdRef = useRef(0);
  const previousKeyRef = useRef(objectKey);
  const targetRef = useRef<TableDataTarget>(target);
  targetRef.current = { connectionId, object };

  // Reset every object-scoped control when the browsed target changes. The
  // reset is skipped on mount so it does not create fresh filter/sort arrays
  // that would re-trigger the fetch effect and issue a duplicate first request.
  useEffect(() => {
    if (previousKeyRef.current === objectKey) {
      return;
    }
    previousKeyRef.current = objectKey;
    setOffset(0);
    setFilters([]);
    setSort([]);
    setPage(null);
    setError(null);
    setStatus("loading");
  }, [objectKey]);

  useEffect(() => {
    let active = true;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setStatus("loading");
    setError(null);

    const current = targetRef.current;
    const request = buildTablePageRequest({
      object: current.object,
      limit: pageSize,
      offset,
      filters,
      sort,
    });

    void (async () => {
      try {
        const result = await fetchTablePage(current.connectionId, request);
        if (!active || requestId !== requestIdRef.current) {
          return;
        }
        setPage(result);
        setStatus("ready");
      } catch (rawError) {
        if (!active || requestId !== requestIdRef.current) {
          return;
        }
        setPage(null);
        setError(toQueryError(rawError));
        setStatus("error");
      }
    })();

    return () => {
      active = false;
    };
  }, [objectKey, connectionId, offset, pageSize, filters, sort, reloadToken]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(clampPageSize(size));
    setOffset(0);
  }, []);

  const goNext = useCallback(() => {
    setOffset((current) => {
      const next = page ? nextOffsetFor(page) : null;
      return next ?? current;
    });
  }, [page]);

  const goBack = useCallback(() => {
    setOffset((current) => previousOffset(current, pageSize));
  }, [pageSize]);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  const addFilter = useCallback((filter: TableFilter) => {
    setFilters((current) => [...current, filter]);
    setOffset(0);
  }, []);

  const removeFilter = useCallback((index: number) => {
    setFilters((current) => current.filter((_, position) => position !== index));
    setOffset(0);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters([]);
    setOffset(0);
  }, []);

  const applySort = useCallback((column: string, direction: SortDirection) => {
    setSort(singleSortKey(column, direction));
    setOffset(0);
  }, []);

  const clearSort = useCallback(() => {
    setSort([]);
    setOffset(0);
  }, []);

  return {
    object,
    page,
    isLoading: status === "loading",
    error: status === "error" ? error : null,
    columns: page?.columns ?? [],
    rows: page?.rows ?? [],
    pageSize,
    setPageSize,
    offset,
    canGoBack: canGoBack(offset),
    canGoNext: canGoNext(page),
    goNext,
    goBack,
    refresh,
    filters,
    addFilter,
    removeFilter,
    clearFilters,
    sort,
    applySort,
    clearSort,
    hasRowIdentity: hasRowIdentity(page),
  };
}

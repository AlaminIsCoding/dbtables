import type {
  ObjectRef,
  SortKey,
  TableFilter,
  TablePage,
  TablePageRequest,
} from "../../domain";
import { createOperationId } from "../../domain";

/** Rows requested for a page by default. */
export const DEFAULT_PAGE_SIZE = 50;

/** Page sizes offered in the view; the backend also clamps its own ceiling. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

/** Upper bound mirrored from the backend so the UI cannot request a huge page. */
export const HARD_MAX_PAGE_SIZE = 1_000;

/** The inputs that fully determine which page the backend returns. */
export interface TablePageQuery {
  /** Table or view to page. */
  object: ObjectRef;
  /** Page size in rows. */
  limit: number;
  /** Rows to skip before the window. */
  offset: number;
  /** Filters to apply. */
  filters: TableFilter[];
  /** Deterministic ordering to apply. */
  sort: SortKey[];
}

/** Clamps a requested page size into the supported range. */
export function clampPageSize(size: number): number {
  if (!Number.isFinite(size) || size < 1) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(size), HARD_MAX_PAGE_SIZE);
}

/** Builds a typed, bounded page request with a fresh operation id. */
export function buildTablePageRequest(query: TablePageQuery): TablePageRequest {
  const request: TablePageRequest = {
    operationId: createOperationId(),
    object: query.object,
    limit: clampPageSize(query.limit),
    offset: Math.max(0, Math.floor(query.offset)),
  };

  if (query.filters.length > 0) {
    request.filters = query.filters;
  }
  if (query.sort.length > 0) {
    request.sort = query.sort;
  }

  return request;
}

/**
 * Offset the backend should return next, or `null` when this is the last page.
 *
 * The backend reports `nextOffset` when more rows may exist; when it only flags
 * `truncated`, the next window starts after the rows it actually returned.
 */
export function nextOffsetFor(page: TablePage): number | null {
  if (page.nextOffset !== undefined) {
    return page.nextOffset;
  }
  if (page.truncated) {
    return page.offset + (page.rows?.length ?? 0);
  }
  return null;
}

/** Whether a further page can be requested from the current page. */
export function canGoNext(page: TablePage | null): boolean {
  return page != null && nextOffsetFor(page) !== null;
}

/** Whether a previous page can be requested. */
export function canGoBack(offset: number): boolean {
  return offset > 0;
}

/** Offset of the previous page, never below zero. */
export function previousOffset(offset: number, pageSize: number): number {
  return Math.max(0, offset - clampPageSize(pageSize));
}

/**
 * Human-readable row window for the paging bar.
 *
 * Uses the engine-reported total when available and omits it otherwise rather
 * than pretending the loaded window is the whole table.
 */
export function pageRangeLabel(
  offset: number,
  rowCount: number,
  totalRows?: number,
): string {
  if (rowCount === 0) {
    return offset > 0 ? `No rows at offset ${offset}` : "No rows";
  }

  const first = offset + 1;
  const last = offset + rowCount;
  if (totalRows !== undefined) {
    return `Rows ${first}–${last} of ${totalRows}`;
  }
  return `Rows ${first}–${last}`;
}

/** Whether the page reports a primary key or other safe row identity. */
export function hasRowIdentity(page: TablePage | null): boolean {
  return (page?.rowIdentity?.length ?? 0) > 0;
}

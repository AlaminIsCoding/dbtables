import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ObjectRef,
  QueryError,
  ScopeListing,
  TableDescription,
} from "../../domain";
import {
  describeTable,
  listObjects,
  listScopes,
} from "../../services/metadata";
import type { ExplorerTarget } from "./target";
import { useExplorer } from "./useExplorer";

vi.mock("../../services/metadata", () => ({
  describeTable: vi.fn(),
  listObjects: vi.fn(),
  listScopes: vi.fn(),
}));

const listScopesMock = vi.mocked(listScopes);
const listObjectsMock = vi.mocked(listObjects);
const describeTableMock = vi.mocked(describeTable);

const users: ObjectRef = { schema: "public", name: "users", kind: "table" };
const orders: ObjectRef = { schema: "public", name: "orders", kind: "table" };

const description: TableDescription = {
  columns: [
    { name: "id", typeName: "integer", nullable: false },
    { name: "email", typeName: "text", nullable: false },
  ],
  primaryKeyColumns: ["id"],
  indexes: [{ name: "users_pkey", columns: ["id"], unique: true, primary: true }],
  constraints: [{ name: "users_pkey", kind: "primary_key", columns: ["id"] }],
};

const unsupported: QueryError = {
  category: "unsupported",
  message: "this engine does not expose schemas",
};

const internal: QueryError = {
  category: "internal",
  message: "metadata listing failed",
};

function connected(connectionId: string): ExplorerTarget {
  return { status: "connected", connectionId };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  listScopesMock.mockResolvedValue({});
  listObjectsMock.mockResolvedValue([]);
});

afterEach(cleanup);

describe("useExplorer", () => {
  it("loads scopes and objects for a connected target", async () => {
    const listing: ScopeListing = { schemas: ["public"] };
    listScopesMock.mockResolvedValue(listing);
    listObjectsMock.mockResolvedValue([users, orders]);

    const { result } = renderHook(() => useExplorer(connected("c1")));

    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );

    expect(listScopesMock).toHaveBeenCalledWith("c1");
    expect(listObjectsMock).toHaveBeenCalledWith("c1", undefined);
    expect(result.current.scopes).toEqual({ status: "ready", listing });
    expect(result.current.groups.map((group) => group.label)).toEqual([
      "public",
    ]);
  });

  it("keeps the object list when the engine exposes no scopes", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users]);

    const { result } = renderHook(() => useExplorer(connected("sqlite-1")));

    await waitFor(() =>
      expect(result.current.scopes.status).toBe("unsupported"),
    );
    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );

    expect(result.current.groups).toHaveLength(1);
    expect(result.current.groups[0].objects).toEqual([users]);
  });

  it("surfaces object listing failures instead of an empty success", async () => {
    listObjectsMock.mockRejectedValue(internal);

    const { result } = renderHook(() => useExplorer(connected("c1")));

    await waitFor(() =>
      expect(result.current.objects.status).toBe("error"),
    );

    if (result.current.objects.status !== "error") {
      throw new Error("expected an error object state");
    }
    expect(result.current.objects.error.message).toBe(internal.message);
  });

  it("loads detail only after an object is selected", async () => {
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockResolvedValue(description);

    const { result } = renderHook(() => useExplorer(connected("c1")));

    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );
    expect(describeTableMock).not.toHaveBeenCalled();
    expect(result.current.detail.status).toBe("idle");

    act(() => result.current.select(users));

    await waitFor(() =>
      expect(result.current.detail.status).toBe("ready"),
    );
    expect(describeTableMock).toHaveBeenCalledWith("c1", users);
  });

  it("filters the visible objects", async () => {
    listObjectsMock.mockResolvedValue([users, orders]);

    const { result } = renderHook(() => useExplorer(connected("c1")));

    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );

    act(() => result.current.setFilter("ord"));

    expect(result.current.filteredObjects).toEqual([orders]);
    expect(
      result.current.groups.flatMap((group) => group.objects),
    ).toEqual([orders]);
  });

  it("refreshes scopes, objects, and detail", async () => {
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockResolvedValue(description);

    const { result } = renderHook(() => useExplorer(connected("c1")));

    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );
    act(() => result.current.select(users));
    await waitFor(() =>
      expect(result.current.detail.status).toBe("ready"),
    );

    act(() => result.current.refresh());

    await waitFor(() => expect(listScopesMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listObjectsMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(describeTableMock).toHaveBeenCalledTimes(2));
  });

  it("discards results from a previous connection", async () => {
    const firstScopes = deferred<ScopeListing>();
    const secondScopes = deferred<ScopeListing>();
    listScopesMock.mockImplementation((connectionId: string) =>
      connectionId === "c1" ? firstScopes.promise : secondScopes.promise,
    );
    listObjectsMock.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ target }: { target: ExplorerTarget }) => useExplorer(target),
      { initialProps: { target: connected("c1") } },
    );

    rerender({ target: connected("c2") });
    act(() => {
      secondScopes.resolve({ schemas: ["second"] });
    });

    await waitFor(() =>
      expect(result.current.scopes).toEqual({
        status: "ready",
        listing: { schemas: ["second"] },
      }),
    );

    act(() => {
      firstScopes.resolve({ schemas: ["first"] });
    });

    await waitFor(() =>
      expect(result.current.scopes).toEqual({
        status: "ready",
        listing: { schemas: ["second"] },
      }),
    );
  });

  it("clears selection and detail when the connection changes", async () => {
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockResolvedValue(description);

    const { result, rerender } = renderHook(
      ({ target }: { target: ExplorerTarget }) => useExplorer(target),
      { initialProps: { target: connected("c1") } },
    );

    await waitFor(() =>
      expect(result.current.objects.status).toBe("ready"),
    );
    act(() => result.current.select(users));
    await waitFor(() =>
      expect(result.current.detail.status).toBe("ready"),
    );

    rerender({ target: connected("c2") });

    expect(result.current.selected).toBeNull();
    expect(result.current.detail.status).toBe("idle");
  });

  it("does not call the backend while disconnected", () => {
    renderHook(() => useExplorer({ status: "disconnected" }));

    expect(listScopesMock).not.toHaveBeenCalled();
    expect(listObjectsMock).not.toHaveBeenCalled();
  });
});

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ObjectRef,
  QueryError,
  TableDescription,
} from "../../domain";
import {
  describeTable,
  listObjects,
  listScopes,
} from "../../services/metadata";
import { ExplorerPanel } from "./ExplorerPanel";
import type { ExplorerTarget } from "./target";

vi.mock("../../services/metadata", () => ({
  describeTable: vi.fn(),
  listObjects: vi.fn(),
  listScopes: vi.fn(),
}));

const listScopesMock = vi.mocked(listScopes);
const listObjectsMock = vi.mocked(listObjects);
const describeTableMock = vi.mocked(describeTable);

const users: ObjectRef = { schema: "public", name: "users", kind: "table" };
const activeUsers: ObjectRef = {
  schema: "public",
  name: "active_users",
  kind: "view",
};

const unsupported: QueryError = {
  category: "unsupported",
  message: "this engine does not expose schemas",
};

const description: TableDescription = {
  columns: [
    { name: "id", typeName: "integer", nullable: false },
    { name: "email", typeName: "text", nullable: false },
  ],
  primaryKeyColumns: ["id"],
  indexes: [
    { name: "users_pkey", columns: ["id"], unique: true, primary: true },
  ],
  constraints: [
    { name: "users_email_key", kind: "unique", columns: ["email"] },
  ],
};

const connected: ExplorerTarget = {
  status: "connected",
  connectionId: "c1",
};

beforeEach(() => {
  vi.clearAllMocks();
  listScopesMock.mockResolvedValue({});
  listObjectsMock.mockResolvedValue([]);
});

afterEach(cleanup);

describe("ExplorerPanel", () => {
  it("prompts for a connection while disconnected", () => {
    render(<ExplorerPanel target={{ status: "disconnected" }} />);

    expect(
      screen.getByText(/Connect to a database to browse schemas/),
    ).toBeTruthy();
    expect(listScopesMock).not.toHaveBeenCalled();
  });

  it("shows an empty object state for a connected engine", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([]);

    render(<ExplorerPanel target={connected} />);

    expect(await screen.findByText("No tables or views.")).toBeTruthy();
    expect(screen.queryByLabelText("Schema")).toBeNull();
  });

  it("lists objects and does not show a scope picker without scopes", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users, activeUsers]);

    render(<ExplorerPanel target={connected} />);

    expect(
      await screen.findByRole("button", { name: "public.users table" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "public.active_users view" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Schema")).toBeNull();
  });

  it("shows a scope picker for an engine that exposes schemas", async () => {
    listScopesMock.mockResolvedValue({ schemas: ["public", "audit"] });
    listObjectsMock.mockResolvedValue([users]);

    render(<ExplorerPanel target={connected} />);

    const picker = await screen.findByLabelText("Schema");
    expect(picker).toBeTruthy();
    expect(screen.getByRole("option", { name: "audit" })).toBeTruthy();
  });

  it("filters objects and reports when nothing matches", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users, activeUsers]);

    render(<ExplorerPanel target={connected} />);

    const filter = await screen.findByLabelText("Filter objects");
    fireEvent.change(filter, { target: { value: "zzz" } });

    expect(
      screen.getByText("No objects match the filter."),
    ).toBeTruthy();
  });

  it("shows columns, keys, indexes, and constraints for a selected object", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockResolvedValue(description);

    render(<ExplorerPanel target={connected} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "public.users table" }),
    );

    const columns = await screen.findByRole("list", { name: "Columns" });
    expect(within(columns).getByText("id")).toBeTruthy();
    expect(within(columns).getByText("integer")).toBeTruthy();

    const indexes = screen.getByRole("list", { name: "Indexes" });
    expect(within(indexes).getByText("users_pkey")).toBeTruthy();

    const constraints = screen.getByRole("list", { name: "Constraints" });
    expect(within(constraints).getByText("users_email_key")).toBeTruthy();
    expect(describeTableMock).toHaveBeenCalledWith("c1", users);
  });

  it("marks unsupported index and constraint metadata instead of showing it as empty", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockResolvedValue({
      columns: [{ name: "id", typeName: "integer", nullable: false }],
      primaryKeyColumns: ["id"],
    });

    render(<ExplorerPanel target={connected} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "public.users table" }),
    );

    await screen.findByRole("list", { name: "Columns" });
    expect(
      screen.getAllByText("Not supported for this object."),
    ).toHaveLength(2);
  });

  it("shows a detail error without presenting it as empty success", async () => {
    listScopesMock.mockRejectedValue(unsupported);
    listObjectsMock.mockResolvedValue([users]);
    describeTableMock.mockRejectedValue({
      category: "permission",
      message: "permission denied for relation users",
    } satisfies QueryError);

    render(<ExplorerPanel target={connected} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "public.users table" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("permission denied");
  });
});

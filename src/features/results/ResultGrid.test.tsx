import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockResultSet } from "./mockResult";
import { ResultGrid } from "./ResultGrid";

const glide = vi.hoisted(() => ({
  props: undefined as
    | {
        rows: number;
        columns: { title: string }[];
        getCellContent: (cell: readonly [number, number]) => { kind: string };
        onCellEdited: (
          cell: readonly [number, number],
          value: unknown,
        ) => void;
        onCellsEdited: (
          edits: readonly { location: readonly [number, number]; value: unknown }[],
        ) => boolean | void;
      }
    | undefined,
}));

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: {
    Text: "text",
    Number: "number",
    Boolean: "boolean",
  },
  getDefaultTheme: () => ({}),
  DataEditor: (props: unknown) => {
    glide.props = props as typeof glide.props;
    return null;
  },
}));

afterEach(cleanup);

describe("ResultGrid", () => {
  it("derives Glide columns and row count from the normalized result set", () => {
    const result = createMockResultSet(4);

    render(<ResultGrid result={result} />);

    expect(glide.props?.rows).toBe(4);
    expect(glide.props?.columns.map((column) => column.title)).toEqual(
      result.columns.map((column) => column.name),
    );
    expect(glide.props?.getCellContent([0, 0]).kind).toBe("number");
    expect(glide.props?.getCellContent([4, 0]).kind).toBe("text");
  });

  it("reports a single edit as a normalized value", () => {
    const onCellEdit = vi.fn();

    render(<ResultGrid result={createMockResultSet(2)} onCellEdit={onCellEdit} />);

    glide.props?.onCellEdited([1, 0], {
      kind: "text",
      data: "Changed",
      displayData: "Changed",
      allowOverlay: true,
    });

    expect(onCellEdit).toHaveBeenCalledWith([1, 0], {
      type: "text",
      value: "Changed",
    });
  });

  it("reports paste edits as a normalized batch", () => {
    const onCellsEdit = vi.fn();

    render(
      <ResultGrid result={createMockResultSet(2)} onCellsEdit={onCellsEdit} />,
    );

    const handled = glide.props?.onCellsEdited([
      {
        location: [1, 0],
        value: {
          kind: "text",
          data: "Batch",
          displayData: "Batch",
          allowOverlay: true,
        },
      },
    ]);

    expect(handled).toBe(true);
    expect(onCellsEdit).toHaveBeenCalledWith([
      { location: [1, 0], value: { type: "text", value: "Batch" } },
    ]);
  });
});

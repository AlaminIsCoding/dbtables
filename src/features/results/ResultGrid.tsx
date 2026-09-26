import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataEditor,
  type DataEditorProps,
  type EditableGridCell,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";

import { cn } from "../../components/ui/cn";
import type { CellValue } from "../../domain";
import { cellValueToGridCell, gridCellToCellValue } from "./cellValue";
import { columnsToGridColumns } from "./gridColumns";
import { useGlideTheme } from "./gridTheme";
import type { ResultSet } from "./resultSet";

import "@glideapps/glide-data-grid/dist/index.css";

const FALLBACK_WIDTH = 640;
const FALLBACK_HEIGHT = 320;

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const measure = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return {
    ref,
    width: size.width || FALLBACK_WIDTH,
    height: size.height || FALLBACK_HEIGHT,
  };
}

export interface ResultGridProps {
  /** Normalized result data rendered by the grid. */
  result: ResultSet;
  /** Called with the normalized value when a single cell is edited locally. */
  onCellEdit?: (location: Item, value: CellValue) => void;
  /** Called with the normalized batch when a paste or fill edits cells. */
  onCellsEdit?: (edits: readonly { location: Item; value: CellValue }[]) => void;
  /** Called when the grid selection changes. */
  onSelectionChange?: (selection: GridSelection) => void;
  className?: string;
}

/**
 * Glide Data Grid adapter for normalized result data.
 *
 * The grid is a presentation/interaction layer: it derives its columns and
 * cells from a `ResultSet` and reports edits/selection back as normalized
 * values. It holds no database state and generates no SQL.
 */
export function ResultGrid({
  result,
  onCellEdit,
  onCellsEdit,
  onSelectionChange,
  className,
}: ResultGridProps) {
  const { ref, width, height } = useElementSize<HTMLDivElement>();
  const theme = useGlideTheme();
  const columns = useMemo(
    () => columnsToGridColumns(result.columns),
    [result.columns],
  );
  const rows = result.rows;

  const getCellContent = useCallback<DataEditorProps["getCellContent"]>(
    (cell) => {
      const [col, row] = cell;
      const value = rows[row]?.[col] ?? { type: "null" };
      return cellValueToGridCell(value);
    },
    [rows],
  );

  const handleCellEdited = useCallback(
    (cell: Item, newValue: EditableGridCell) => {
      const [col, row] = cell;
      const previous = rows[row]?.[col] ?? { type: "null" };
      onCellEdit?.(cell, gridCellToCellValue(newValue, previous));
    },
    [rows, onCellEdit],
  );

  const handleCellsEdited = useCallback<
    NonNullable<DataEditorProps["onCellsEdited"]>
  >(
    (edits) => {
      const mapped = edits.map(({ location, value }) => {
        const [col, row] = location;
        const previous = rows[row]?.[col] ?? { type: "null" };
        return { location, value: gridCellToCellValue(value, previous) };
      });

      onCellsEdit?.(mapped);

      // Returning true suppresses the individual onCellEdited callback for the
      // batch, so paste/fill are reported once through onCellsEdit.
      return true;
    },
    [rows, onCellsEdit],
  );

  return (
    <div
      ref={ref}
      role="region"
      aria-label={`Query results grid: ${rows.length} rows, ${result.columns.length} columns`}
      className={cn("h-full w-full overflow-hidden", className)}
    >
      <DataEditor
        width={width}
        height={height}
        columns={columns}
        rows={rows.length}
        getCellContent={getCellContent}
        // Editing stays disabled unless a caller supplies a handler; the
        // read-only query slice never writes result edits back.
        onCellEdited={onCellEdit ? handleCellEdited : undefined}
        onCellsEdited={onCellsEdit ? handleCellsEdited : undefined}
        onGridSelectionChange={onSelectionChange}
        getCellsForSelection
        copyHeaders
        rowMarkers="number"
        rowMarkerWidth={44}
        headerHeight={30}
        rowHeight={30}
        smoothScrollX
        smoothScrollY
        rangeSelect="multi-rect"
        columnSelect="multi"
        rowSelect="multi"
        theme={theme}
      />
    </div>
  );
}

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { cn } from "../ui/cn";

const MIN_FRACTION = 0.2;
const MAX_FRACTION = 0.8;
const KEYBOARD_STEP = 0.05;

function clampFraction(value: number): number {
  return Math.min(MAX_FRACTION, Math.max(MIN_FRACTION, value));
}

export interface SplitPaneProps {
  /** Top pane content. */
  start: ReactNode;
  /** Bottom pane content. */
  end: ReactNode;
  /** Starting height of the top pane as a fraction of the container. */
  initialFraction?: number;
  /** Accessible name for the top pane region. */
  startLabel?: string;
  /** Accessible name for the bottom pane region. */
  endLabel?: string;
  className?: string;
}

/**
 * Vertical split area with a compact draggable/arrow-key-resizable divider.
 *
 * The divider is keyboard operable (`ArrowUp`/`ArrowDown`/`Home`/`End`) so the
 * layout can be validated without a pointer and remains accessible.
 */
export function SplitPane({
  start,
  end,
  initialFraction = 0.55,
  startLabel = "Editor",
  endLabel = "Results",
  className,
}: SplitPaneProps) {
  const [fraction, setFraction] = useState(() => clampFraction(initialFraction));
  const containerRef = useRef<HTMLDivElement>(null);

  const setFromClientY = useCallback((clientY: number) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.height === 0) {
      return;
    }

    setFraction(clampFraction((clientY - bounds.top) / bounds.height));
  }, []);

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      return;
    }

    setFromClientY(event.clientY);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFraction((value) => clampFraction(value - KEYBOARD_STEP));
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setFraction((value) => clampFraction(value + KEYBOARD_STEP));
    } else if (event.key === "Home") {
      event.preventDefault();
      setFraction(MIN_FRACTION);
    } else if (event.key === "End") {
      event.preventDefault();
      setFraction(MAX_FRACTION);
    }
  }

  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <section
        aria-label={`${startLabel} pane`}
        className="min-h-0 overflow-auto"
        style={{ height: `${fraction * 100}%` }}
      >
        {start}
      </section>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${startLabel.toLowerCase()} and ${endLabel.toLowerCase()}`}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(MIN_FRACTION * 100)}
        aria-valuemax={Math.round(MAX_FRACTION * 100)}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onKeyDown={handleKeyDown}
        className="h-1 shrink-0 cursor-row-resize bg-border transition-colors hover:bg-ring focus-visible:bg-ring focus-visible:outline-none"
      />

      <section
        aria-label={`${endLabel} pane`}
        className="min-h-0 flex-1 overflow-auto"
      >
        {end}
      </section>
    </div>
  );
}

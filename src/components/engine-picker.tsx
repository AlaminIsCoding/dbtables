import type { EngineId } from "@/domain";
import { ENGINE_IDS, ENGINE_LABELS } from "@/lib/engines";
import { cn } from "@/lib/utils";

import { EngineLogo } from "./engine-logo";

export interface EnginePickerProps {
  /** Currently selected engine. */
  value: EngineId;
  /** Called with the newly selected engine. */
  onSelect: (engine: EngineId) => void;
  /** Engines to offer, in order. Defaults to every supported engine. */
  engines?: readonly EngineId[];
  /** Show the engine name next to its logo instead of icon-only. */
  showLabels?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Radio-style engine selector.
 *
 * Each engine logo is a clickable option and the selected one is highlighted,
 * so the control behaves like a radio group. Used compactly in the top bar and
 * with visible labels in the connection form.
 */
export function EnginePicker({
  value,
  onSelect,
  engines = ENGINE_IDS,
  showLabels = false,
  disabled = false,
  className,
}: EnginePickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Engine"
      className={cn("flex items-center gap-1", className)}
    >
      {engines.map((engine) => {
        const selected = engine === value;
        const label = ENGINE_LABELS[engine];
        return (
          <button
            key={engine}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={showLabels ? undefined : label}
            disabled={disabled}
            onClick={() => onSelect(engine)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
              showLabels ? "h-9 px-2.5" : "size-7 justify-center",
              selected
                ? "border-primary/60 bg-accent text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <EngineLogo
              engine={engine}
              className={showLabels ? "size-5" : "size-4"}
            />
            {showLabels ? <span>{label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

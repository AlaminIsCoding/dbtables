import {
  createContext,
  useContext,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import { cn } from "./cn";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);

  if (!context) {
    throw new Error(`${component} must be rendered inside <Tabs>.`);
  }

  return context;
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  /** Initial tab for uncontrolled usage. */
  defaultValue?: string;
  /** Controlled selected tab. */
  value?: string;
  /** Called with the newly selected tab value. */
  onValueChange?: (value: string) => void;
  children: ReactNode;
}

/**
 * Minimal shadcn-style tabs primitive.
 *
 * Supports both controlled (`value` + `onValueChange`) and uncontrolled
 * (`defaultValue`) usage so the workspace can swap in real query-tab state
 * without changing the primitive.
 */
export function Tabs({
  defaultValue = "",
  value,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const isControlled = value !== undefined;
  const currentValue = isControlled ? value : uncontrolledValue;
  const baseId = useId();

  const context = useMemo<TabsContextValue>(
    () => ({
      value: currentValue,
      setValue: (next) => {
        if (!isControlled) {
          setUncontrolledValue(next);
        }
        onValueChange?.(next);
      },
      baseId,
    }),
    [currentValue, isControlled, onValueChange, baseId],
  );

  return (
    <TabsContext.Provider value={context}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

export interface TabsTriggerProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({
  value,
  className,
  children,
  ...props
}: TabsTriggerProps) {
  const { value: currentValue, setValue, baseId } = useTabsContext("TabsTrigger");
  const isSelected = currentValue === value;

  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-selected={isSelected}
      aria-controls={`${baseId}-panel-${value}`}
      data-state={isSelected ? "active" : "inactive"}
      tabIndex={isSelected ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        "inline-flex h-7 items-center rounded-t-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        isSelected &&
          "bg-background text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({
  value,
  className,
  children,
  ...props
}: TabsContentProps) {
  const { value: currentValue, baseId } = useTabsContext("TabsContent");
  const isSelected = currentValue === value;

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      hidden={!isSelected}
      className={cn("min-h-0", className)}
      {...props}
    >
      {isSelected ? children : null}
    </div>
  );
}

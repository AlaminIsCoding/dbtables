import { CheckIcon, DatabaseIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { EngineLogo } from "@/components/engine-logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface DatabasePickerDialogProps {
  /** Whether the picker is shown. */
  open: boolean;
  /** Called when the picker is opened or closed. */
  onOpenChange: (open: boolean) => void;
  /** Called after a database is chosen (before the picker closes). */
  onDatabaseChosen?: (database: string) => void;
}

/**
 * Database chooser for the active server connection.
 *
 * Lists every database the connected engine exposes (`list_scopes`), so a
 * multi-database engine such as MySQL can switch the working database without
 * reconnecting. It is the one picker used both by the top bar's "Open database"
 * button and the automatic prompt shown after connecting.
 */
export function DatabasePickerDialog({
  open,
  onOpenChange,
  onDatabaseChosen,
}: DatabasePickerDialogProps) {
  const { connections, scopes, scope, setScope } = useWorkspace();

  const profiles =
    connections.profiles.status === "ready" ? connections.profiles.profiles : [];
  const activeProfileId =
    connections.active.status === "connected" ||
    connections.active.status === "connecting"
      ? connections.active.profileId
      : null;
  const activeProfile = profiles.find(
    (profile) => profile.id === activeProfileId,
  );

  const databases = scopes?.databases ?? [];
  const current = scope.database;

  function choose(database: string) {
    setScope({ ...scope, database });
    onDatabaseChosen?.(database);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {activeProfile ? (
              <EngineLogo
                engine={activeProfile.descriptor.engine}
                className="size-4"
              />
            ) : (
              <DatabaseIcon className="size-4" />
            )}
            Open a database
          </DialogTitle>
          <DialogDescription>
            {activeProfile ? (
              <>
                Choose a database on{" "}
                <span className="font-medium">{activeProfile.name}</span>.
              </>
            ) : (
              "Choose a database to open."
            )}
          </DialogDescription>
        </DialogHeader>

        {databases.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            This connection has no selectable databases.
          </p>
        ) : (
          <ul
            aria-label="Databases"
            className="app-scroll -mx-1 flex max-h-72 flex-col gap-0.5 overflow-auto px-1"
          >
            {databases.map((database) => {
              const selected = database === current;
              return (
                <li key={database}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => choose(database)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                      selected && "bg-accent text-accent-foreground",
                    )}
                  >
                    <DatabaseIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate font-mono">
                      {database}
                    </span>
                    {selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

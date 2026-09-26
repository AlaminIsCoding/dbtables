import type { ReactNode } from "react";

import { ConnectionManager, type ConnectionManagerController } from "@/features/connections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConnectionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controller: ConnectionManagerController;
  children?: ReactNode;
}

/** Modal hosting the saved-connection manager, shared by the top bar and the connect screen. */
export function ConnectionsDialog({
  open,
  onOpenChange,
  controller,
}: ConnectionsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            Create and connect SQLite databases. Passwords for server engines are
            stored in the operating system credential store.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-y-auto px-4 pb-4">
          <ConnectionManager controller={controller} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

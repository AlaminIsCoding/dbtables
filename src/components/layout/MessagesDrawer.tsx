import { useEffect } from "react";
import { EyeIcon, XIcon } from "lucide-react";

import { useWorkspace } from "@/app/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const LEVEL_CLASS: Record<string, string> = {
  info: "text-sky-500",
  success: "text-emerald-500",
  warning: "text-primary",
  error: "text-destructive",
  notice: "text-violet-500",
};

/** Collapsible drawer showing the database message log. */
export function MessagesDrawer() {
  const { messages, messagesOpen, setMessagesOpen, clearMessages, markMessagesRead } =
    useWorkspace();

  useEffect(() => {
    if (messagesOpen) {
      markMessagesRead();
    }
  }, [messagesOpen, markMessagesRead]);

  if (!messagesOpen) {
    return null;
  }

  return (
    <div className="absolute inset-x-0 bottom-0 z-40 flex h-60 flex-col border-t border-border bg-card text-card-foreground shadow-[0_-8px_24px_-8px_rgba(0,0,0,0.18)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-muted px-3 text-[11px]">
        <span className="font-semibold tracking-wide text-muted-foreground uppercase">
          Database messages
        </span>
        <Badge variant="secondary">{messages.length}</Badge>
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={clearMessages}>
          Clear
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setMessagesOpen(false)}
          aria-label="Close messages"
        >
          <XIcon />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <p className="p-6 text-center text-xs text-muted-foreground">
            No messages yet. Connect to a database to begin.
          </p>
        ) : (
          <ul className="divide-y divide-border/60 font-mono text-[11px]">
            {messages.map((message) => (
              <li key={message.id} className="flex gap-2 px-3 py-1.5">
                <span
                  className={cn(
                    "w-14 shrink-0 font-sans font-semibold uppercase",
                    LEVEL_CLASS[message.level],
                  )}
                >
                  {message.level}
                </span>
                <span className="w-16 shrink-0 text-muted-foreground">
                  {message.time.toLocaleTimeString([], { hour12: false })}
                </span>
                <span className="min-w-0 flex-1 break-words">
                  {message.text}
                  {message.detail ? (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {message.detail}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
      <div className="flex h-6 shrink-0 items-center gap-1 border-t border-border px-3 text-[10px] text-muted-foreground">
        <EyeIcon className="size-3" />
        Showing the most recent {messages.length} message(s)
      </div>
    </div>
  );
}

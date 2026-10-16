import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface KbdProps {
  children: ReactNode;
  /** `boxed` : touche encadrée (esc dans la palette) ; sinon raccourci en ligne (⌘K). */
  boxed?: boolean;
  className?: string;
}

export function Kbd({ children, boxed, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        "mono text-tiny text-tx3",
        boxed && "rounded-badge border border-line2 px-1.5 py-0.5",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

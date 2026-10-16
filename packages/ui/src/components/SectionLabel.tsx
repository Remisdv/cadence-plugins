import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

/** Sur-titre de section : 10.5px, 600, capitales, interlettrage 0.09em, tx3. */
export function SectionLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("text-micro font-semibold tracking-[0.09em] text-tx3 uppercase", className)}
      {...rest}
    />
  );
}

import type { ReactNode } from "react";
import { cn } from "../lib/cn";

export interface KeyValueProps {
  label: ReactNode;
  value: ReactNode;
  /** Valeur en police mono (chemins, versions) — par défaut. */
  mono?: boolean;
  last?: boolean;
}

/** Ligne clé / valeur 12.5px séparée par un trait (fiche « Claude Code »). */
export function KeyValue({ label, value, mono = true, last }: KeyValueProps) {
  return (
    <div
      className={cn(
        "flex justify-between gap-3 py-[7px] text-body-sm short:py-[5px]",
        !last && "border-b border-line",
      )}
    >
      <span className="text-tx3">{label}</span>
      <span className={cn("text-right text-tx2", mono && "mono")}>{value}</span>
    </div>
  );
}

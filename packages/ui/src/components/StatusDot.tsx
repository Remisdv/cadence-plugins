import { cn } from "../lib/cn";

export const dotTones = {
  neutral: "bg-tx3",
  clay: "bg-clay",
  green: "bg-green",
  blue: "bg-blue",
  purple: "bg-purple",
  amber: "bg-amber",
  red: "bg-red",
} as const;

export type DotTone = keyof typeof dotTones;

export interface StatusDotProps {
  tone?: DotTone;
  /** 6px dans les listes, 7px en tête de colonne, 8px pour un état d'attente. */
  size?: 6 | 7 | 8;
  /** Halo animé : processus en cours / en attente d'un événement externe. */
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ tone = "neutral", size = 6, pulse, className }: StatusDotProps) {
  const dim = size === 6 ? "size-1.5" : size === 7 ? "size-[7px]" : "size-2";
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      {pulse && (
        <span
          className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dotTones[tone])}
        />
      )}
      <span className={cn("relative inline-block rounded-full", dim, dotTones[tone])} />
    </span>
  );
}

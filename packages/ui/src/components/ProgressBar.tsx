import { cn } from "../lib/cn";

const fills = {
  clay: "bg-clay",
  green: "bg-green",
  blue: "bg-blue",
  purple: "bg-purple",
  amber: "bg-amber",
  tx2: "bg-tx2",
  neutral: "bg-tx3",
} as const;

export type ProgressTone = keyof typeof fills;

export interface ProgressBarProps {
  /** 0 → 100 */
  value: number;
  tone?: ProgressTone;
  /** 3 (carte compacte d'un rail), 4 (listes, cartes de version) ou 5 (jauges). */
  height?: 3 | 4 | 5;
  /** Piste teintée verte, ex. carte d'une exécution en cours. */
  track?: "p4" | "green";
  label?: string;
  className?: string;
}

export function ProgressBar({
  value,
  tone = "clay",
  height = 4,
  track = "p4",
  label,
  className,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn("overflow-hidden", track === "green" ? "bg-green-track" : "bg-p4", className)}
      style={{ height, borderRadius: height }}
    >
      <div
        className={cn("h-full transition-[width]", fills[tone])}
        style={{ width: `${pct}%`, borderRadius: height }}
      />
    </div>
  );
}

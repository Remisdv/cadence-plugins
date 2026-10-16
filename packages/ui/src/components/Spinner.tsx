import { cn } from "../lib/cn";

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("animate-spin text-tx3", className)}
    >
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path
        d="M20.5 12A8.5 8.5 0 0 0 12 3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

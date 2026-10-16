import { cn } from "../lib/cn";

/** Tailles relevées dans les maquettes → taille des initiales. */
const sizes = {
  18: "size-[18px] text-[8px]",
  19: "size-[19px] text-[8px]",
  20: "size-5 text-[8px]",
  21: "size-[21px] text-[9px]",
  24: "size-6 text-[10px]",
  26: "size-[26px] text-[11px]",
} as const;

const tones = {
  /** Vous : fond clay sombre */
  clay: "bg-clay-d text-clay",
  /** Dépôts et autres personnes */
  neutral: "bg-avatar text-tx",
} as const;

export interface AvatarProps {
  /** Initiales affichées (2 lettres). */
  initials: string;
  size?: keyof typeof sizes;
  tone?: keyof typeof tones;
  /** URL d'avatar GitHub ; les initiales restent en repli. */
  src?: string | null;
  title?: string;
  className?: string;
}

export function Avatar({ initials, size = 24, tone = "clay", src, title, className }: AvatarProps) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        sizes[size],
        tones[tone],
        className,
      )}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials}
    </span>
  );
}

/** Initiales à partir d'un nom ou d'un login GitHub : « Rémi Lhuillier » → « RL », « cadence-app » → « CA ». */
export function initialsOf(nameOrLogin: string): string {
  const parts = nameOrLogin.split(/[\s\-_/.]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0]![0]! + parts[1]![0]! : nameOrLogin.slice(0, 2);
  return letters.toUpperCase();
}

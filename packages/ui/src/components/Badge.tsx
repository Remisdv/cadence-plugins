import type { HTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "../icons/Icon";
import { dotTones } from "./StatusDot";

/**
 * Pastille des maquettes : 21px / radius 5 / 11.5px 500, fond `<ton>-d` + texte `<ton>`.
 * `mono` sert aux numéros de version (0.1.3) et aux identifiants.
 */
export const badgeVariants = cva(
  "inline-flex h-[21px] shrink-0 items-center gap-[5px] rounded-badge text-caption font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-p3 text-tx3",
        muted: "bg-p3 text-tx2",
        clay: "bg-clay-d text-clay",
        green: "bg-green-d text-green",
        blue: "bg-blue-d text-blue",
        purple: "bg-purple-d text-purple",
        amber: "bg-amber-d text-amber",
        red: "bg-red-d text-red",
      },
      mono: {
        true: "px-[7px] mono",
        false: "px-2",
      },
    },
    defaultVariants: { tone: "neutral", mono: false },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: IconName;
  /** Point 6px de la couleur du ton (« 5 à valider », « étape 3/6 »). */
  dot?: boolean;
  children: ReactNode;
}

const dotForTone: Record<BadgeTone, string> = {
  neutral: dotTones.neutral,
  muted: dotTones.neutral,
  clay: dotTones.clay,
  green: dotTones.green,
  blue: dotTones.blue,
  purple: dotTones.purple,
  amber: dotTones.amber,
  red: dotTones.red,
};

export function Badge({ tone, mono, icon, dot, className, children, ...rest }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, mono }), className)} {...rest}>
      {dot && <span className={cn("size-1.5 rounded-full", dotForTone[tone ?? "neutral"])} />}
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

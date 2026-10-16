import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "../icons/Icon";

/**
 * Bouton des maquettes : 32px / radius 7 / 13px 500 par défaut, 38px / radius 8 en `lg`
 * (CTA d'onboarding). `primary` = aplat clay, `secondary` = p3 + trait line2, `ghost` = transparent + trait line.
 */
export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-clay font-semibold text-clay-ink hover:bg-clay-hover hover:text-clay-ink",
        secondary: "border border-line2 bg-p3 text-tx hover:bg-p4 hover:text-tx",
        ghost: "border border-line bg-transparent text-tx2 hover:bg-p2 hover:text-tx",
        quiet: "bg-transparent text-tx3 hover:bg-p3 hover:text-tx",
        /* Famille teintée : fond <ton>-d, texte <ton>, bordure <ton>-line */
        danger: "border border-red-line bg-red-d text-red hover:border-red hover:text-red",
        success:
          "border border-green-line bg-green-d text-green hover:border-green hover:text-green",
        purple:
          "border border-purple-line bg-purple-d text-purple hover:border-purple hover:text-purple",
      },
      size: {
        /** 26px — action discrète dans un en-tête de carte (« Éditer »). */
        xs: "h-[26px] gap-1.5 rounded-control px-2.5 text-caption",
        /** 28px — actions secondaires dans une carte (Modifier / Rejeter). */
        sm: "h-7 gap-1.5 rounded-control px-3 text-small",
        /** 30px — liens d'action compacts (« Ouvrir », « Suivre »). */
        compact: "h-[30px] gap-1.5 rounded-control px-[11px] text-body-sm",
        /** 32px — taille par défaut (en-têtes, modales, formulaires). */
        md: "h-8 gap-1.5 rounded-control px-3 text-body",
        /** 36px — CTA pleine largeur dans un panneau latéral. */
        tall: "h-9 gap-[7px] rounded-lg px-3.5 text-body",
        /** 38px — CTA d'onboarding. */
        lg: "h-[38px] gap-[7px] rounded-lg px-[18px] text-body-lg",
      },
      iconOnly: { true: "px-0" },
      block: { true: "w-full" },
    },
    compoundVariants: [
      { iconOnly: true, size: "xs", className: "w-[26px]" },
      { iconOnly: true, size: "sm", className: "w-7" },
      { iconOnly: true, size: "compact", className: "w-[30px]" },
      { iconOnly: true, size: "md", className: "w-8" },
      { iconOnly: true, size: "tall", className: "w-9" },
      { iconOnly: true, size: "lg", className: "w-[38px]" },
    ],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

const iconSize = { xs: 13, sm: 14, compact: 14, md: 15, tall: 15, lg: 16 } as const;

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Rend l'enfant (ex. <a>) avec le style du bouton. */
  asChild?: boolean;
  icon?: IconName;
  iconRight?: IconName;
  children?: ReactNode;
}

export function Button({
  variant,
  size,
  iconOnly,
  block,
  asChild,
  icon,
  iconRight,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const s = iconSize[size ?? "md"];
  const classes = cn(buttonVariants({ variant, size, iconOnly, block }), className);

  if (asChild) {
    // L'enfant (ex. <a>) devient la racine ; Slottable place les icônes autour de son contenu.
    return (
      <Slot.Root className={classes} {...rest}>
        {icon && <Icon name={icon} size={s} />}
        <Slot.Slottable>{children}</Slot.Slottable>
        {iconRight && <Icon name={iconRight} size={s} />}
      </Slot.Root>
    );
  }

  return (
    <button type={type} className={classes} {...rest}>
      {icon && <Icon name={icon} size={s} />}
      {children}
      {iconRight && <Icon name={iconRight} size={s} />}
    </button>
  );
}

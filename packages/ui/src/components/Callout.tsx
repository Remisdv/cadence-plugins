import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "../icons/Icon";

const tones = {
  info: { box: "bg-blue-d border-blue-line", icon: "text-blue", defaultIcon: "warning" },
  warning: { box: "bg-amber-d border-amber-line", icon: "text-amber", defaultIcon: "warning" },
  success: { box: "bg-green-d border-green-line", icon: "text-green", defaultIcon: "check" },
  danger: { box: "bg-red-d border-red-line", icon: "text-red", defaultIcon: "warning" },
} as const satisfies Record<string, { box: string; icon: string; defaultIcon: IconName }>;

export interface CalloutProps {
  tone?: keyof typeof tones;
  icon?: IconName;
  children: ReactNode;
  className?: string;
}

/** Encadré d'information : fond `<ton>-d`, bordure `<ton>-line`, icône colorée + texte tx2 12.5px. */
export function Callout({ tone = "info", icon, children, className }: CalloutProps) {
  const t = tones[tone];
  return (
    <div className={cn("flex gap-2.5 rounded-[10px] border px-3.5 py-[13px]", t.box, className)}>
      <span className={cn("mt-px flex", t.icon)}>
        <Icon name={icon ?? t.defaultIcon} size={16} />
      </span>
      <div className="text-body-sm leading-[1.6] text-tx2">{children}</div>
    </div>
  );
}

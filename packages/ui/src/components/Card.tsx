import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

/** Panneau : fond panel, trait line, radius 12. Le padding est laissé au contenu (13–15px selon l'écran). */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-card border border-line bg-panel", className)} {...rest} />;
}

export interface CardHeaderProps {
  title: ReactNode;
  /** Éléments alignés à droite (badge, lien « Voir tout »…). */
  actions?: ReactNode;
  className?: string;
}

/** En-tête de panneau : h3 13px + actions à droite. */
export function CardHeader({ title, actions, className }: CardHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <h3 className="text-body">{title}</h3>
      <div className="grow" />
      {actions}
    </div>
  );
}

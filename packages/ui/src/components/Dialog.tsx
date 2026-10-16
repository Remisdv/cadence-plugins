import type { ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "../icons/Icon";

/**
 * Modale des maquettes (Nouvelle issue, Clôture de version) :
 * panel + trait line2, radius 14, ombre portée ; en-tête 50px, pied 56px sur fond p2.
 */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Largeur en px (620 pour la clôture, 664 pour une issue). */
  width?: number;
  /** Aligne la fenêtre en haut (palette de commandes) plutôt qu'au centre. */
  placement?: "center" | "top";
  children: ReactNode;
  className?: string;
  "aria-describedby"?: string;
}

export function Dialog({
  open,
  onOpenChange,
  width = 620,
  placement = "center",
  children,
  className,
  ...rest
}: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-backdrop/70" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 z-50 max-h-[calc(100vh-48px)] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden",
            "rounded-modal border border-line2 bg-panel text-body shadow-modal outline-none",
            placement === "center" ? "top-1/2 -translate-y-1/2" : "top-[60px]",
            className,
          )}
          style={{ width }}
          aria-describedby={rest["aria-describedby"]}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface DialogHeaderProps {
  title: ReactNode;
  icon?: IconName;
  /** Méta à droite du titre (ex. nom du dépôt). */
  meta?: ReactNode;
}

export function DialogHeader({ title, icon, meta }: DialogHeaderProps) {
  return (
    <div className="flex h-[50px] items-center gap-[9px] border-b border-line px-[18px]">
      {icon && (
        <span className="flex text-clay">
          <Icon name={icon} size={17} />
        </span>
      )}
      <DialogPrimitive.Title className="grow font-display text-title-sm font-semibold">
        {title}
      </DialogPrimitive.Title>
      {meta && <span className="text-caption text-tx3">{meta}</span>}
      <DialogPrimitive.Close aria-label="Fermer" className="flex text-tx3 hover:text-tx">
        <Icon name="close" size={16} />
      </DialogPrimitive.Close>
    </div>
  );
}

export function DialogBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-[15px] p-[18px]", className)}>{children}</div>;
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-14 items-center gap-2.5 border-t border-line bg-p2 px-[18px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export const DialogClose = DialogPrimitive.Close;

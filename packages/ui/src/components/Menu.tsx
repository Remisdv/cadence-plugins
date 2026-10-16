/**
 * Menu déroulant (Radix) au style des panneaux : sert aux puces de filtre et aux actions.
 */
import type { ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Icon } from "../icons/Icon";
import { cn } from "../lib/cn";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({
  children,
  align = "start",
  className,
}: {
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          "z-50 min-w-[200px] overflow-hidden rounded-card border border-line2 bg-panel p-1 shadow-modal outline-none",
          className,
        )}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-micro font-semibold tracking-[0.09em] text-tx3 uppercase">
      {children}
    </DropdownMenu.Label>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

const itemClass =
  "flex h-8 cursor-pointer items-center gap-2 rounded-control px-2.5 text-body-sm text-tx2 outline-none select-none data-[highlighted]:bg-p3 data-[highlighted]:text-tx data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

/** Case à cocher : choix multiples (versions). Le menu reste ouvert. */
export function MenuCheckboxItem({
  checked,
  onCheckedChange,
  children,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(e) => e.preventDefault()}
      className={itemClass}
    >
      <span className="flex size-4 items-center justify-center rounded-[4px] border border-line2 text-clay">
        <DropdownMenu.ItemIndicator>
          <Icon name="check" size={12} />
        </DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

/** Choix unique (état, assigné). */
export function MenuRadioGroup({
  value,
  onValueChange,
  children,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
      {children}
    </DropdownMenu.RadioGroup>
  );
}

export function MenuRadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem value={value} className={itemClass}>
      <span className="flex size-4 items-center justify-center text-clay">
        <DropdownMenu.ItemIndicator>
          <Icon name="check" size={13} />
        </DropdownMenu.ItemIndicator>
      </span>
      {children}
    </DropdownMenu.RadioItem>
  );
}

export function MenuItem({
  onSelect,
  disabled,
  children,
}: {
  onSelect: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Item onSelect={onSelect} disabled={disabled} className={itemClass}>
      {children}
    </DropdownMenu.Item>
  );
}

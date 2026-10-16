import { useId, type ReactNode } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "../lib/cn";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  className?: string;
}

/** Interrupteur 36×20 : actif = aplat clay + pastille clay-ink ; inactif = p4 + pastille tx3. */
export function Switch({ className, ...rest }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-[10px] bg-p4 p-0.5 transition-colors",
        "disabled:opacity-50 data-[state=checked]:bg-clay",
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-4 rounded-full bg-tx3 transition-transform",
          "data-[state=checked]:translate-x-4 data-[state=checked]:bg-clay-ink",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export interface SwitchFieldProps extends Omit<SwitchProps, "id" | "aria-label"> {
  label: ReactNode;
  hint?: ReactNode;
}

/** Interrupteur + libellé 13px + aide 11.5px, comme dans « Nouvelle issue ». */
export function SwitchField({ label, hint, className, ...rest }: SwitchFieldProps) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <Switch id={id} {...rest} />
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-body text-tx">
          {label}
        </label>
        {hint && <div className="mt-0.5 text-caption text-tx3">{hint}</div>}
      </div>
    </div>
  );
}

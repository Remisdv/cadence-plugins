import type { ReactNode } from "react";
import { RadioGroup } from "radix-ui";
import { cn } from "../lib/cn";

export interface RadioCardGroupProps {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  "aria-label"?: string;
  className?: string;
}

export function RadioCardGroup({ className, ...rest }: RadioCardGroupProps) {
  return <RadioGroup.Root className={cn("flex flex-col gap-[7px]", className)} {...rest} />;
}

function RadioMark() {
  return (
    <span className="mt-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-line2 bg-p2 group-data-[state=checked]:border-clay">
      <RadioGroup.Indicator className="size-1.5 rounded-full bg-clay" />
    </span>
  );
}

export interface RadioCardProps {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  /** Élément avant le titre (ex. badge de version). */
  leading?: ReactNode;
  disabled?: boolean;
}

/** Carte de choix : p2 + line au repos, p3 + bordure clay-line une fois choisie. */
export function RadioCard({ value, title, description, leading, disabled }: RadioCardProps) {
  return (
    <RadioGroup.Item
      value={value}
      disabled={disabled}
      className={cn(
        "group flex items-start gap-[11px] rounded-[10px] border border-line bg-p2 px-[13px] py-3 text-left",
        "disabled:opacity-50 data-[state=checked]:border-clay-line data-[state=checked]:bg-p3",
      )}
    >
      <RadioMark />
      <div className="min-w-0 grow">
        <div className="flex items-center gap-2">
          {leading}
          <span className="text-body font-medium group-data-[state=checked]:font-semibold">
            {title}
          </span>
        </div>
        {description && (
          <div className="mt-1 text-caption leading-normal text-tx3">{description}</div>
        )}
      </div>
    </RadioGroup.Item>
  );
}

/** Variante compacte sur une ligne (« Reporter sur 0.1.3 »). */
export function RadioOption({ value, children }: { value: string; children: ReactNode }) {
  return (
    <RadioGroup.Item
      value={value}
      className={cn(
        "group flex items-center gap-2.5 rounded-field border border-line bg-p2 px-[11px] py-[9px] text-left text-body-sm",
        "data-[state=checked]:border-line2 data-[state=checked]:bg-p3",
      )}
    >
      <span className="inline-flex size-[13px] shrink-0 items-center justify-center rounded-full border border-line2 group-data-[state=checked]:border-clay">
        <RadioGroup.Indicator className="size-1.5 rounded-full bg-clay" />
      </span>
      {children}
    </RadioGroup.Item>
  );
}

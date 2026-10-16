import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "../lib/cn";
import { Icon } from "../icons/Icon";

/* ---------- Libellé ---------- */

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  /** Précision en ligne, ex. « facultative — un skill la complétera ». */
  aside?: ReactNode;
}

export function Label({ required, aside, className, children, ...rest }: LabelProps) {
  return (
    <div className="flex items-baseline gap-2">
      <label className={cn("text-small font-medium text-tx2", className)} {...rest}>
        {children}
        {required && <span className="text-clay"> obligatoire</span>}
      </label>
      {aside && <span className="text-caption text-tx3">{aside}</span>}
    </div>
  );
}

/* ---------- Contrôles ---------- */

const control =
  "border bg-p2 text-tx placeholder:text-tx3 outline-none transition-colors focus:border-clay disabled:opacity-50";
const borderFor = (invalid?: boolean) => (invalid ? "border-red" : "border-line2");

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  /** `lg` 40px (champ principal), `md` 36px, `sm` 32px (saisie compacte). */
  size?: "sm" | "md" | "lg";
  mono?: boolean;
}

const inputSizes = {
  sm: "h-8 rounded-control px-2.5 text-body-sm",
  md: "h-9 rounded-lg px-2.5 text-body",
  lg: "h-10 rounded-field px-3 text-body-lg",
};

export function Input({ invalid, size = "lg", mono, className, ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(control, borderFor(invalid), inputSizes[size], mono && "mono", className)}
      {...rest}
    />
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  invalid?: boolean;
  size?: "sm" | "md";
}

/** Select natif stylé (les maquettes utilisent des <select> natifs). */
export function Select({ invalid, size = "md", className, ...rest }: SelectProps) {
  return (
    <select
      aria-invalid={invalid || undefined}
      className={cn(
        control,
        borderFor(invalid),
        size === "md"
          ? "h-9 rounded-lg px-2.5 text-body"
          : "h-8 rounded-control px-2.5 text-body-sm",
        className,
      )}
      {...rest}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        control,
        borderFor(invalid),
        "resize-none rounded-field px-3 py-[11px] text-body leading-[1.6]",
        className,
      )}
      {...rest}
    />
  );
}

/* ---------- Messages ---------- */

export function FieldError({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex items-center gap-1.5 text-caption text-red">
      <Icon name="warning" size={13} />
      {children}
    </div>
  );
}

export function FieldHint({ children }: { children: ReactNode }) {
  return <div className="text-caption text-tx3">{children}</div>;
}

/* ---------- Assemblage ---------- */

export interface FieldProps {
  label: ReactNode;
  htmlFor: string;
  required?: boolean;
  aside?: ReactNode;
  error?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Libellé + contrôle + erreur/aide, espacés de 6px. */
export function Field({
  label,
  htmlFor,
  required,
  aside,
  error,
  hint,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} required={required} aside={aside}>
        {label}
      </Label>
      {children}
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}

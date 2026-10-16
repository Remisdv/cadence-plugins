/**
 * @cadence/ui — composants du kit Cadence, tels qu'utilisés dans l'app.
 *
 * Styles : importer `@cadence/ui/globals.css` (Tailwind v4 + polices + tokens + base), ou
 * `@cadence/ui/theme.css` après votre propre `@import "tailwindcss"`. Sans Tailwind,
 * `@cadence/ui/tokens.css` donne les mêmes valeurs en variables CSS simples.
 */
export { cn } from "./lib/cn";

export { Icon, iconNames, type IconName, type IconProps } from "./icons/Icon";
export { ICON_NAMES } from "./icons/names";

export { Avatar, initialsOf, type AvatarProps } from "./components/Avatar";
export { Badge, badgeVariants, type BadgeProps, type BadgeTone } from "./components/Badge";
export { Button, buttonVariants, type ButtonProps } from "./components/Button";
export { Callout, type CalloutProps } from "./components/Callout";
export { Card, CardHeader, type CardHeaderProps } from "./components/Card";
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  type DialogHeaderProps,
  type DialogProps,
} from "./components/Dialog";
export {
  Field,
  FieldError,
  FieldHint,
  Input,
  Label,
  Select,
  Textarea,
  type FieldProps,
  type InputProps,
  type LabelProps,
  type SelectProps,
  type TextareaProps,
} from "./components/Field";
export { Kbd, type KbdProps } from "./components/Kbd";
export { KeyValue, type KeyValueProps } from "./components/KeyValue";
export {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./components/Menu";
export {
  ProgressBar,
  type ProgressBarProps,
  type ProgressTone,
} from "./components/ProgressBar";
export {
  RadioCard,
  RadioCardGroup,
  RadioOption,
  type RadioCardGroupProps,
  type RadioCardProps,
} from "./components/RadioCard";
export { SectionLabel } from "./components/SectionLabel";
export { Spinner } from "./components/Spinner";
export { StatusDot, dotTones, type DotTone, type StatusDotProps } from "./components/StatusDot";
export { Switch, SwitchField, type SwitchFieldProps, type SwitchProps } from "./components/Switch";

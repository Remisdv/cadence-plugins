import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge ne connaît pas les tailles de texte custom du thème : sans cette config,
 * `text-caption` et `text-tx3` seraient vus comme le même groupe et l'un écraserait l'autre.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        "micro",
        "tiny",
        "caption",
        "small",
        "body-sm",
        "body",
        "body-lg",
        "title-sm",
        "title",
        "kpi",
        "display-sm",
        "display",
      ],
      radius: ["badge", "control", "field", "card", "modal"],
      shadow: ["modal"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Noms des icônes du kit, sans dépendance à React : utilisés par les scripts du dépôt pour
 * valider les champs `icon` des manifestes. Doit rester égal aux clés de `paths` (Icon.tsx),
 * ce que vérifie names.test.ts.
 */
export const ICON_NAMES = [
  "sprint",
  "roadmap",
  "tag",
  "issue",
  "pullRequest",
  "review",
  "bot",
  "settings",
  "search",
  "chevronDown",
  "refresh",
  "plus",
  "check",
  "close",
  "clock",
  "link",
  "file",
  "pause",
  "play",
  "stop",
  "rocket",
  "book",
  "warning",
  "download",
  "arrowRight",
  "folder",
  "sparkle",
  "branch",
  "github",
  "layers",
  "user",
  "key",
  "eye",
  "calendar",
  "pen",
] as const;

export type IconNameLiteral = (typeof ICON_NAMES)[number];

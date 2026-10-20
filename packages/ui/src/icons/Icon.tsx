import type { ReactNode, SVGProps } from "react";

/**
 * Jeu d'icônes extrait tel quel des maquettes : grille 24×24, trait 1.7, extrémités arrondies.
 * Pour ajouter une icône : copier le contenu du <svg> de la maquette dans `paths`.
 */
const dot = { fill: "currentColor", stroke: "none" } as const;

const paths = {
  sprint: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
  roadmap: (
    <>
      <path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z" />
      <path d="M9 4v13.5M15 6.5V20" />
    </>
  ),
  tag: (
    <>
      <path d="M3.2 11.6V4.6A1.5 1.5 0 0 1 4.7 3.1h7l9.2 9.2-8.6 8.6z" />
      <circle cx="7.9" cy="7.9" r="1.35" />
    </>
  ),
  issue: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="1.8" {...dot} />
    </>
  ),
  pullRequest: (
    <>
      <circle cx="6.5" cy="6" r="2.4" />
      <circle cx="6.5" cy="18" r="2.4" />
      <path d="M6.5 8.4v7.2" />
      <circle cx="17.5" cy="18" r="2.4" />
      <path d="M17.5 15.6V9.4A2.9 2.9 0 0 0 14.6 6.5h-3.1" />
      <path d="m13.4 4.6-2 1.9 2 1.9" />
    </>
  ),
  review: (
    <>
      <path d="M4 5h16v11.5H9.5L4.5 20.5z" />
      <path d="m8.6 10.8 2.2 2.2 4.6-4.6" />
    </>
  ),
  bot: (
    <>
      <rect x="3.5" y="8" width="17" height="11.5" rx="3.2" />
      <path d="M12 3.6V8" />
      <circle cx="9" cy="13.6" r="1.25" {...dot} />
      <circle cx="15" cy="13.6" r="1.25" {...dot} />
      <path d="M1.6 13.2h1.9M20.5 13.2h1.9" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.6v3.1M12 18.3v3.1M21.4 12h-3.1M5.7 12H2.6M18.6 5.4l-2.2 2.2M7.6 16.4l-2.2 2.2M18.6 18.6l-2.2-2.2M7.6 7.6 5.4 5.4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.8 15.8 4.6 4.6" />
    </>
  ),
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  refresh: (
    <>
      <path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8" />
      <path d="M20.4 4.2v4.6h-4.6" />
    </>
  ),
  plus: <path d="M12 5.2v13.6M5.2 12h13.6" />,
  check: <path d="m4.8 12.6 4.9 4.9L19.4 7.5" />,
  close: <path d="m6.4 6.4 11.2 11.2M17.6 6.4 6.4 17.6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.2v5.2l3.3 1.9" />
    </>
  ),
  link: (
    <>
      <path d="M10.2 13.8a3.6 3.6 0 0 0 5.4.4l2.6-2.6a3.6 3.6 0 0 0-5.1-5.1l-1.5 1.5" />
      <path d="M13.8 10.2a3.6 3.6 0 0 0-5.4-.4l-2.6 2.6a3.6 3.6 0 0 0 5.1 5.1l1.5-1.5" />
    </>
  ),
  file: (
    <>
      <path d="M13.4 3.4H7a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13.4 3.4V9H19" />
    </>
  ),
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  play: <path d="M7.5 5.2 18.8 12 7.5 18.8z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  rocket: (
    <>
      <path d="M12 3.2c3.4 2 5.3 5.4 5.3 9.2L12 17.6 6.7 12.4c0-3.8 1.9-7.2 5.3-9.2z" />
      <circle cx="12" cy="10" r="1.7" />
      <path d="m8.6 16.2-2.3 4.6 4.3-2.4M15.4 16.2l2.3 4.6-4.3-2.4" />
    </>
  ),
  book: (
    <>
      <path d="M3.8 4.6h5.7a3 3 0 0 1 3 3v12.2a2.4 2.4 0 0 0-2.4-2.4H3.8z" />
      <path d="M20.2 4.6h-5.7a3 3 0 0 0-3 3v12.2a2.4 2.4 0 0 1 2.4-2.4h6.3z" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4.2 21 19.8H3z" />
      <path d="M12 10v4" />
      <circle cx="12" cy="17" r="0.9" {...dot} />
    </>
  ),
  download: (
    <>
      <path d="M12 3.8v11.4M7.4 10.8 12 15.4l4.6-4.6" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  arrowRight: <path d="M4.5 12h15M14 6.5l5.5 5.5L14 17.5" />,
  folder: (
    <path d="M3.2 6.6a2 2 0 0 1 2-2h3.4l2 2.4h8.2a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2z" />
  ),
  sparkle: (
    <>
      <path d="M12 3.2 13.7 8.3 18.8 10 13.7 11.7 12 16.8 10.3 11.7 5.2 10 10.3 8.3z" />
      <path d="m18.3 15.4.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6z" />
    </>
  ),
  branch: (
    <>
      <circle cx="7" cy="5.5" r="2.4" />
      <circle cx="7" cy="18.5" r="2.4" />
      <circle cx="17" cy="8" r="2.4" />
      <path d="M7 7.9v8.2M17 10.4v1.6a4.2 4.2 0 0 1-4.2 4.2H9.4" />
    </>
  ),
  github: (
    <path d="M9.2 19.2c-3.9 1.3-3.9-2.2-5.4-2.7m10.7 4.3v-3.3c0-.9-.1-1.3-.6-1.8 2.6-.3 5.2-1.3 5.2-5.7a4.4 4.4 0 0 0-1.2-3.1 4.1 4.1 0 0 0-.1-3s-1-.3-3.2 1.2a11 11 0 0 0-5.8 0C6.6 3.6 5.6 3.9 5.6 3.9a4.1 4.1 0 0 0-.1 3 4.4 4.4 0 0 0-1.2 3.1c0 4.4 2.6 5.4 5.2 5.7-.3.3-.6.9-.6 1.7v3.4" />
  ),
  layers: (
    <>
      <path d="m12 3.2 8.8 4.6L12 12.4 3.2 7.8z" />
      <path d="m3.2 12.2 8.8 4.6 8.8-4.6" />
      <path d="m3.2 16.4 8.8 4.6 8.8-4.6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.6" />
      <path d="M11.6 12h8.6M17.4 12v3M20.2 12v2.2" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.2" />
      <path d="M3.5 9.8h17M8 3.2v3.4M16 3.2v3.4" />
    </>
  ),
  /** Note, édition (même tracé que l'icône `pen` de l'app). */
  pen: (
    <>
      <path d="M4.5 19.5 5.3 15.6 15.8 5.1a2.1 2.1 0 0 1 3 3L8.3 18.6z" />
      <path d="m13.8 7.1 3 3" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;
export const iconNames = Object.keys(paths) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Taille en px. Les maquettes utilisent 12, 13, 14, 15, 16, 17 et 19. */
  size?: number;
  /** Libellé accessible ; sans lui, l'icône est décorative (aria-hidden). */
  label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      style={{ flexShrink: 0 }}
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

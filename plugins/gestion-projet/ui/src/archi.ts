/**
 * Architecture : vocabulaire des natures de service et mise en page automatique des schémas
 * (services en colonnes de l'entrée vers les données, couches en pile). Fonctions pures, testées.
 */
import type { BadgeTone } from "@cadence/ui";
import type { ArchiLayer, ArchiService, Architecture } from "./domain";

export const serviceKinds = [
  "proxy",
  "frontend",
  "backend",
  "worker",
  "queue",
  "cache",
  "database",
  "external",
  "autre",
] as const;
export type ServiceKind = (typeof serviceKinds)[number];

export const kindMeta: Record<ServiceKind, { label: string; tone: BadgeTone; column: number }> = {
  proxy: { label: "Proxy / entrée", tone: "purple", column: 0 },
  frontend: { label: "Front-end", tone: "blue", column: 1 },
  backend: { label: "Back-end", tone: "clay", column: 2 },
  worker: { label: "Tâches de fond", tone: "amber", column: 2 },
  queue: { label: "File de messages", tone: "purple", column: 3 },
  cache: { label: "Cache", tone: "amber", column: 3 },
  database: { label: "Base de données", tone: "green", column: 4 },
  external: { label: "Service externe", tone: "neutral", column: 5 },
  autre: { label: "Autre", tone: "muted", column: 5 },
};

export const kindOf = (k: string): ServiceKind =>
  (serviceKinds as readonly string[]).includes(k) ? (k as ServiceKind) : "autre";

export const BOX_W = 210;
export const BOX_H = 92;
const COL_GAP = 140;
const ROW_GAP = 28;

export interface Placed {
  service: ArchiService;
  x: number;
  y: number;
}

/**
 * Schéma système : une colonne par famille de nature (entrée → front → back → messages →
 * données → externes), colonnes vides retirées, services empilés dans l'ordre déclaré.
 */
export function layoutSystem(a: Pick<Architecture, "services">): {
  boxes: Placed[];
  width: number;
  height: number;
} {
  const columns = new Map<number, ArchiService[]>();
  for (const s of a.services) {
    const c = kindMeta[kindOf(s.kind)].column;
    columns.set(c, [...(columns.get(c) ?? []), s]);
  }
  const used = [...columns.keys()].sort((x, y) => x - y);
  const tallest = Math.max(1, ...used.map((c) => columns.get(c)!.length));
  const height = tallest * BOX_H + (tallest - 1) * ROW_GAP;
  const boxes: Placed[] = [];
  used.forEach((c, i) => {
    const list = columns.get(c)!;
    const block = list.length * BOX_H + (list.length - 1) * ROW_GAP;
    const top = (height - block) / 2;
    list.forEach((service, j) =>
      boxes.push({ service, x: i * (BOX_W + COL_GAP), y: top + j * (BOX_H + ROW_GAP) }),
    );
  });
  const width = used.length ? used.length * BOX_W + (used.length - 1) * COL_GAP : 0;
  return { boxes, width, height };
}

/** Tracé d'un lien entre deux boîtes : du bord droit vers le bord gauche, ou en arc si besoin. */
/** Profondeur de l'arc d'un lien qui saute une colonne (sous les boîtes). */
export const SKIP_DEPTH = 64;

export function linkPath(
  from: Placed,
  to: Placed,
): { d: string; mx: number; my: number; below: boolean } {
  const fy = from.y + BOX_H / 2;
  const ty = to.y + BOX_H / 2;
  // Un lien qui saute une colonne passerait derrière les boîtes : arc par-dessous.
  if (Math.abs(to.x - from.x) > BOX_W + COL_GAP) {
    const x1 = from.x + BOX_W / 2;
    const x2 = to.x + BOX_W / 2;
    const y1 = from.y + BOX_H;
    const y2 = to.y + BOX_H;
    const low = Math.max(y1, y2) + SKIP_DEPTH;
    return {
      d: `M${x1},${y1} C${x1},${low} ${x2},${low} ${x2},${y2}`,
      mx: (x1 + x2) / 2,
      my: low - 10,
      below: true,
    };
  }
  if (to.x > from.x) {
    const x1 = from.x + BOX_W;
    const x2 = to.x;
    const mid = (x1 + x2) / 2;
    return {
      d: `M${x1},${fy} C${mid},${fy} ${mid},${ty} ${x2},${ty}`,
      mx: mid,
      my: (fy + ty) / 2,
      below: false,
    };
  }
  if (to.x < from.x) {
    const x1 = from.x;
    const x2 = to.x + BOX_W;
    const mid = (x1 + x2) / 2;
    return {
      d: `M${x1},${fy} C${mid},${fy} ${mid},${ty} ${x2},${ty}`,
      mx: mid,
      my: (fy + ty) / 2,
      below: false,
    };
  }
  // Même colonne : arc par la droite.
  const x = from.x + BOX_W;
  const bulge = x + 48;
  return {
    d: `M${x},${fy} C${bulge},${fy} ${bulge},${ty} ${x},${ty}`,
    mx: bulge - 12,
    my: (fy + ty) / 2,
    below: false,
  };
}

/** Identifiant tiré d'un nom, unique parmi `taken` (minuscules, chiffres, tirets). */
export function archiId(name: string, taken: string[], fallback: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36) || fallback;
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Couches qu'aucune autre n'utilise (points d'entrée du service). */
export function entryLayers(layers: ArchiLayer[]): string[] {
  const used = new Set(layers.flatMap((l) => l.uses));
  return layers.filter((l) => !used.has(l.id)).map((l) => l.id);
}

/** Retire un service et ses liens. */
export function removeService(a: Architecture, id: string): Architecture {
  return {
    ...a,
    services: a.services.filter((s) => s.id !== id),
    links: a.links.filter((l) => l.from !== id && l.to !== id),
  };
}

/** Retire une couche d'un service et les dépendances vers elle. */
export function removeLayer(service: ArchiService, id: string): ArchiService {
  return {
    ...service,
    layers: service.layers
      .filter((l) => l.id !== id)
      .map((l) => ({ ...l, uses: l.uses.filter((u) => u !== id) })),
  };
}

/** Lignes non vides d'un texte (règles, conventions saisies une par ligne). */
export const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

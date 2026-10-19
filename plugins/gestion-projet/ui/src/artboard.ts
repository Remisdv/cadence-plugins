/** Plan de travail d'un design : taille d'un écran, cadrage et paliers de zoom. Fonctions pures. */

export interface Size {
  width: number;
  height: number;
}

/** Taille par défaut d'un écran dont le design ne dit rien (bureau). */
export const DEFAULT_SIZE: Size = { width: 1440, height: 900 };

/**
 * Taille d'un écran : celle que Claude Design déclare (`"$preview": { "width", "height" }` dans les
 * `data-props` d'une page `.dc.html`), sinon la largeur et la hauteur en px du premier bloc de la
 * page, sinon la taille par défaut.
 */
export function previewSize(html: string): Size {
  const declared = /"\$preview"\s*:\s*\{\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)/.exec(
    html,
  );
  if (declared) return { width: Number(declared[1]), height: Number(declared[2]) };
  const body = html.indexOf("<body");
  const block = /<div[^>]*style="[^"]*?width:\s*(\d+)px;\s*height:\s*(\d+)px/.exec(
    body >= 0 ? html.slice(body) : html,
  );
  if (block) return { width: Number(block[1]), height: Number(block[2]) };
  return DEFAULT_SIZE;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom qui fait tenir l'écran dans la zone visible (marges comprises), sans dépasser 100 %. */
export function fitZoom(size: Size, box: Size, margin = 96): number {
  if (box.width <= margin || box.height <= margin) return 1;
  return clampZoom(
    Math.min((box.width - margin) / size.width, (box.height - margin) / size.height, 1),
  );
}

/** Palier suivant (`+1`) ou précédent (`-1`) du zoom. */
export function stepZoom(z: number, direction: 1 | -1): number {
  if (direction > 0) return STEPS.find((s) => s > z + 0.001) ?? MAX_ZOOM;
  return [...STEPS].reverse().find((s) => s < z - 0.001) ?? MIN_ZOOM;
}

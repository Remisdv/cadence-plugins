import { describe, expect, it } from "vitest";
import { CANVAS_MAX_PIXELS, PAGE_MAX_WIDTH, pageWidth, renderScale } from "./viewers";

describe("visionneuse PDF", () => {
  it("plafonne la largeur des pages, même sur un écran très large", () => {
    // Écran 21:9 : la place disponible dépasse 3000 px, la page reste à la largeur d'une liseuse.
    expect(pageWidth(3100, 1)).toBe(PAGE_MAX_WIDTH);
    expect(pageWidth(700, 1)).toBe(700);
    expect(pageWidth(700, 1.5)).toBe(1050);
    expect(pageWidth(0, 1)).toBe(200);
  });

  it("borne la taille des toiles, zoom et écran haute densité compris", () => {
    // Page A4 (595 × 842 pt) à 300 % sur un écran ×2 : la toile reste sous le plafond.
    const scale = renderScale(3000, 595, 842, 2);
    expect(595 * scale * 842 * scale).toBeLessThanOrEqual(CANVAS_MAX_PIXELS + 1);
    // Petite page : échelle exacte.
    expect(renderScale(595, 595, 842, 1)).toBe(1);
  });
});

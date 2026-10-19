import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, fitZoom, previewSize, stepZoom } from "./artboard";

describe("plan de travail d'un design", () => {
  it("lit la taille déclarée par Claude Design", () => {
    const dc = `<x-dc><div style="width:700px;height:640px;"></div></x-dc>
<script data-dc-script data-props='{"$preview":{"width":1440,"height":900}}'></script>`;
    expect(previewSize(dc)).toEqual({ width: 1440, height: 900 });
  });

  it("se rabat sur le premier bloc, puis sur la taille par défaut", () => {
    expect(previewSize(`<body><div style="width:700px;height:640px;background:#000">`)).toEqual({
      width: 700,
      height: 640,
    });
    expect(previewSize("<body><p>texte</p></body>")).toEqual(DEFAULT_SIZE);
  });

  it("cadre l'écran sans l'agrandir", () => {
    expect(fitZoom({ width: 1440, height: 900 }, { width: 816, height: 546 })).toBeCloseTo(0.5, 2);
    expect(fitZoom({ width: 400, height: 300 }, { width: 1600, height: 900 })).toBe(1);
    expect(fitZoom({ width: 1440, height: 900 }, { width: 0, height: 0 })).toBe(1);
  });

  it("avance par paliers", () => {
    expect(stepZoom(0.5, 1)).toBe(0.67);
    expect(stepZoom(0.43, 1)).toBe(0.5);
    expect(stepZoom(0.43, -1)).toBe(0.33);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.1, -1)).toBe(0.1);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { displayLabels, isViewId, views } from "./domain";

describe("vues", () => {
  it("couvrent celles du manifeste", () => {
    const manifest = parse(readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8")) as any;
    const declared: string[] = [
      ...manifest.ui.views.map((v: { id: string }) => v.id),
      ...manifest.setup.map((s: { view: string }) => s.view),
    ];
    expect(declared.filter((id) => !isViewId(id))).toEqual([]);
    for (const v of manifest.ui.views) expect(views[v.id as keyof typeof views].icon).toBe(v.icon);
  });
});

describe("labels", () => {
  it("masque les labels conventionnés", () => {
    expect(displayLabels(["type/feat", "status/doing", "estimate/M", "area/api"])).toEqual(["area/api"]);
  });
});

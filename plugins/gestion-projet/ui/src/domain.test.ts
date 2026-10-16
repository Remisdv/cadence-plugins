import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { displayLabels, issueContext, issueKey, isViewId, repoShortName, views } from "./domain";

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

describe("manifeste", () => {
  it("déclare la catégorie projet et le service repos, sans secret GitHub", () => {
    const manifest = parse(readFileSync(new URL("../../plugin.toml", import.meta.url), "utf8")) as any;
    expect(manifest.category).toBe("projet");
    expect(manifest.services).toEqual(["repos"]);
    expect(manifest.secrets).toBeUndefined();
  });
});

describe("dépôts", () => {
  it("identifie une issue par dépôt et numéro", () => {
    const a = { repo: "me/app", number: 4 };
    expect(issueKey(a)).not.toBe(issueKey({ repo: "me/site", number: 4 }));
    expect(issueContext(a)).toEqual({ repo: "me/app", issue: 4 });
    expect(repoShortName("RemiSDV/cadence-plugins")).toBe("cadence-plugins");
  });
});

describe("labels", () => {
  it("masque les labels conventionnés", () => {
    expect(displayLabels(["type/feat", "status/doing", "estimate/M", "area/api"])).toEqual(["area/api"]);
  });
});

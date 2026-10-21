import { describe, expect, it } from "vitest";
import { isFinished, isSyncFor } from "./useLiveRefresh";

describe("rafraîchissement de l'écran Sprint (N09)", () => {
  it("ne retient que les écritures des dépôts affichés", () => {
    const shown = ["Remisdv/linear-test"];
    expect(isSyncFor({ repo: "remisdv/Linear-Test", tool: "merge_pull_request" }, shown)).toBe(
      true,
    );
    expect(isSyncFor({ repo: "me/autre", tool: "update_issue" }, shown)).toBe(false);
    expect(isSyncFor({ tool: "update_issue" }, shown)).toBe(false);
    expect(isSyncFor(null, shown)).toBe(false);
  });

  it("reconnaît la fin d'une exécution de fond", () => {
    expect(isFinished("succeeded")).toBe(true);
    expect(isFinished("failed")).toBe(true);
    expect(isFinished("cancelled")).toBe(true);
    expect(isFinished("running")).toBe(false);
    expect(isFinished("queued")).toBe(false);
  });
});

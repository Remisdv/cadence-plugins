import { describe, expect, it } from "vitest";
import type { RepoInfo } from "@cadence/plugin-sdk";
import { activeSelection } from "./useRepos";

const info = (fullName: string): RepoInfo => {
  const [owner = "", name = ""] = fullName.split("/");
  return { fullName, owner, name };
};

describe("dépôt actif", () => {
  it("garde le dépôt choisi s'il est suivi", () => {
    expect(activeSelection([info("me/a"), info("me/b")], { kind: "one", repo: "me/b" })).toEqual({
      kind: "one",
      repo: "me/b",
    });
  });

  it("remplace « Tous les dépôts » ou un dépôt retiré par le premier suivi", () => {
    const repos = [info("me/a"), info("me/b")];
    expect(activeSelection(repos, { kind: "all" })).toEqual({ kind: "one", repo: "me/a" });
    expect(activeSelection(repos, { kind: "one", repo: "me/x" })).toEqual({ kind: "one", repo: "me/a" });
  });

  it("reste vide sans dépôt suivi", () => {
    expect(activeSelection([], { kind: "all" })).toEqual({ kind: "all" });
  });
});

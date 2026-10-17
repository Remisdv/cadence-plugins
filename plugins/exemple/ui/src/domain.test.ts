import { describe, expect, it } from "vitest";
import { connectMock } from "@cadence/plugin-sdk";
import { pasValide, salutation, toolLine } from "./domain";

describe("écran Exemple", () => {
  it("valide le pas comme le schéma de réglages", () => {
    expect([pasValide(3), pasValide("7"), pasValide(0), pasValide(11), pasValide(2.5), pasValide(undefined)]).toEqual([
      3, 7, 1, 1, 1, 1,
    ]);
  });

  it("salue avec ou sans prénom", () => {
    expect(salutation("Rémi")).toBe("Bonjour Rémi !");
    expect(salutation("  ")).toBe("Bonjour !");
    expect(salutation(undefined)).toBe("Bonjour !");
  });

  it("décrit l'outil externe", () => {
    expect(toolLine(null, null)).toBe("État inconnu");
    expect(toolLine({ installed: false, version: null, authenticated: null }, null)).toContain("Non installé");
    expect(toolLine({ installed: true, version: "2.45.1", authenticated: null }, "/usr/bin/git")).toBe(
      "version 2.45.1 · /usr/bin/git",
    );
  });

  // Les tests d'un écran parlent à un hôte simulé : mêmes messages que Cadence, outils écrits à la main.
  it("appelle un outil, reçoit un événement et change de vue", async () => {
    let valeur = 0;
    const { cadence, host } = connectMock({
      plugin: { id: "exemple", version: "0.1.0" },
      route: { view: "accueil", params: {} },
      tools: { incrementer: () => ({ valeur: ++valeur, pas: 1, prenom: "" }) },
    });
    const events: unknown[] = [];
    cadence.on("compteur", (data) => events.push(data));

    expect(await cadence.call("incrementer")).toEqual({ valeur: 1, pas: 1, prenom: "" });
    host.emit("compteur", { valeur: 1 });
    await cadence.navigate("setup-prenom");
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual([{ valeur: 1 }]);
    expect(cadence.route?.view).toBe("setup-prenom");
    await expect(cadence.call("inconnu")).rejects.toMatchObject({ code: "not_found" });
    cadence.dispose();
  });
});

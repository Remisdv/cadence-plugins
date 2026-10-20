import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosaver, saveLabel, type SaveStatus } from "./autosave";

describe("sauvegarde automatique", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("n'enregistre qu'une fois après la dernière frappe", async () => {
    const saved: string[] = [];
    const auto = createAutosaver(async (v: string) => void saved.push(v), { delay: 500 });
    const statuses: SaveStatus[] = [];
    auto.subscribe((s) => statuses.push(s.status));

    auto.change("a");
    await vi.advanceTimersByTimeAsync(300);
    auto.change("ab");
    await vi.advanceTimersByTimeAsync(300);
    auto.change("abc");
    expect(saved).toEqual([]);
    expect(auto.state.status).toBe("pending");

    await vi.advanceTimersByTimeAsync(500);
    expect(saved).toEqual(["abc"]);
    expect(auto.state.status).toBe("saved");
    expect(statuses.at(-2)).toBe("saving");
    expect(saveLabel(auto.state)).toBe("Enregistré");
  });

  it("enregistre tout de suite au flush, et rien s'il n'y a rien en attente", async () => {
    const save = vi.fn(async () => {});
    const auto = createAutosaver(save, { delay: 1000 });
    await auto.flush();
    expect(save).not.toHaveBeenCalled();
    auto.change("x");
    await auto.flush();
    expect(save).toHaveBeenCalledWith("x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("enchaîne un seul enregistrement à la fois, la dernière valeur gagne", async () => {
    let release: () => void = () => {};
    const saved: string[] = [];
    const auto = createAutosaver(
      (v: string) =>
        new Promise<void>((resolve) => {
          saved.push(v);
          release = resolve;
        }),
      { delay: 100 },
    );
    auto.change("1");
    await vi.advanceTimersByTimeAsync(100);
    expect(auto.state.status).toBe("saving");
    auto.change("12");
    auto.change("123");
    await vi.advanceTimersByTimeAsync(100);
    expect(saved).toEqual(["1"]); // le second attend la fin du premier
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saved).toEqual(["1", "123"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(auto.state.status).toBe("saved");
  });

  it("garde la valeur après un échec et la renvoie au flush suivant", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("disque plein")).mockResolvedValue(undefined);
    const auto = createAutosaver(save, { delay: 100 });
    auto.change("texte");
    await vi.advanceTimersByTimeAsync(100);
    expect(auto.state).toMatchObject({ status: "error", error: "disque plein" });
    expect(saveLabel(auto.state)).toBe("Échec de l'enregistrement");
    await auto.flush();
    expect(save).toHaveBeenLastCalledWith("texte");
    expect(auto.state.status).toBe("saved");
  });

  it("abandonne la valeur en attente à l'annulation", async () => {
    const save = vi.fn(async () => {});
    const auto = createAutosaver(save, { delay: 100 });
    auto.change("brouillon");
    auto.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(save).not.toHaveBeenCalled();
    expect(auto.state.status).toBe("saved");
    expect(saveLabel(auto.state)).toBe("À jour");
  });
});

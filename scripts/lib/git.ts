import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "./manifest";

/** Lance git dans le dépôt ; `null` en cas d'échec. */
export function git(args: string[], cwd = REPO_ROOT): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Contenu d'un fichier à une révision (`git show <ref>:<path>`), ou `null`. */
export function showFile(ref: string, path: string): string | null {
  return git(["show", `${ref}:${path}`]);
}

/** Fichiers suivis sous `path` à une révision (`git ls-tree -r`), ou `null` si la révision est inconnue. */
export function listFiles(ref: string, path: string): string[] | null {
  const out = git(["ls-tree", "-r", "--name-only", ref, "--", path]);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Fichiers modifiés entre la base de fusion de `base` et HEAD. */
export function changedFiles(base: string): string[] | null {
  const out = git(["diff", "--name-only", `${base}...HEAD`]);
  return out === null ? null : out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Tags existants : ceux du dépôt distant `origin` s'il existe, sinon les tags locaux. */
export function existingTags(): Set<string> {
  const remote = git(["ls-remote", "--tags", "origin"]);
  if (remote !== null) {
    return new Set(
      remote
        .split("\n")
        .map((l) => l.split("\t")[1]?.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""))
        .filter((t): t is string => !!t),
    );
  }
  return new Set((git(["tag", "--list"]) ?? "").split("\n").map((t) => t.trim()).filter(Boolean));
}

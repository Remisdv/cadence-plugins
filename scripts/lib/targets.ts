/** Plateformes des serveurs natifs : dossier `bin/<cible>/` de l'archive. */
export interface Target {
  /** Nom de la cible dans l'archive (contrat Cadence). */
  id: "windows-x86_64" | "macos-aarch64" | "macos-x86_64" | "linux-x86_64";
  /** Triplet Rust correspondant. */
  rust: string;
  /** Suffixe de l'exécutable. */
  exe: "" | ".exe";
}

export const TARGETS: readonly Target[] = [
  { id: "windows-x86_64", rust: "x86_64-pc-windows-msvc", exe: ".exe" },
  { id: "macos-aarch64", rust: "aarch64-apple-darwin", exe: "" },
  { id: "macos-x86_64", rust: "x86_64-apple-darwin", exe: "" },
  { id: "linux-x86_64", rust: "x86_64-unknown-linux-gnu", exe: "" },
];

export function binaryName(bin: string, target: Target): string {
  return `${bin}${target.exe}`;
}

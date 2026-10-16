/** Semver minimal : comparaison de versions `X.Y.Z[-pre]` (le `+build` est ignoré). */
export const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isSemver(value: string): boolean {
  return SEMVER_RE.test(value);
}

/** < 0 si a < b, 0 si égales, > 0 si a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`Version semver invalide : ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  const [preA, preB] = [pa[4], pb[4]];
  if (preA === preB) return 0;
  if (preA === undefined) return 1; // 1.0.0 > 1.0.0-rc.1
  if (preB === undefined) return -1;
  const xa = preA.split(".");
  const xb = preB.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const [ia, ib] = [xa[i], xb[i]];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const [na, nb] = [/^\d+$/.test(ia), /^\d+$/.test(ib)];
    if (na && nb && Number(ia) !== Number(ib)) return Number(ia) - Number(ib);
    if (na !== nb) return na ? -1 : 1;
    if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

/** Version minimale d'un outil externe, semver souple : `2`, `2.30` ou `2.30.1`. */
export const LOOSE_VERSION_RE = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,2}$/;

/** Compare deux versions souples (composantes absentes = 0) : `2.30` = `2.30.0` < `2.31`. */
export function compareLooseVersion(a: string, b: string): number {
  if (!LOOSE_VERSION_RE.test(a) || !LOOSE_VERSION_RE.test(b)) {
    throw new Error(`Version invalide : ${LOOSE_VERSION_RE.test(a) ? b : a}`);
  }
  const [pa, pb] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

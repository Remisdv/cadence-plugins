# Contribuer

Merci de proposer un plugin ou une amélioration. Cadence fait **entièrement confiance** aux
plugins installés (pas de système de permissions) : le seul filtre est la revue des pull requests
de ce dépôt. Chaque PR est relue et validée par le mainteneur, **@RemiSDV** (voir `CODEOWNERS`),
avant la fusion sur `main` qui déclenche la publication.

## Proposer un plugin

1. Forkez le dépôt et créez une branche.
2. Ajoutez un dossier `plugins/<id>/` (`id` : minuscules, chiffres et tirets, unique dans le
   catalogue) avec au minimum :
   - `plugin.toml` — manifeste API 1, décrit par `schema/plugin.schema.json` ;
   - `README.md` — ce que fait le plugin, ses réglages, ses outils ;
   - selon les besoins : `icon.svg`, `ui/` (écrans), `skills/<skill>/SKILL.md`, `server/`
     (sources du serveur MCP), un schéma de réglages.
3. Vérifiez en local :
   ```sh
   pnpm install
   pnpm validate <id>
   pnpm typecheck && pnpm test && pnpm build
   cargo test --workspace          # si le plugin a un serveur Rust
   ```
4. Ouvrez une pull request en remplissant le modèle. La CI valide le manifeste, construit les UI
   et compile les serveurs.

Les mêmes règles valent pour modifier un plugin existant, officiel ou non.

## Règles

- **Manifeste valide** : `pnpm validate` passe. Il vérifie le schéma, que l'`id` est celui du
  dossier, que chaque skill d'une action existe (`skills/<skill>/SKILL.md` avec un frontmatter
  `name` égal au dossier et une `description`), que chaque vue et étape de setup est gérée par
  `ui/src`, que les icônes existent dans le kit (`@cadence/ui/icons`) et que le schéma de
  réglages reste dans le sous-ensemble rendu par Cadence.
- **Version incrémentée** : toute modification d'un plugin déjà publié monte sa `version`
  (semver) dans `plugin.toml`. La CI compare avec la branche cible et refuse sinon. C'est cette
  nouvelle version qui déclenche la release `<id>-v<version>` après fusion.
- **Pas de binaire commité** : ni `bin/`, ni `.exe`, `.dll`, `.so`, `.dylib`… Les serveurs sont
  construits par la CI à partir des sources de `server/`, sur `windows-x86_64`, `macos-aarch64`,
  `macos-x86_64` et `linux-x86_64`. La CI sait aujourd'hui construire les serveurs **Rust**
  (`server/Cargo.toml`, membre du workspace Cargo du dépôt, dont un binaire porte le nom de
  `server.bin`) ; pour un autre langage, ouvrez d'abord une issue.
- **Licence** : le code proposé est publié sous la licence MIT du dépôt, sauf si le dossier du
  plugin contient son propre fichier `LICENSE` (licence libre compatible). Pas de code dont vous
  n'avez pas les droits.
- **Pas d'appel réseau caché** : un plugin ne parle qu'aux services qu'il annonce dans son README,
  et ne lit ni n'exfiltre de données hors de l'espace de travail sans le dire.
- **Secrets** : déclarés dans `[[secrets]]`, rangés par Cadence dans le trousseau de l'OS et
  passés au serveur en `CADENCE_SECRET_<ID>`. L'UI ne peut que les écrire (`cadence.secrets.set`) ;
  ne les journalisez jamais.
- **Texte d'interface et skills en français** pour les plugins officiels ; les plugins tiers
  choisissent leur langue mais restent cohérents.
- Les écrans utilisent de préférence le kit `@cadence/ui` (tokens et composants) et le SDK
  `@cadence/plugin-sdk`.

## Revue

@RemiSDV relit le manifeste, les skills (ce qu'ils demandent à l'IA de faire), le serveur et les
dépendances ajoutées. Il peut demander des changements ou refuser un plugin qui ne respecte pas
ces règles. Une fois la PR fusionnée, la CI publie la release et met à jour le catalogue ; le
plugin apparaît dans Cadence au prochain rafraîchissement du catalogue.

## Paquets partagés

`packages/sdk` et `packages/ui` suivent les mêmes règles de revue. Un changement incompatible
du protocole du SDK implique une nouvelle version d'API (`api = 2`) coordonnée avec Cadence.

# Exemple

**Le plugin modèle : un compteur, un prénom à régler et une action « Saluer ». Il utilise une fois
chaque brique de l'API des plugins Cadence. Copiez-le pour écrire le vôtre.**

<img src="../../docs/captures/exemple.png" alt="Le plugin Exemple dans Cadence" width="840">

Plugin officiel, groupe **Outils** du rail. Version 0.1.0. Il ne sert à rien au quotidien : il
montre comment un plugin s'intègre à Cadence.

## Ce qu'il montre

Chaque carte de l'écran correspond à une brique du SDK :

| Carte                             | Brique                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Outil du serveur et événement** | « Incrémenter » appelle un outil du serveur (`cadence.call`) ; le compteur suit l'événement envoyé par le serveur (`cadence.on`)      |
| **Réglages**                      | réglages globaux du plugin (prénom, pas du compteur) et étape de configuration « Modifier le prénom »                                 |
| **Skill**                         | « Saluer dans le chat » lance une action liée à un skill (`cadence.runAction`) : l'IA appelle `exemple__incrementer`, puis vous salue |
| **Outil externe : git**           | dépendance externe optionnelle (`cadence.tools`) : Cadence détecte git et en affiche la version                                       |

## Un cas réel : écrire son propre plugin

Imaginons que vous vouliez un plugin **Journal de bord** : une entrée par jour, que l'IA résume
en fin de semaine.

1. **Copier le modèle.** Copiez `plugins/exemple` en `plugins/journal/`, puis remplacez `exemple`
   par `journal` dans `plugin.toml`, `server/Cargo.toml`, `ui/package.json`, les skills et les noms
   d'outils (`journal__…`).
2. **Décrire le plugin.** Dans `plugin.toml`, choisissez la catégorie (`outils`), les vues
   (« Entrées », « Calendrier ») et les actions (« Résumer la semaine », liée à un skill).
3. **Écrire le serveur.** Le compteur de `server/src/server.rs` devient un outil `ajouter_entree`
   qui écrit un fichier dans `CADENCE_DATA_DIR`, plus un outil `lister_entrees` que l'IA utilise
   pour résumer.
4. **Écrire l'écran.** `ui/src/views/` passe d'une carte par brique à vos propres écrans, avec le
   SDK (`@cadence/plugin-sdk`) et le kit UI (`@cadence/ui`) : l'apparence de Cadence vient d'office.
5. **Essayer sans Cadence.** `pnpm --dir plugins/journal/ui dev` ouvre l'écran dans un navigateur,
   avec un hôte simulé (`ui/src/dev.ts`) : pas besoin de recompiler l'app.
6. **Valider et publier.** `pnpm validate journal`, les tests, puis une pull request vers ce dépôt
   (voir [CONTRIBUTING.md](../../CONTRIBUTING.md)). Une fois fusionné, le plugin apparaît dans le
   catalogue de Cadence.

## Essayer

```sh
pnpm install
pnpm --dir plugins/exemple/ui dev            # écran hors de Cadence, hôte simulé
cargo test -p cadence-exemple                # serveur, dont une session MCP complète
pnpm validate exemple                        # manifeste, vues, skill, réglages, dépendances
```

Dans Cadence, le plugin s'installe depuis le catalogue (icône en grille en bas du rail).

## Données et réseau

Un seul fichier, `compteur.json`, dans le dossier de données du plugin. Aucun accès réseau. git
n'est jamais lancé : Cadence affiche seulement son chemin et sa version.

## Pour aller plus loin

- [Visite commentée du plugin](TECHNIQUE.md) : manifeste, serveur MCP, écran, skill, fichier par
  fichier.
- [Documentation technique](../../docs/technique.md) : écrire, développer et publier un plugin.

# Exemple

> **Mode d'emploi** : [guide d'utilisation](../../docs/utilisation.md#4-exemple). Ce README est la
> référence technique du plugin (écrans, actions, outils, données).

Plugin de **référence pour les auteurs** de plugins Cadence (catégorie **Outils**). Il ne fait
presque rien — un compteur — mais utilise une fois chaque brique de l'API 1 : manifeste complet,
serveur MCP en Rust, écran React avec le SDK et le kit UI, réglages, étape de configuration,
action liée à un skill, dépendance externe optionnelle. Copiez ce dossier pour démarrer le vôtre.

```
plugins/exemple/
├── plugin.toml              manifeste : toutes les sections, commentées
├── settings.schema.json     réglages globaux (prénom, pas du compteur)
├── icon.svg                 icône du catalogue
├── skills/saluer/SKILL.md   skill lancé par l'action « Saluer »
├── server/                  serveur MCP (crate Rust cadence-exemple)
│   └── src/main.rs          environnement donné par Cadence, lancement sur stdio
│   └── src/server.rs        outils, événements, notifications, tests de bout en bout
└── ui/                      écran (Vite + React + @cadence/plugin-sdk + @cadence/ui)
    └── src/App.tsx          routeur : vue « accueil », étape « setup-prenom »
    └── src/views/           un écran par route
    └── src/dev.ts           hôte simulé pour `pnpm dev`
```

## Essayer

```sh
pnpm install
pnpm --dir plugins/exemple/ui dev            # écran hors de Cadence, hôte simulé
cargo test -p cadence-exemple                # serveur, dont une session MCP complète
pnpm validate exemple                        # manifeste, vues, skill, réglages, dépendances
pnpm --dir plugins/exemple/ui build
pnpm package exemple --allow-missing-targets # archive locale out/exemple-0.1.0.zip
```

Dans Cadence, le plugin s'installe depuis le catalogue (icône en grille en bas du rail). Cadence sait aussi
inscrire un dossier local non zippé comme plugin de développement : le contenu d'une archive
assemblée par `pnpm package` (avec le binaire du serveur pour votre machine dans `--bins`).

## 1. Le manifeste (`plugin.toml`)

| Section | Ici | À retenir |
| --- | --- | --- |
| `id`, `name`, `version`, `description`, `authors`, `min_cadence` | `exemple`, 0.1.0 | `id` = nom du dossier ; toute modification publiée monte `version` |
| `category` | `outils` | groupe du rail : `projet`, `etudes`, `code`, `donnees`, `outils` |
| `color` | `purple` | couleur de la tuile (facultative) : `clay`, `blue`, `green`, `purple`, `amber`, `red` |
| `[[requires]]` | `git`, optionnel | outil externe que Cadence détecte, installe et connecte sur un clic ; `reason` est affichée |
| `[server]` | `bin = "cadence-exemple"` | binaire construit par la CI pour 4 plateformes, rangé en `bin/<cible>/` |
| `[ui]`, `[[ui.views]]` | vue `accueil` | `ui/index.html` dans un iframe isolé ; une vue = une entrée de la barre du plugin |
| `ui.dev_url` | `http://localhost:5181` | plugin installé en mode développement : Cadence charge ce serveur de dev (rechargement à chaud) ; il doit accepter toutes les origines (`server.cors: true`) |
| `[[setup]]` | `setup-prenom` | étape montrée à l'onboarding : une route de l'écran, pas forcément une vue de la barre |
| `[settings]` | `settings.schema.json` | sous-ensemble de JSON Schema (string, number, integer, boolean, enum ; `title` obligatoire) |
| `[[actions]]` | `saluer`, mode `chat` | bouton qui lance un skill ; `background` le fait tourner en fond |

`pnpm validate` vérifie tout ce que le schéma ne voit pas : chaque vue et chaque étape est gérée
par `ui/src` (l'identifiant y apparaît entre guillemets), chaque action a son skill, chaque outil
cité par un skill existe dans le serveur, les icônes viennent du kit, les outils externes lus dans
`CADENCE_TOOLS` sont déclarés.

## 2. Le serveur MCP (`server/`)

Cadence lance **un seul processus** pour le plugin et lui parle MCP sur stdin/stdout. Le journal
va sur **stderr** (stdout est réservé au protocole). Environnement reçu (`main.rs`) :

| Variable | Usage ici |
| --- | --- |
| `CADENCE_API` | `1` : avertir si Cadence annonce une autre version |
| `CADENCE_DATA_DIR` | `compteur.json` y est rangé ; c'est le seul dossier où écrire |
| `CADENCE_SETTINGS` | réglages globaux en JSON (`{ "prenom": "…", "pas": 1 }`) |
| `CADENCE_TOOLS` | `{ "git": "/usr/bin/git" }` : chemin des outils détectés ; ne jamais lancer `git` par son nom |

Outils (`server.rs`, macros `#[tool]` de [rmcp](https://crates.io/crates/rmcp)) :

| Outil | Visibilité | Rôle |
| --- | --- | --- |
| `incrementer` | **toutes** : IA (`exemple__incrementer`) et écran | ajoute le pas au compteur, renvoie `{ valeur, pas, prenom }`, émet `compteur` |
| `etat` | **écran seulement** : `meta = ui_only()`, soit `_meta["cadence/visibility"] = "ui"` | compteur, réglages, chemin de git, version du serveur |

Messages hors outils :

- **Cadence → serveur** : `notifications/cadence/settings` (`{ "settings": {…} }`) quand
  l'utilisateur change un réglage ; le serveur les applique sans redémarrer.
- **Serveur → écrans** : `notifications/cadence/event` avec `{ "event": "compteur", "data": {
  "valeur": 3 } }`. Le pair MCP (`Peer<RoleServer>`) est un paramètre de l'outil, injecté par
  rmcp. Cadence relaie l'événement aux écrans ouverts du plugin ; l'écran le reçoit avec
  `cadence.on("compteur", …)`, que l'incrément vienne de lui ou d'une IA dans le chat.

Le résultat d'un outil est un objet structuré (`structuredContent`), ou une erreur d'outil
(`isError`) avec un message lisible : l'IA le lit, l'écran reçoit une `CadenceError` `tool_error`.

Le test `speaks_mcp_like_cadence` ouvre une vraie session MCP en mémoire et écrit les messages
JSON-RPC que Cadence envoie (`initialize`, `tools/list`, notification de réglages, `tools/call`) :
c'est la meilleure documentation du protocole vu du serveur.

## 3. L'écran (`ui/`)

Vite + React, le SDK [`@cadence/plugin-sdk`](../../packages/sdk) et le kit
[`@cadence/ui`](../../packages/ui) (tokens et composants de Cadence : l'écran suit le thème de
l'app). Construit en `ui/dist`, avec des chemins relatifs (`base: "./"`).

| Fichier | SDK utilisé |
| --- | --- |
| `App.tsx` | `cadence.ready()` (poignée de main, vue initiale), `cadence.onRoute` |
| `views/AccueilView.tsx` | `cadence.call("incrementer")`, `cadence.call("etat")`, `cadence.on("compteur")`, `cadence.settings.get/set`, `cadence.navigate("setup-prenom")`, `cadence.runAction("saluer")`, `cadence.tools.status/ensure("git")` |
| `views/SetupPrenomView.tsx` | `cadence.settings.get/set`, `cadence.navigate("accueil")` |
| `dev.ts`, `main.tsx` | `connectMock` : hôte simulé quand l'écran n'est pas dans un iframe |
| `domain.test.ts` | tests sans navigateur : règles de l'écran et échanges avec l'hôte simulé |

L'écran ne voit jamais de secret ni de jeton, et ne fait aucun appel réseau : il passe par les
outils de son serveur.

## 4. Le skill (`skills/saluer/SKILL.md`)

Format « Agent Skills » : frontmatter `name` (égal au dossier) et `description` (quand
l'utiliser), puis les instructions en français. Il cite les outils sous leur nom exposé
(`exemple__incrementer`). L'action `saluer` du manifeste le lance dans le chat.

## Partir de ce plugin

1. Copiez `plugins/exemple` en `plugins/<votre-id>/` ; remplacez `exemple` par votre `id` dans
   `plugin.toml`, `server/Cargo.toml` (`name`, et `[server] bin`), `ui/package.json`, les skills et
   les noms d'outils cités (`<votre-id>__…`).
2. Choisissez la `category`, déclarez les `services` de Cadence (`repos` pour des dépôts GitHub)
   et les outils externes (`[[requires]]`) dont vous avez besoin, retirez ce qui ne sert pas.
3. `pnpm install`, puis `pnpm validate <votre-id>`, `pnpm typecheck && pnpm test && pnpm build`,
   `cargo test --workspace`.
4. Ouvrez une pull request (voir [CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Données et réseau

Un seul fichier, `compteur.json`, dans `CADENCE_DATA_DIR`. Aucun accès réseau. git n'est jamais
lancé : son chemin est seulement affiché.

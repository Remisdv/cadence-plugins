# @cadence/plugin-sdk

SDK des écrans de plugin Cadence. L'UI d'un plugin tourne dans une iframe isolée ; elle parle à
Cadence par `postMessage` (API 1). Le SDK gère les identifiants de requête, les délais, les
erreurs typées, les événements et la négociation de version.

```ts
import { cadence } from "@cadence/plugin-sdk";

await cadence.ready(); // poignée de main : plugin, thème, route

const { issues } = await cadence.call<{ issues: Issue[] }>("list_issues", { state: "open" });

const runId = await cadence.runAction("implementer-issue", { repo: "me/app", issue: 42 });
cadence.onRun(runId, (u) => console.log(u.status, u.message));

cadence.on("issues-changed", (data) => refetch());
await cadence.secrets.set("api_key", key); // écriture seule
const settings = await cadence.settings.get();
await cadence.navigate("issues", { number: "42" });
await cadence.notify("Issue créée", "success");
const files = await cadence.pickFiles({ multiple: true, filters: [{ name: "Cours", extensions: ["pdf"] }] });
```

| API | Rôle |
| --- | --- |
| `call(tool, args)` | outil MCP du serveur du plugin (nom sans préfixe) ; renvoie `structuredContent`, sinon le texte |
| `runAction(id, context)` | déclenche un bouton du manifeste (`[[actions]]`) ; renvoie un `runId` |
| `onRun(runId, listener)` | progression / résultat d'une exécution de fond |
| `on(event, listener)` | notifications du backend (`notifications/cadence/event`), `"*"` pour toutes |
| `secrets.set / has` | secrets déclarés dans `[[secrets]]`, jamais relus par l'UI |
| `settings.get / set` | réglages globaux du plugin (`[settings]`) |
| `repos.*` | service `repos` de Cadence (voir plus bas) |
| `navigate(view, params?)`, `notify(message, kind?)` | navigation et notifications de Cadence |
| `openExternal(url)`, `pickFiles(options)` | navigateur par défaut, sélecteur de fichiers natif |
| `theme`, `onTheme` | variables CSS injectées (`--color-*`, `--text-*`…) |
| `route`, `onRoute` | vue affichée (`[[ui.views]]` ou étape de `[[setup]]`) |

Il n'y a pas d'espace de travail : un plugin est global, ses réglages aussi, et il gère son propre
contexte. `workspace()` a disparu en 0.2.

## Service `repos`

Disponible quand le manifeste déclare `services = ["repos"]` (sinon les appels rejettent en
`denied`). Cadence gère la connexion GitHub, la liste des dépôts suivis par le plugin et le
sélecteur en tête de sa barre.

```ts
const repos = await cadence.repos.list(); // [{ fullName: "me/app", owner, name, defaultBranch, … }]
const selection = await cadence.repos.selection(); // { kind: "one", repo: "me/app" } | { kind: "all" }
cadence.repos.onChange(({ repos, selection }) => refetch(selection));
await cadence.repos.follow("me/site"); // liste à jour
await cadence.repos.unfollow("me/site");
const path = await cadence.repos.checkout("me/app", { task: "issue-42" }); // worktree de la tâche
```

| API | Rôle |
| --- | --- |
| `repos.list()` | dépôts suivis (`RepoInfo[]`) |
| `repos.selection()` | sélection courante : un dépôt (`owner/name`) ou « Tous les dépôts » |
| `repos.onChange(listener)` | changement de la liste ou de la sélection (`{ repos, selection }`) |
| `repos.follow(fullName)` / `unfollow(fullName)` | ajoute / retire un dépôt suivi ; `invalid_params` si ce n'est pas `owner/name` |
| `repos.checkout(repo, { task })` | clone au besoin sous `<données de l'app>/repos/<owner>/<name>/` et prépare un worktree pour la tâche ; renvoie son chemin |

Côté IA, `checkout` est l'outil du cœur `cadence__repo_checkout` : l'IA reste lancée dans un dossier
neutre et Cadence ne lui ouvre que ce worktree, pour la session. Le serveur du plugin reçoit
`CADENCE_GITHUB_TOKEN` et `CADENCE_REPOS`, puis `notifications/cadence/repos`.

## Erreurs

Toutes les promesses rejettent avec une `CadenceError` dont le `code` vaut `not_connected`,
`unsupported_api`, `timeout`, `cancelled`, `tool_error`, `invalid_params`, `not_found`,
`denied` ou `internal`.

```ts
try {
  await cadence.call("create_issue", { title });
} catch (e) {
  if (isCadenceError(e, "tool_error")) cadence.notify(e.message, "error");
}
```

## Développer hors de Cadence

Ouvert dans un navigateur (pas d'iframe), l'écran peut parler à un hôte simulé :

```ts
import { connect, setCadence } from "@cadence/plugin-sdk";

setCadence(
  connect({
    dev: {
      route: { view: "issues", params: {} },
      tools: { list_issues: () => ({ issues: [{ number: 1, title: "Exemple" }] }) },
      repos: { repos: ["me/app", "me/site"] }, // service repos simulé
    },
  }),
);
```

`connectMock` et `createMockHost` servent aussi dans les tests.

## Protocole

Messages `{ channel: "cadence", api: 1, kind, … }` :

- `request` (plugin → Cadence) : `{ id, method, params }`, méthodes `hello`, `tool.call`,
  `action.run`, `secrets.set`, `secrets.has`, `settings.get`, `settings.set`, `repos.list`,
  `repos.selection`, `repos.follow`, `repos.unfollow`, `repos.checkout`, `navigate`, `notify`,
  `openExternal`, `pickFiles` ;
- `response` (Cadence → plugin) : `{ id, ok: true, result }` ou `{ id, ok: false, error: { code, message, data? } }` ;
- `event` (Cadence → plugin) : `{ topic, data }`, sujets `event`, `run`, `theme`, `route`, `repos`.

Les types sont dans `src/protocol.ts`.

# @cadence/plugin-sdk

SDK des écrans de plugin Cadence. L'UI d'un plugin tourne dans une iframe isolée ; elle parle à
Cadence par `postMessage` (API 1). Le SDK gère les identifiants de requête, les délais, les
erreurs typées, les événements et la négociation de version.

```ts
import { cadence } from "@cadence/plugin-sdk";

await cadence.ready(); // poignée de main : plugin, espace, thème, route

const { issues } = await cadence.call<{ issues: Issue[] }>("list_issues", { state: "open" });

const runId = await cadence.runAction("implementer-issue", { issue: 42 });
cadence.onRun(runId, (u) => console.log(u.status, u.message));

cadence.on("issues-changed", (data) => refetch());
await cadence.secrets.set("github_token", token); // écriture seule
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
| `settings.get / set` | réglages du plugin pour l'espace (`[settings]`) |
| `workspace()` | `{ name, path, ai }` |
| `navigate(view, params?)`, `notify(message, kind?)` | navigation et notifications de Cadence |
| `openExternal(url)`, `pickFiles(options)` | navigateur par défaut, sélecteur de fichiers natif |
| `theme`, `onTheme` | variables CSS injectées (`--color-*`, `--text-*`…) |
| `route`, `onRoute` | vue affichée (`[[ui.views]]` ou étape de `[[setup]]`) |

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
    },
  }),
);
```

`connectMock` et `createMockHost` servent aussi dans les tests.

## Protocole

Messages `{ channel: "cadence", api: 1, kind, … }` :

- `request` (plugin → Cadence) : `{ id, method, params }`, méthodes `hello`, `tool.call`,
  `action.run`, `secrets.set`, `secrets.has`, `settings.get`, `settings.set`, `workspace.get`,
  `navigate`, `notify`, `openExternal`, `pickFiles` ;
- `response` (Cadence → plugin) : `{ id, ok: true, result }` ou `{ id, ok: false, error: { code, message, data? } }` ;
- `event` (Cadence → plugin) : `{ topic, data }`, sujets `event`, `run`, `theme`, `route`.

Les types sont dans `src/protocol.ts`.

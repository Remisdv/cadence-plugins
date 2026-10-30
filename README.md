# Plugins Cadence

**Les fonctionnalités de [Cadence](https://github.com/RemiSDV/cadence), à installer selon vos besoins.**

Cadence est une application de bureau qui pilote vos IA de code (Claude Code, Codex CLI, OpenCode).
Les **plugins** lui apportent ses fonctionnalités : chaque plugin ajoute ses écrans dans l'app, des
boutons d'action qui lancent l'IA sur une tâche précise, et des outils que l'IA sait utiliser dans
le chat. Ce dépôt est le **catalogue public** des plugins : Cadence y lit la liste de ceux que vous
pouvez installer.

<img src="docs/captures/catalogue.png" alt="Le catalogue de plugins dans Cadence" width="840">

## Les plugins officiels

### Gestion de projet

Pilotez vos dépôts GitHub de bout en bout : issues rangées par catégorie, sprints automatiques,
roadmap par jalons, planning, versions et pull requests. Un clic suffit pour que l'IA complète une
issue, l'implémente, développe tout le sprint, relise les pull requests ou prépare la release.
**[Voir le plugin sur un projet complet →](plugins/gestion-projet/README.md)**

| Sprint en cours                                                                       | Issues                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| <img src="docs/captures/gestion-projet-sprint.png" alt="Sprint en cours" width="420"> | <img src="docs/captures/gestion-projet-issues.png" alt="Issues" width="420"> |

### Documents

Rangez vos cours (PDF, Word, PowerPoint, Markdown) par matière et chapitre, prenez vos notes dans
un éditeur par blocs, posez vos questions à l'IA (elle cite le document et la page) et révisez avec
des QCM, des questions ouvertes corrigées et des flashcards.

Captures bientôt. **[Page du plugin →](plugins/documents/README.md)**

### Exemple

Un plugin minimal (un compteur) qui montre chaque brique disponible : c'est le point de départ
pour écrire le vôtre. **[Page du plugin →](plugins/exemple/README.md)**

## Installer un plugin

Dans Cadence, ouvrez le **catalogue** (icône en grille en bas du rail), choisissez un plugin et
cliquez sur **Installer**. Il apparaît aussitôt dans le rail ; suivez ses éventuelles étapes de
configuration (connexion GitHub pour Gestion de projet, par exemple).

## Documentation

- **[Guide d'utilisation](docs/utilisation.md)** : installer, configurer et utiliser chaque plugin.
- **[Documentation technique](docs/technique.md)** : écrire un plugin (manifeste, serveur, écrans,
  services de Cadence), développer et publier.
- **[Proposer un plugin](CONTRIBUTING.md)** au catalogue.

## Licence

[MIT](LICENSE), sauf mention contraire dans le dossier d'un plugin.

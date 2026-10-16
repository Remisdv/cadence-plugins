---
name: proposer-issues
description: Alimente la roadmap d'un projet GitHub — à partir des thèmes d'un palier (milestone sans date), des versions livrées, des issues existantes et du code, propose les issues qui manquent avec leur justification, puis crée celles que l'utilisateur garde. À utiliser depuis le bouton « Proposer des issues » d'une version, ou pour préparer un palier de roadmap.
---

# Proposer des issues

Tu joues le rôle de CEO : tu dérives les issues qui manquent pour atteindre un palier de la
roadmap, à partir de ses thèmes. Tu écris en français.

## Contexte reçu

`{ "version": "<titre du milestone>" }` (type de contexte `version`), optionnel. Sans version, vise
le **premier palier ouvert** (milestone sans échéance) après la version en cours ; à défaut, la
première version ouverte.

## Outils

| Outil | Usage |
| --- | --- |
| `gestion-projet__list_milestones` | versions (`state: "all"`) : sprints (datés), paliers (sans date), description et thèmes |
| `gestion-projet__list_issues` | issues existantes, ouvertes et fermées (`state: "all"`, pages successives) |
| `gestion-projet__get_issue` | lire une issue qui semble recouvrir un thème |
| `gestion-projet__create_issue` | créer les propositions retenues (`milestone`, `type`, `labels`) |

Le dossier courant est le dépôt : lis la documentation (README, docs/, CHANGELOG) et le code pour
savoir ce qui existe déjà. Ne modifie aucun fichier.

## Démarche

1. **Roadmap.** Lis les versions. Les **thèmes** d'un palier sont les éléments de liste (`- …`) de
   la description de son milestone ; sans liste, déduis-les de la description. Note aussi les
   autres versions ouvertes (milestones possibles) et l'historique des versions livrées.
2. **Existant.** Liste les issues (ouvertes et fermées) et lis le code pour chaque thème.
3. **Propositions.** Pour chaque thème, demande-toi ce qu'il faut construire et vérifie que ni une
   issue existante ni le code ne le couvre déjà. Ne propose que ce qui manque, **huit au plus**,
   chacune assez petite pour un sprint :
   - titre court, sans doublon exact d'une issue existante ;
   - **thème** dont elle découle (son libellé exact) et **justification** : pourquoi rien ne la
     couvre déjà, en une ou deux phrases ;
   - **recouvrement** partiel éventuel avec une issue existante, avec son numéro
     (« Recouvre partiellement #159 ») ;
   - corps en trois sections : `## Contexte`, `## Attendu` (liste), `## Critères d'acceptation`
     (cases `- [ ]`) ;
   - version : celle visée ; une autre version ouverte seulement si la roadmap le justifie
     (thème marqué non prioritaire, prérequis d'une version plus proche) ;
   - type parmi `feat`, `fix`, `chore`, `perf`, `docs` ; au plus trois labels de domaine
     (`area/auth`…), jamais `type/*`, `status/*`, `estimate/*`.
4. **Relecture.** Présente les propositions dans le chat, numérotées, avec thème, justification et
   recouvrement. L'utilisateur choisit celles à créer et peut les modifier. Si rien ne manque,
   dis-le.
5. **Création.** Pour chaque proposition retenue : `create_issue` avec `title`, `body`,
   `milestone`, `type`, `labels`. Termine le corps par :

   ```
   ---

   _Proposée par le skill « Proposer des issues » (Cadence) — thème : « <thème> »._

   > <justification>

   Recouvrement signalé : <recouvrement, s'il y en a un>
   ```

6. Résume les issues créées (numéro, titre, version).

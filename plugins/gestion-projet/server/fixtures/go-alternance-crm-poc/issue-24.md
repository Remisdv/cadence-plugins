<!-- cadence:sprints -->
Cette issue est gérée par le plugin **Gestion de projet** de Cadence : elle garde, pour toute l'équipe, l'état des sprints automatiques de ce dépôt. Elle est masquée dans l'écran Issues. Ne la fermez pas et ne modifiez pas le bloc JSON à la main : utilisez l'écran « Sprint en cours » de Cadence (démarrer, mettre en pause, changer la durée) et l'écran « Roadmap » (jalons).

- Sprints : pas encore démarrés
- Durée d'un sprint : 7 jours
- Sprint en cours : aucun
- Jalons : V1 — CRM écoles (20 issues), V2 — Automatisation commerciale (3 issues)
- Designs : 0

```json
{
  "status": "idle",
  "duration_days": 7,
  "initial_points_per_day": 1.4285715,
  "sprints": [],
  "jalons": [
    {
      "id": "v1-crm-ecoles",
      "name": "V1 — CRM écoles",
      "description": "Donner à l'équipe un CRM opérationnel pour acquérir des écoles clientes : fiches écoles et contacts, pipeline kanban à étapes configurables, timeline et relances, alimenté par l'annuaire officiel, le formulaire de la landing et un booking intégré branché sur Google Agenda, avec emails synchronisés et conformité RGPD. Hébergé sur son propre VPS, sans liaison avec la plateforme Go-Alternance.",
      "issues": [
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        12,
        13,
        14,
        15,
        16,
        17,
        18,
        19,
        20
      ]
    },
    {
      "id": "v2-automatisation-commerciale",
      "name": "V2 — Automatisation commerciale",
      "description": "Prolonger le CRM une fois la V1 en service : séquences de relance automatiques, reporting commercial, devis et contrats. Périmètre encore à préciser — le document ne fait que les annoncer.",
      "issues": [
        21,
        22,
        23
      ]
    }
  ]
}
```

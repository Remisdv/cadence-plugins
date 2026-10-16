# @cadence/ui

Kit UI de Cadence pour les écrans des plugins : les tokens (couleurs, tailles de texte, rayons,
ombres) et les composants React de l'app, rendus autonomes.

## Styles

Avec Tailwind v4 (conseillé) :

```css
/* src/index.css du plugin */
@import "@cadence/ui/globals.css"; /* Tailwind + polices + tokens + styles de base */
```

ou, si le plugin importe déjà Tailwind :

```css
@import "tailwindcss";
@import "@cadence/ui/theme.css";
```

Chaque token devient un utilitaire : `bg-panel`, `text-tx2`, `border-line`, `text-caption`,
`rounded-card`… Sans Tailwind, `@cadence/ui/tokens.css` donne les mêmes valeurs en variables
CSS (`var(--color-panel)`).

Dans Cadence, l'hôte injecte aussi ces variables dans l'iframe (`cadence.theme` du SDK).

## Composants

```tsx
import { Badge, Button, Card, Icon } from "@cadence/ui";

<Card className="p-4">
  <Badge tone="green" dot>Terminée</Badge>
  <Button variant="primary" icon="plus">Nouvelle issue</Button>
  <Icon name="sprint" size={16} />
</Card>;
```

Composants : `Avatar`, `Badge`, `Button`, `Callout`, `Card`, `Dialog`, `Field` (`Input`,
`Select`, `Textarea`, `Label`), `Kbd`, `KeyValue`, `Menu`, `ProgressBar`, `RadioCard`,
`SectionLabel`, `Spinner`, `StatusDot`, `Switch`, et `Icon` (34 icônes des maquettes,
grille 24×24, trait 1.7). `ICON_NAMES` (`@cadence/ui/icons`) liste les noms valides pour le
champ `icon` des vues d'un manifeste.

Règle du kit : pas de couleur en dur dans un composant, uniquement les tokens.

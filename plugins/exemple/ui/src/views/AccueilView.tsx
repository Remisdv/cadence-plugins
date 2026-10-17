/**
 * Vue « Accueil » : un tour du SDK, une carte par usage.
 *
 * - `cadence.call(outil, args)` : outil MCP du serveur du plugin (nom sans préfixe) ;
 * - `cadence.on(événement, …)` : notifications `notifications/cadence/event` du serveur ;
 * - `cadence.settings.get / set` : réglages globaux du plugin ;
 * - `cadence.navigate(vue)` : change de vue (ici, l'étape de configuration) ;
 * - `cadence.runAction(id)` : bouton lié à un skill (`[[actions]]`) ;
 * - `cadence.tools.status / ensure` : outil externe déclaré dans `[[requires]]`.
 */
import { useCallback, useEffect, useState } from "react";
import { cadence, isCadenceError, type ExternalToolStatus } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, CardHeader, Icon, KeyValue, Select, Spinner } from "@cadence/ui";
import {
  PAS,
  pasValide,
  salutation,
  toolLine,
  VIEWS,
  type CompteurEvent,
  type Etat,
  type ExempleSettings,
  type Increment,
} from "../domain";

export function AccueilView() {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [settings, setSettings] = useState<ExempleSettings | null>(null);
  const [git, setGit] = useState<ExternalToolStatus | null>(null);
  const [lastEvent, setLastEvent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setError(isCadenceError(e) ? `${e.code} : ${e.message}` : String(e));

  const load = useCallback(async () => {
    try {
      // `etat` est réservé à l'écran (`_meta["cadence/visibility"] = "ui"`) : les IA ne le voient pas.
      const [e, s, g] = await Promise.all([
        cadence.call<Etat>("etat"),
        cadence.settings.get<ExempleSettings>(),
        cadence.tools.status("git"),
      ]);
      setEtat(e);
      setSettings(s);
      setGit(g);
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, []);

  useEffect(() => {
    void load();
    // Le serveur émet `compteur` à chaque incrément, que l'appel vienne de cet écran ou d'une IA
    // (skill « Saluer » dans le chat) : l'écran reste à jour sans recharger.
    return cadence.on("compteur", (data) => {
      const { valeur } = data as CompteurEvent;
      setEtat((e) => (e ? { ...e, valeur } : e));
      setLastEvent(`compteur → ${valeur} à ${new Date().toLocaleTimeString("fr-FR")}`);
    });
  }, [load]);

  const incrementer = async () => {
    setBusy(true);
    try {
      const r = await cadence.call<Increment>("incrementer");
      setEtat((e) => (e ? { ...e, valeur: r.valeur } : e));
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const changerPas = async (pas: number) => {
    try {
      // Cadence enregistre le réglage et le transmet au serveur (notifications/cadence/settings).
      setSettings(await cadence.settings.set<ExempleSettings>({ pas }));
    } catch (e) {
      fail(e);
    }
  };

  const installerGit = async () => {
    try {
      // Ouvre la boîte d'installation de Cadence : rien n'est installé sans le clic de l'utilisateur.
      setGit(await cadence.tools.ensure("git"));
      // Le serveur reçoit le chemin des outils dans CADENCE_TOOLS : relire son état.
      await load();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon name="sparkle" size={17} className="text-clay" />
        <h1 className="font-display text-title">Exemple</h1>
        {etat && <Badge mono>serveur {etat.version}</Badge>}
        <div className="grow" />
        <Button size="sm" variant="ghost" icon="refresh" iconOnly aria-label="Rafraîchir" onClick={() => void load()} />
      </header>

      <main className="min-h-0 grow overflow-y-auto p-5">
        <div className="mx-auto flex max-w-[640px] flex-col gap-4">
          <p className="text-body-sm leading-[1.6] text-tx2">
            {salutation(settings?.prenom)} Ce plugin sert de modèle : chaque carte montre un usage du SDK
            des écrans de plugin. Le code est dans <span className="mono">plugins/exemple</span>.
          </p>
          {error && <Callout tone="danger">{error}</Callout>}
          {!etat && !error && <Spinner />}

          <Card className="flex flex-col gap-3 p-[18px]">
            <CardHeader title="Outil du serveur et événement" actions={<Badge mono>cadence.call · cadence.on</Badge>} />
            <div className="flex items-center gap-4">
              <span className="font-display text-kpi">{etat?.valeur ?? "—"}</span>
              <Button variant="primary" icon="plus" disabled={!etat || busy} onClick={() => void incrementer()}>
                Incrémenter de {settings?.pas ?? 1}
              </Button>
            </div>
            <span className="mono text-caption text-tx3">{lastEvent ?? "Aucun événement reçu pour l'instant."}</span>
          </Card>

          <Card className="flex flex-col gap-3 p-[18px]">
            <CardHeader
              title="Réglages"
              actions={
                <Button size="xs" variant="ghost" icon="user" onClick={() => void cadence.navigate(VIEWS.prenom)}>
                  Modifier le prénom
                </Button>
              }
            />
            <KeyValue label="Prénom" value={settings?.prenom || "non renseigné"} mono={false} />
            <div className="flex items-center gap-3">
              <span className="grow text-body-sm text-tx2">Pas du compteur</span>
              <Select
                aria-label="Pas du compteur"
                className="w-[90px]"
                value={settings?.pas ?? 1}
                onChange={(e) => void changerPas(pasValide(e.target.value))}
              >
                {PAS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-[18px]">
            <CardHeader title="Skill" actions={<Badge mono>cadence.runAction</Badge>} />
            <p className="text-body-sm text-tx2">
              « Saluer » ouvre le chat : l'IA appelle <span className="mono">exemple__incrementer</span> puis vous
              salue. Le compteur ci-dessus suit grâce à l'événement.
            </p>
            <div>
              <Button variant="secondary" icon="play" onClick={() => void cadence.runAction("saluer").catch(fail)}>
                Saluer dans le chat
              </Button>
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-[18px]">
            <CardHeader title="Outil externe : git" actions={<Badge mono>cadence.tools</Badge>} />
            <p className="text-body-sm text-tx2">{toolLine(git, etat?.git ?? null)}</p>
            {git && !git.installed && (
              <div>
                <Button variant="secondary" icon="download" onClick={() => void installerGit()}>
                  Installer git
                </Button>
              </div>
            )}
          </Card>
        </div>
      </main>
    </div>
  );
}

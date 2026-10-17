/**
 * Étape de configuration « Votre prénom » (`[[setup]]`, route `setup-prenom`) : Cadence l'affiche à
 * l'onboarding et à l'installation. Le prénom va dans les réglages globaux du plugin.
 */
import { useEffect, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Button, Callout, Card, Field, Icon, Input } from "@cadence/ui";
import { salutation, VIEWS, type ExempleSettings } from "../domain";

export function SetupPrenomView() {
  const [prenom, setPrenom] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void cadence.settings.get<ExempleSettings>().then((s) => {
      setPrenom(s.prenom ?? "");
      setSaved(s.prenom || null);
    });
  }, []);

  const save = async () => {
    try {
      const s = await cadence.settings.set<ExempleSettings>({ prenom: prenom.trim() });
      setSaved(s.prenom || null);
      setError(null);
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[560px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="user" size={19} />
          <h1 className="font-display text-title">Votre prénom</h1>
        </div>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Le skill « Saluer » s'en sert. Cette étape est facultative : vous pourrez le changer dans les réglages
          du plugin.
        </p>
        <Card className="flex flex-col gap-3 p-[18px]">
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field label="Prénom" htmlFor="prenom" className="grow">
              <Input id="prenom" size="md" placeholder="Camille" value={prenom} onChange={(e) => setPrenom(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" icon="check">
              Enregistrer
            </Button>
          </form>
          {saved && (
            <Callout tone="success">
              {salutation(saved)} Prénom enregistré.{" "}
              <button type="button" className="text-clay underline" onClick={() => void cadence.navigate(VIEWS.accueil)}>
                Aller à l'accueil du plugin
              </button>
            </Callout>
          )}
          {error && <Callout tone="danger">{error}</Callout>}
        </Card>
      </div>
    </div>
  );
}

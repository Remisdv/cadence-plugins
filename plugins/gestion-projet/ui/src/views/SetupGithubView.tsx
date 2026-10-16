/**
 * Étape de setup « Compte GitHub » : le jeton est écrit dans le trousseau par Cadence
 * (`cadence.secrets.set`), jamais relu par l'UI ; on vérifie la connexion avec `get_account`.
 */
import { useEffect, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Button, Callout, Card, Field, Icon, Input, KeyValue } from "@cadence/ui";
import type { Account } from "../domain";

const TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Cadence%20%E2%80%94%20Gestion%20de%20projet";

export function SetupGithubView() {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [repository, setRepository] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    try {
      setAccount(await cadence.call<Account>("get_account"));
      setError(null);
    } catch (e) {
      setAccount(null);
      setError(isCadenceError(e) ? e.message : String(e));
    }
  };

  useEffect(() => {
    void cadence.secrets.has("github_token").then((has) => {
      setHasToken(has);
      if (has) void check();
    });
    void cadence.settings.get<{ repository?: string }>().then((s) => setRepository(s.repository ?? ""));
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      if (token.trim()) {
        await cadence.secrets.set("github_token", token.trim());
        setToken("");
        setHasToken(true);
      }
      if (repository.trim()) await cadence.settings.set({ repository: repository.trim() });
      await check();
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[560px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="github" size={19} />
          <h1 className="font-display text-title">Compte GitHub</h1>
        </div>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Le plugin lit et écrit les issues, versions, pull requests et releases du dépôt de l'espace
          avec un jeton GitHub. Cadence le range dans le trousseau du système ; cet écran ne peut
          que l'écrire.
        </p>

        <Card className="flex flex-col gap-4 p-[18px]">
          <Field
            label="Jeton GitHub"
            htmlFor="token"
            aside={hasToken ? "déjà enregistré — laissez vide pour le garder" : "droits repo et read:org"}
            hint={
              <button className="text-clay hover:text-clay-hover" onClick={() => void cadence.openExternal(TOKEN_URL)}>
                Créer un jeton sur GitHub
              </button>
            }
          >
            <Input
              id="token"
              type="password"
              mono
              autoComplete="off"
              placeholder="ghp_… ou github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Field>
          <Field label="Dépôt" htmlFor="repo" aside="owner/name ; par défaut le remote origin de l'espace">
            <Input
              id="repo"
              size="md"
              mono
              placeholder="RemiSDV/cadence"
              value={repository}
              onChange={(e) => setRepository(e.target.value)}
            />
          </Field>
          <div className="flex justify-end">
            <Button variant="primary" icon="check" onClick={() => void save()} disabled={busy}>
              Enregistrer et vérifier
            </Button>
          </div>
        </Card>

        {account && (
          <Callout tone="success">
            Connecté en tant que <strong>{account.login}</strong>
            {account.name ? ` (${account.name})` : ""}.
          </Callout>
        )}
        {account?.repository && (
          <Card className="px-[15px] py-1">
            <KeyValue label="Dépôt suivi" value={account.repository} last />
          </Card>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </div>
  );
}

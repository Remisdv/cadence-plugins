/**
 * Étape de setup « Dépôts suivis » : la connexion GitHub est gérée par Cadence (service `repos`,
 * étape précédente de l'onboarding) ; cet écran choisit les dépôts que le plugin suit, avec
 * `cadence.repos.follow` / `unfollow`. Les dépôts du compte viennent de `list_account_repos`.
 */
import { useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import { Badge, Button, Callout, Card, Field, Icon, Input, KeyValue, SectionLabel, Spinner } from "@cadence/ui";
import type { Account, AccountRepo } from "../domain";
import { useRepos } from "../useRepos";
import { useTool } from "../useTool";

export function SetupReposView() {
  const { repos, error: reposError } = useRepos();
  const account = useTool<Account>("get_account");
  const suggestions = useTool<{ repos: AccountRepo[] }>("list_account_repos");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const followed = new Set((repos ?? []).map((r) => r.fullName.toLowerCase()));

  const run = async (key: string, op: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await op();
      setError(null);
    } catch (e) {
      setError(isCadenceError(e) ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const follow = (fullName: string) =>
    run(fullName, async () => {
      await cadence.repos.follow(fullName);
      if (fullName === name.trim()) setName("");
    });
  const unfollow = (fullName: string) => run(fullName, () => cadence.repos.unfollow(fullName));

  const others = (suggestions.data?.repos ?? []).filter((r) => !followed.has(r.full_name.toLowerCase()));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[560px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="github" size={19} />
          <h1 className="font-display text-title">Dépôts suivis</h1>
        </div>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Gestion de projet lit et écrit les issues, versions, pull requests et releases des dépôts
          suivis, avec le compte GitHub connecté dans Cadence. Le sélecteur en tête de la barre du
          plugin passe d'un dépôt à l'autre, ou les montre tous. Le code n'est cloné que quand un
          skill doit y toucher.
        </p>

        {account.data && (
          <Callout tone="success">
            Connecté en tant que <strong>{account.data.login}</strong>
            {account.data.name ? ` (${account.data.name})` : ""}.
          </Callout>
        )}
        {account.error && <Callout tone="warning">{account.error.message}</Callout>}

        <Card className="flex flex-col gap-4 p-[18px]">
          <Field label="Suivre un dépôt" htmlFor="repo" aside="owner/name">
            <div className="flex gap-2">
              <Input
                id="repo"
                size="md"
                mono
                placeholder="RemiSDV/cadence"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) void follow(name.trim());
                }}
              />
              <Button
                variant="primary"
                icon="plus"
                onClick={() => void follow(name.trim())}
                disabled={!name.trim() || busy !== null}
              >
                Suivre
              </Button>
            </div>
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </Card>

        <section className="flex flex-col gap-2">
          <SectionLabel>Suivis · {repos?.length ?? 0}</SectionLabel>
          {reposError && <Callout tone="danger">{reposError.message}</Callout>}
          {!repos && !reposError && <Spinner />}
          {repos && repos.length === 0 && (
            <Card className="p-4 text-center text-body-sm text-tx3">Aucun dépôt suivi pour l'instant.</Card>
          )}
          {repos && repos.length > 0 && (
            <Card className="px-[15px] py-1">
              {repos.map((r, i) => (
                <KeyValue
                  key={r.fullName}
                  label={<span className="mono text-tx">{r.fullName}</span>}
                  mono={false}
                  value={
                    <Button
                      size="xs"
                      variant="quiet"
                      icon="close"
                      onClick={() => void unfollow(r.fullName)}
                      disabled={busy !== null}
                    >
                      Retirer
                    </Button>
                  }
                  last={i === repos.length - 1}
                />
              ))}
            </Card>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel>Dépôts du compte</SectionLabel>
          {suggestions.loading && !suggestions.data && <Spinner />}
          {suggestions.error && <Callout tone="info">{suggestions.error.message}</Callout>}
          {suggestions.data && others.length === 0 && (
            <Card className="p-4 text-center text-body-sm text-tx3">Tous les dépôts récents sont suivis.</Card>
          )}
          {others.length > 0 && (
            <Card className="divide-y divide-line">
              {others.map((r) => (
                <div key={r.full_name} className="flex min-h-[42px] items-center gap-3 px-3.5 py-2">
                  <span className="mono min-w-0 grow truncate text-body-sm text-tx" title={r.description ?? ""}>
                    {r.full_name}
                  </span>
                  {r.private && <Badge tone="muted">privé</Badge>}
                  <Button
                    size="xs"
                    variant="secondary"
                    icon="plus"
                    onClick={() => void follow(r.full_name)}
                    disabled={busy !== null}
                  >
                    Suivre
                  </Button>
                </div>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

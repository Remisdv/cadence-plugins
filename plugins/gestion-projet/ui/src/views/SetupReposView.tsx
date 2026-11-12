/**
 * Écran « Dépôt et équipe » (route `setup-depots`) : le dépôt dans lequel Gestion de projet
 * travaille, et les personnes qui y ont accès.
 *
 * Tout ce que le plugin gère (issues, catégories, roadmap, sprints, planning, designs…) est
 * enregistré dans le dépôt GitHub : on travaille donc dans un seul dépôt à la fois. On le choisit
 * dans la liste des dépôts du compte (`list_account_repos`), ou on le crée (`create_repo`), puis
 * `cadence.repos.select` le rend actif. Les collaborateurs s'invitent par leur login GitHub
 * (`invite_collaborator`) : plus besoin d'aller sur GitHub.
 */
import { useEffect, useState } from "react";
import { cadence, isCadenceError } from "@cadence/plugin-sdk";
import {
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Icon,
  Input,
  SectionLabel,
  Select,
  Spinner,
  SwitchField,
  initialsOf,
} from "@cadence/ui";
import {
  PERMISSIONS,
  parseLogin,
  permissionLabel,
  validRepoName,
  type Account,
  type AccountRepo,
  type Collaborators,
  type Permission,
} from "../domain";
import { useSelection } from "../useRepos";
import { useTool } from "../useTool";

const message = (e: unknown) => (isCadenceError(e) ? e.message : String(e));

export function SetupReposView() {
  const { repo, error: reposError } = useSelection();
  const account = useTool<Account>("get_account");
  const [changing, setChanging] = useState(false);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[620px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="github" size={19} />
          <h1 className="font-display text-title">Dépôt et équipe</h1>
        </div>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Gestion de projet travaille dans un seul dépôt à la fois : issues, catégories, roadmap,
          sprints et planning y sont enregistrés. Choisissez-le parmi vos dépôts GitHub ou
          créez-le ici, puis invitez votre équipe, sans passer par GitHub.
        </p>

        {account.error && <Callout tone="warning">{account.error.message}</Callout>}
        {reposError && <Callout tone="danger">{reposError.message}</Callout>}

        <SectionLabel>Dépôt actif</SectionLabel>
        {repo && !changing ? (
          <Card className="flex items-center gap-3 px-4 py-3">
            <Avatar size={26} tone="neutral" initials={initialsOf(repo.split("/")[1] ?? repo)} />
            <div className="min-w-0 grow">
              <div className="mono truncate text-body-sm text-tx">{repo}</div>
              <div className="text-caption text-tx3">Tout le projet est enregistré dans ce dépôt.</div>
            </div>
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => setChanging(true)}>
              Changer de dépôt
            </Button>
          </Card>
        ) : (
          <RepoPicker
            account={account.data}
            current={repo}
            onDone={() => setChanging(false)}
            onCancel={repo ? () => setChanging(false) : undefined}
          />
        )}

        {repo && !changing && <Team repo={repo} me={account.data?.login ?? null} />}
      </div>
    </div>
  );
}

/** Choix du dépôt actif : recherche dans les dépôts du compte, ou création. */
function RepoPicker({
  account,
  current,
  onDone,
  onCancel,
}: {
  account: Account | null;
  current: string | null;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);
  const list = useTool<{ repos: AccountRepo[]; truncated?: boolean }>(
    "list_account_repos",
    debounced ? { query: debounced } : {},
  );
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (fullName: string) => {
    setBusy(fullName);
    setError(null);
    try {
      if (fullName !== current) await cadence.repos.select(fullName);
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  if (creating) {
    return (
      <CreateRepoCard
        account={account}
        initialName={query}
        onCancel={() => setCreating(false)}
        onCreated={(repo) => void choose(repo.full_name)}
      />
    );
  }

  const repos = list.data?.repos ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <Icon name="search" size={15} className="text-tx3" />
        <input
          autoFocus
          aria-label="Rechercher un dépôt"
          placeholder="Rechercher parmi vos dépôts GitHub…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && repos[0]) void choose(repos[0].full_name);
          }}
          className="min-w-0 grow bg-transparent text-body-sm text-tx outline-none placeholder:text-tx3"
        />
        {list.loading && <Spinner size={13} />}
        <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Créer un dépôt
        </Button>
      </div>

      <div className="max-h-[360px] divide-y divide-line overflow-y-auto">
        {list.error && <Callout tone="warning" className="m-3">{list.error.message}</Callout>}
        {!list.data && list.loading && (
          <div className="flex h-20 items-center justify-center">
            <Spinner />
          </div>
        )}
        {list.data && repos.length === 0 && (
          <div className="px-4 py-6 text-center text-body-sm text-tx3">
            {debounced ? `Aucun dépôt ne correspond à « ${debounced} ».` : "Aucun dépôt sur ce compte."}
          </div>
        )}
        {repos.map((r) => {
          const active = r.full_name.toLowerCase() === current?.toLowerCase();
          return (
            <button
              key={r.full_name}
              type="button"
              disabled={busy !== null}
              onClick={() => void choose(r.full_name)}
              className="flex min-h-[48px] w-full items-center gap-3 px-3.5 py-2 text-left hover:bg-p2 disabled:opacity-60"
            >
              <span className="min-w-0 grow">
                <span className="mono block truncate text-body-sm text-tx">{r.full_name}</span>
                {r.description && (
                  <span className="block truncate text-caption text-tx3">{r.description}</span>
                )}
              </span>
              {r.private && <Badge tone="muted">privé</Badge>}
              {busy === r.full_name ? (
                <Spinner size={13} />
              ) : active ? (
                <Badge tone="clay">actif</Badge>
              ) : (
                <Icon name="arrowRight" size={14} className="text-tx3" />
              )}
            </button>
          );
        })}
      </div>

      {(error || list.data?.truncated || onCancel) && (
        <div className="flex items-center gap-3 border-t border-line bg-p2 px-3.5 py-2">
          <span className="min-w-0 grow text-caption text-tx3">
            {error ? (
              <span className="text-red">{error}</span>
            ) : list.data?.truncated ? (
              "Seuls les 500 dépôts les plus récents sont listés : tapez un nom pour chercher."
            ) : null}
          </span>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Annuler
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Nouveau dépôt GitHub (compte ou organisation), rendu actif dès sa création. */
function CreateRepoCard({
  account,
  initialName,
  onCancel,
  onCreated,
}: {
  account: Account | null;
  initialName: string;
  onCancel: () => void;
  onCreated: (repo: AccountRepo) => void;
}) {
  const owners = account ? [account.login, ...(account.orgs ?? [])] : [];
  const [owner, setOwner] = useState("");
  const [name, setName] = useState(initialName.trim().replace(/\s+/g, "-"));
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownOwner = owner || owners[0] || "";
  const nameValid = validRepoName(name);

  const submit = async () => {
    if (!nameValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const repo = await cadence.call<AccountRepo>("create_repo", {
        name,
        owner: shownOwner || undefined,
        description: description.trim() || undefined,
        private: isPrivate,
      });
      onCreated(repo);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-[18px]">
      <div className="flex items-center gap-2">
        <Icon name="plus" size={15} />
        <span className="font-display text-title-sm font-semibold">Nouveau dépôt</span>
      </div>
      <div className="flex gap-3">
        <Field label="Propriétaire" htmlFor="repo-owner" className="w-[200px] shrink-0">
          <Select
            id="repo-owner"
            value={shownOwner}
            disabled={owners.length === 0}
            onChange={(e) => setOwner(e.target.value)}
          >
            {owners.length === 0 && <option value="">Compte connecté</option>}
            {owners.map((o, i) => (
              <option key={o} value={o}>
                {o}
                {i > 0 ? " (organisation)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Nom"
          htmlFor="repo-name"
          className="min-w-0 grow"
          error={name !== "" && !nameValid ? "Lettres, chiffres, « - », « _ » et « . » uniquement." : undefined}
        >
          <Input
            id="repo-name"
            size="md"
            mono
            autoFocus
            spellCheck={false}
            placeholder="mon-projet"
            value={name}
            invalid={name !== "" && !nameValid}
            onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </Field>
      </div>
      <Field label="Description" htmlFor="repo-description" aside="facultative">
        <Input
          id="repo-description"
          size="md"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <SwitchField
        checked={isPrivate}
        onCheckedChange={setPrivate}
        label="Dépôt privé"
        hint="Visible seulement par vous et les personnes invitées."
      />
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex items-center justify-end gap-2">
        <span className="mono min-w-0 grow truncate text-caption text-tx3">
          github.com/{shownOwner || "…"}/{name || "…"}
        </span>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Annuler
        </Button>
        <Button variant="primary" icon={busy ? undefined : "plus"} onClick={() => void submit()} disabled={!nameValid || busy}>
          {busy && <Spinner size={12} />}
          Créer et utiliser
        </Button>
      </div>
    </Card>
  );
}

/** Collaborateurs du dépôt actif, invitations en attente et invitation par login GitHub. */
function Team({ repo, me }: { repo: string; me: string | null }) {
  const team = useTool<Collaborators>("list_collaborators", { repo }, repo);
  const [login, setLogin] = useState("");
  const [permission, setPermission] = useState<Permission>("push");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const parsed = parseLogin(login);

  const run = async (key: string, op: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await op();
      if (done) setNotice(done);
      team.reload();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const invite = () => {
    if (!parsed) return;
    void run(
      "invite",
      async () => {
        const res = await cadence.call<{ already_member: boolean }>("invite_collaborator", {
          repo,
          login: parsed,
          permission,
        });
        setLogin("");
        if (res.already_member) throw new Error(`${parsed} a déjà accès au dépôt.`);
      },
      `Invitation envoyée à ${parsed} : GitHub le prévient par e-mail.`,
    );
  };

  const members = team.data?.collaborators ?? [];
  const invitations = team.data?.invitations ?? [];

  return (
    <>
      <SectionLabel className="mt-2">Équipe · {members.length}</SectionLabel>
      <Card className="flex flex-col gap-3 p-[18px]">
        <Field label="Inviter quelqu'un" htmlFor="invite-login" aside="login GitHub">
          <div className="flex gap-2">
            <Input
              id="invite-login"
              size="md"
              mono
              placeholder="login-github"
              value={login}
              invalid={login.trim() !== "" && !parsed}
              onChange={(e) => setLogin(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && invite()}
            />
            <Select
              aria-label="Rôle"
              className="w-[160px] shrink-0"
              value={permission}
              onChange={(e) => setPermission(e.target.value as Permission)}
            >
              {PERMISSIONS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              icon="plus"
              onClick={invite}
              disabled={!parsed || busy !== null}
            >
              Inviter
            </Button>
          </div>
        </Field>
        {notice && <Callout tone="success">{notice}</Callout>}
        {error && <Callout tone="danger">{error}</Callout>}
      </Card>

      {team.error && <Callout tone="warning">{team.error.message}</Callout>}
      {!team.data && team.loading && <Spinner />}
      {team.data && (
        <Card className="divide-y divide-line">
          {invitations.map((i) => (
            <div key={`i${i.id}`} className="flex min-h-[46px] items-center gap-3 px-3.5 py-2">
              <Avatar size={24} tone="neutral" src={i.avatar_url ?? undefined} initials={initialsOf(i.login)} />
              <span className="mono min-w-0 grow truncate text-body-sm text-tx">{i.login}</span>
              <Badge tone="amber">invitation envoyée</Badge>
              <span className="text-caption text-tx3">{permissionLabel(i.role)}</span>
              <Button
                size="xs"
                variant="quiet"
                icon="close"
                disabled={busy !== null}
                onClick={() =>
                  void run(`i${i.id}`, () =>
                    cadence.call("remove_collaborator", { repo, invitation_id: i.id }),
                  )
                }
              >
                Annuler
              </Button>
            </div>
          ))}
          {members.map((m) => (
            <div key={m.login} className="flex min-h-[46px] items-center gap-3 px-3.5 py-2">
              <Avatar size={24} tone="neutral" src={m.avatar_url ?? undefined} initials={initialsOf(m.login)} />
              <span className="mono min-w-0 grow truncate text-body-sm text-tx">
                {m.login}
                {m.login === me && <span className="ml-1.5 font-sans text-caption text-tx3">(vous)</span>}
              </span>
              <span className="text-caption text-tx3">{permissionLabel(m.role)}</span>
              {m.login !== me && (
                <Button
                  size="xs"
                  variant="quiet"
                  icon="close"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(m.login, () => cadence.call("remove_collaborator", { repo, login: m.login }))
                  }
                >
                  Retirer
                </Button>
              )}
            </div>
          ))}
          {members.length === 0 && invitations.length === 0 && (
            <div className="px-4 py-5 text-center text-body-sm text-tx3">Personne d'autre pour l'instant.</div>
          )}
        </Card>
      )}
    </>
  );
}

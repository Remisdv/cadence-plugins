/** Étape de setup « Dossier des cours » : choisit le dossier, enregistré dans les réglages globaux du plugin. */
import { useEffect, useState } from "react";
import { cadence } from "@cadence/plugin-sdk";
import { Button, Card, Icon, KeyValue } from "@cadence/ui";

export function SetupFolderView() {
  const [folder, setFolder] = useState<string>("");

  useEffect(() => {
    void cadence.settings.get<{ dossier_cours?: string }>().then((s) => setFolder(s.dossier_cours ?? ""));
  }, []);

  const pick = async () => {
    const [dir] = await cadence.pickFiles({ title: "Dossier des cours", directory: true });
    if (!dir) return;
    // Chemin absolu : il n'y a plus d'espace de travail auquel le rapporter.
    await cadence.settings.set({ dossier_cours: dir });
    setFolder(dir);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-[560px] flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <Icon name="folder" size={19} />
          <h1 className="font-display text-title">Dossier des cours</h1>
        </div>
        <p className="text-body-sm leading-[1.6] text-tx2">
          Choisissez le dossier où vous rangez vos cours. Vous les importerez ensuite dans la
          bibliothèque, par matière et chapitre ; les fichiers restent à leur place.
        </p>
        <Card className="flex flex-col gap-3 p-[18px]">
          <KeyValue label="Dossier" value={folder || "aucun — chemins absolus seulement"} last />
          <div className="flex justify-end">
            <Button variant="primary" icon="folder" onClick={() => void pick()}>
              Choisir un dossier
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

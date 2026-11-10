import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, Settings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface Props {
  open: boolean;
  settings: Settings | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function KeyDialog({ open, settings, onOpenChange, onSaved }: Props) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string) => {
    setSaving(true);
    try {
      await api.setKey(value);
      setKey("");
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save(key);
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>Clé API PRIM</DialogTitle>
            <DialogDescription>
              Le temps réel vient de la plateforme PRIM d'Île-de-France Mobilités. Créez un compte gratuit, générez un
              jeton et collez-le ici. Sans clé, les trains sont simulés.
            </DialogDescription>
          </DialogHeader>
          <Button
            type="button"
            variant="link"
            className="h-auto justify-start p-0"
            onClick={() => openUrl("https://prim.iledefrance-mobilites.fr/fr/mon-jeton-api")}
          >
            Obtenir une clé sur prim.iledefrance-mobilites.fr
          </Button>
          {settings?.keyFromEnv && (
            <p className="rounded-md bg-muted px-2 py-1 text-sm">Une clé est déjà fournie par la variable PRIM_API_KEY.</p>
          )}
          <Input
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Votre jeton API"
            className="font-mono"
            aria-label="Jeton API"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            {settings?.hasKey && !settings.keyFromEnv && (
              <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => save("")}>
                Supprimer la clé
              </Button>
            )}
            <Button type="submit" disabled={!key.trim() || saving}>
              Enregistrer la clé
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

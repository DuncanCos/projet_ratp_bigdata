import { Quota, clock } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { KeyRound, Settings2 } from "lucide-react";

const REFRESH_CHOICES = [60, 120, 180];

interface Props {
  refresh: number;
  onRefresh: (s: number) => void;
  liveAll: boolean;
  onLiveAll: (v: boolean) => void;
  quota: Quota | null;
  onApiKey: () => void;
}

/** Réglages rarement utilisés, rangés derrière un bouton. */
export function SettingsMenu({ refresh, onRefresh, liveAll, onLiveAll, quota, onApiKey }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon-lg" className="size-10 rounded-full bg-white shadow-md" aria-label="Réglages">
          <Settings2 className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="refresh" className="text-sm font-medium">
            Actualiser
          </label>
          <Select value={String(refresh)} onValueChange={(v) => onRefresh(Number(v))}>
            <SelectTrigger id="refresh" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REFRESH_CHOICES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  toutes les {s} s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4 flex items-start justify-between gap-3">
          <label htmlFor="live-all" className="text-sm">
            <span className="font-medium">Tout le réseau en temps réel</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              16 requêtes par actualisation : le quota de la journée s'épuise en une heure environ.
            </span>
          </label>
          <Switch id="live-all" checked={liveAll} onCheckedChange={onLiveAll} />
        </div>

        {quota?.remaining != null && (
          <p className="mt-4 rounded-md bg-muted px-2.5 py-2 text-xs">
            <span className="font-semibold">
              {quota.remaining} requêtes restantes sur {quota.limit ?? 1000}
            </span>{" "}
            aujourd'hui pour le temps réel
            {quota.resetAtMs != null && `, remise à zéro à ${clock(quota.resetAtMs)}`}.
          </p>
        )}

        <Separator className="my-3" />
        <Button variant="secondary" className="w-full justify-start gap-2" onClick={onApiKey}>
          <KeyRound className="size-4" />
          Clé API PRIM
        </Button>
      </PopoverContent>
    </Popover>
  );
}

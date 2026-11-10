import { Disruption, cleanTitle, worstActive } from "@/lib/api";
import { LINES, isRer, lineTitle } from "@/lib/metro";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Roundel } from "./Roundel";
import { Check, Layers } from "lucide-react";

interface Props {
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  counts: Record<string, number>;
  traffic: Record<string, Disruption[]>;
  /** côté d'ouverture : en bas sur téléphone, à gauche sur ordinateur */
  direction: "bottom" | "left";
}

/** Tiroir (vaul) pour choisir les lignes affichées sur la carte. */
export function LineDrawer({ visible, onChange, counts, traffic, direction }: Props) {
  const toggle = (id: string) => {
    const next = new Set(visible);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  const shown = LINES.filter((l) => visible.has(l.id));

  return (
    <Drawer direction={direction}>
      <DrawerTrigger asChild>
        <Button variant="outline" className="h-10 gap-2 rounded-full bg-white px-3 shadow-md">
          <Layers className="size-4" />
          <span>Lignes</span>
          <span className="rounded-full bg-ink px-1.5 text-xs font-bold text-white tabular-nums">
            {shown.length}
          </span>
        </Button>
      </DrawerTrigger>
      <DrawerContent className="data-[vaul-drawer-direction=left]:sm:max-w-sm">
        <DrawerHeader className="text-left">
          <DrawerTitle className="text-lg font-bold">Lignes affichées</DrawerTitle>
          <DrawerDescription>Choisissez les lignes à voir sur la carte.</DrawerDescription>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => onChange(new Set(LINES.map((l) => l.id)))}>
              Toutes
            </Button>
            <Button size="sm" variant="secondary" onClick={() => onChange(new Set())}>
              Aucune
            </Button>
          </div>
        </DrawerHeader>

        <ul className="grid min-h-0 flex-1 grid-cols-1 gap-1 overflow-y-auto px-3 pb-2 sm:grid-cols-1" role="group" aria-label="Lignes">
          {LINES.map((l, i) => {
            const on = visible.has(l.id);
            const worst = worstActive(traffic[l.id]);
            const group = i === 0 || isRer(l) !== isRer(LINES[i - 1]) ? (isRer(l) ? "RER" : "Métro") : null;
            return (
              <li key={l.id}>
                {group && (
                  <div className={`flex items-center justify-between px-2 pb-1 ${i ? "pt-3" : ""}`}>
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</span>
                    <button
                      className="text-xs font-medium text-ink-soft underline-offset-2 hover:underline"
                      onClick={() => {
                        const ids = LINES.filter((o) => isRer(o) === isRer(l)).map((o) => o.id);
                        const all = ids.every((id) => visible.has(id));
                        const next = new Set(visible);
                        ids.forEach((id) => (all ? next.delete(id) : next.add(id)));
                        onChange(next);
                      }}
                    >
                      {LINES.filter((o) => isRer(o) === isRer(l)).every((o) => visible.has(o.id)) ? "Masquer" : "Tout afficher"}
                    </button>
                  </div>
                )}
                <button
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(l.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors ${
                    on ? "bg-accent" : "hover:bg-muted"
                  }`}
                >
                  <Roundel line={l} size={34} dim={!on} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{lineTitle(l)}</span>
                    <span className={`block truncate text-xs ${worst ? "text-signal" : "text-muted-foreground"}`}>
                      {worst ? cleanTitle(worst.title) : `${counts[l.id] ?? 0} trains`}
                    </span>
                  </span>
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-md border-2 ${
                      on ? "border-ink bg-ink text-white" : "border-input bg-white"
                    }`}
                    aria-hidden
                  >
                    {on && <Check className="size-4" strokeWidth={3} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <DrawerFooter className="border-t">
          <DrawerClose asChild>
            <Button size="lg">Afficher {shown.length} ligne{shown.length > 1 ? "s" : ""}</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

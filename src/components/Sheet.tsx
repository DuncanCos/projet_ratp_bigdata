import { ReactNode, useEffect, useRef, useState } from "react";

type Snap = "peek" | "half" | "full";
const HEIGHT: Record<Snap, string> = { peek: "128px", half: "50dvh", full: "88dvh" };

/**
 * Tiroir en bas de l'écran (téléphone). Trois hauteurs : aperçu, moitié, plein
 * écran. On change en touchant la poignée ou en la faisant glisser.
 */
export function Sheet({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  const [snap, setSnap] = useState<Snap>("half");
  const start = useRef<{ y: number; snap: Snap } | null>(null);
  const dragged = useRef(false);
  useEffect(() => setSnap("half"), [resetKey]);

  const order: Snap[] = ["peek", "half", "full"];
  const move = (dir: 1 | -1) => setSnap((s) => order[Math.min(2, Math.max(0, order.indexOf(s) + dir))]);

  return (
    <section
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl bg-white shadow-[0_-8px_30px_rgba(29,39,51,0.18)] transition-[height] duration-200 ease-out"
      style={{ height: HEIGHT[snap] }}
    >
      <button
        aria-label={snap === "full" ? "Réduire le panneau" : "Agrandir le panneau"}
        className="flex h-6 w-full shrink-0 touch-none items-center justify-center"
        onClick={() => {
          if (dragged.current) {
            dragged.current = false; // le glisser a déjà changé la hauteur
            return;
          }
          move(snap === "full" ? -1 : 1);
        }}
        onPointerDown={(e) => (start.current = { y: e.clientY, snap })}
        onPointerUp={(e) => {
          const s = start.current;
          start.current = null;
          if (!s) return;
          const dy = e.clientY - s.y;
          if (Math.abs(dy) > 30) {
            dragged.current = true;
            move(dy < 0 ? 1 : -1);
          }
        }}
      >
        <span className="h-1.5 w-10 rounded-full bg-rail" />
      </button>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </section>
  );
}

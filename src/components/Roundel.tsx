import { Line, isRer, label, lineTitle } from "../lib/metro";

/** Pastille de ligne : rond pour le métro, carré arrondi pour le RER (comme la signalétique). */
export function Roundel({ line, size = 28, dim = false }: { line: Line; size?: number; dim?: boolean }) {
  const text = label(line);
  const rer = isRer(line);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center font-bold leading-none transition-opacity ${rer ? "" : "rounded-full"}`}
      style={{
        width: size,
        height: size,
        borderRadius: rer ? size * 0.24 : undefined,
        background: line.color,
        color: line.textColor,
        fontSize: text.length > 2 ? size * 0.36 : size * 0.5,
        fontStretch: text.length > 2 ? "75%" : "100%",
        opacity: dim ? 0.35 : 1,
      }}
      aria-label={lineTitle(line)}
    >
      {text}
    </span>
  );
}

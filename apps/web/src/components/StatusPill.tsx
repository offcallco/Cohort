import { Check, Clock, Eye, Minus, Pause, X } from "lucide-react";

// The guide's five status tones. Color always comes with an icon and a text label.
export type Tone = "running" | "passed" | "waiting" | "failed" | "idle";

export function StatusPill({ tone, label, icon }: { tone: Tone; label: string; icon?: "clock" | "pause" | "dash" }) {
  const size = 12;
  const glyph =
    tone === "running" ? (
      <span className="pulse" aria-hidden />
    ) : tone === "passed" ? (
      <Check size={size} aria-hidden />
    ) : tone === "waiting" ? (
      icon === "clock" ? <Clock size={size} aria-hidden /> : <Eye size={size} aria-hidden />
    ) : tone === "failed" ? (
      <X size={size} aria-hidden />
    ) : icon === "pause" ? (
      <Pause size={size} aria-hidden />
    ) : icon === "clock" ? (
      <Clock size={size} aria-hidden />
    ) : (
      <Minus size={size} aria-hidden />
    );
  return (
    <span className={`pill pill-${tone}`}>
      {glyph}
      {label}
    </span>
  );
}

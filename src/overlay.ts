// The on-screen overlay (Windows): marks around what the agent points at or was asked to circle, and an answer bubble
// near the pointer, so the user never has to switch to the panel to read an answer. native/win/overlay.ps1 is one warm
// process; marks are click-through, nothing ever takes focus (measured: 0 foreground changes). macOS: not built.
// HIGHLIGHT=off turns marks off, BUBBLE=off the bubble.
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "native", "win", "overlay.ps1");
let proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
const closedListeners = new Set<() => void>();

/** Called when the user clicks the bubble away. */
export function onBubbleClosed(f: () => void): void { closedListeners.add(f); }

export type Shape = "ring" | "box" | "arrow" | "underline";
export interface Rect { x: number; y: number; w: number; h: number }

const available = () => process.platform === "win32" && existsSync(SCRIPT);

/** Starts the helper ahead of time (about 1 s to start), so the first mark or bubble is immediate. */
export function warmOverlay(): void {
  if (!available() || proc) return;
  try {
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc = p;
    p.exited.then(() => { if (proc === p) proc = null; });
    void readEvents(p.stdout);
  } catch { proc = null; }
}

/** The helper's stdout: "bubble-closed" when the user clicks the bubble away (and its start-up line). */
export async function readEvents(out: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(), reader = out.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === "bubble-closed") for (const f of closedListeners) { try { f(); } catch { /* a listener never stops the overlay */ } }
      }
    }
  } catch { /* the helper exited */ }
}

function send(msg: object): boolean {
  if (!available()) return false;
  warmOverlay();
  if (!proc) return false;
  try { proc.stdin.write(JSON.stringify(msg) + "\n"); proc.stdin.flush(); return true; } catch { return false; }
}

/** Draws a shape around a rectangle (physical screen pixels) with an optional label, then fades it out. */
export function drawMark(r: Rect, opts: { shape?: Shape; label?: string; color?: number; ms?: number } = {}): boolean {
  if (process.env.HIGHLIGHT === "off") return false;
  return send({ cmd: "mark", x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h),
    shape: opts.shape ?? "ring", label: (opts.label ?? "").slice(0, 30), color: opts.color ?? 0, ms: opts.ms ?? 4000 });
}

/** Compatibility: a plain ring. */
export const highlight = (r: Rect, ms = 2500) => drawMark(r, { shape: "ring", ms });

/** Shows (or updates) the answer bubble near a screen point, or bottom right when `at` is missing. */
export function showBubble(text: string, opts: { at?: { x: number; y: number } | null; title?: string; ms?: number } = {}): boolean {
  if (process.env.BUBBLE === "off" || !text.trim()) return false;
  const ms = opts.ms ?? Math.min(25_000, 5000 + text.length * 55);   // long enough to read
  return send({ cmd: "bubble", text: text.slice(0, 900), title: opts.title ?? "Agent", x: Math.round(opts.at?.x ?? -1), y: Math.round(opts.at?.y ?? -1), ms });
}

/** Hides the bubble. Never starts the helper just for that (nothing can be showing without it). */
export function hideBubble(): void { if (proc) send({ cmd: "hide" }); }

export function stopOverlay(): void { try { proc?.stdin.end(); } catch { /* gone */ } proc = null; }

// The on-screen overlay (Windows): the buddy next to the cursor, the drawings, the agents' widgets, the pulses where they
// act, the typing box, the voice, and the screen capture for explain mode. native/win/overlay.ps1 is one warm process
// that speaks JSON lines both ways (the protocol is at the top of that file). It is the Windows twin of the Mac
// version's Overlay.swift. OVERLAY=off turns it off (answers are then spoken with speak.ts).
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "native", "win", "overlay.ps1");
let proc: Subprocess<"pipe", "pipe", "ignore"> | null = null;
let hello: object | undefined;

export type OverlayEvent =
  | { event: "ready" }
  | { event: "captured"; id: string; path?: string; imgW?: number; imgH?: number; x?: number; y?: number; w?: number; h?: number; cx?: number; cy?: number; error?: string }
  | { event: "ask"; text: string; cursor?: { x: number; y: number } }
  | { event: "step"; go: "next" | "back" }
  | { event: "dismiss" }
  | { event: "stop" }
  | { event: "key"; what: string };

/** a drawing on the screen, in physical screen pixels (the space of Cua's frames) */
export interface Shape {
  kind: "ring" | "box" | "circle" | "arrow" | "underline" | "label";
  x?: number; y?: number; w?: number; h?: number;
  from?: { x: number; y: number }; to?: { x: number; y: number };
  text?: string;
}

const listeners = new Set<(e: OverlayEvent) => void>();
/** what the overlay sends: a typed question, lesson keys, Esc twice, the tray's Stop, a capture */
export function onOverlay(f: (e: OverlayEvent) => void): () => void { listeners.add(f); return () => listeners.delete(f); }

export const overlayOn = (): boolean => process.platform === "win32" && process.env.OVERLAY !== "off" && existsSync(SCRIPT);

/** starts the helper ahead of time (about 1 s to start), so the first answer is immediate */
export function warmOverlay(greeting?: object): void {
  if (greeting) hello = greeting;
  if (!overlayOn() || proc) return;
  try {
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    proc = p;
    p.exited.then(() => { if (proc === p) proc = null; });
    void readEvents(p.stdout);
    if (hello) send({ cmd: "hello", ...hello });
  } catch { proc = null; }
}

/** JSON with every non-ASCII character escaped: safe whatever code page the other side reads with */
export const asciiJson = (m: object) => JSON.stringify(m).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** one message to the overlay (starts it if needed); false when there is no overlay */
export function send(m: { cmd: string; [k: string]: unknown }): boolean {
  if (!overlayOn()) return false;
  warmOverlay();
  if (!proc) return false;
  try { proc.stdin.write(asciiJson(m) + "\n"); proc.stdin.flush(); return true; } catch { return false; }
}

/** The overlay's stdout: one JSON event per line, to the listeners. Exported for tests. */
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
        let e: OverlayEvent;
        try { e = JSON.parse(line); } catch { continue; }
        for (const f of listeners) { try { f(e); } catch { /* a listener never stops the overlay */ } }
      }
    }
  } catch { /* the helper exited */ }
}

export interface ScreenCapture {
  path: string;                                   // the picture the model sees (PNG), in a temp folder
  imgW: number; imgH: number;                     // its size in pixels
  screen: { x: number; y: number; w: number; h: number };   // the screen it shows, in physical screen pixels
  cursor?: { x: number; y: number };              // where the pointer was
}

let nextId = 0;
/** the screen under the cursor, right now (the overlay's own windows are never in it); undefined without an overlay */
export function captureScreen(timeoutMs = 3000): Promise<ScreenCapture | undefined> {
  const id = `c${++nextId}`;
  return new Promise(resolve => {
    let off = () => {};
    const timer = setTimeout(() => { off(); resolve(undefined); }, timeoutMs);
    off = onOverlay(e => {
      if (e.event !== "captured" || e.id !== id) return;
      clearTimeout(timer); off();
      resolve(e.path && e.imgW && e.imgH && e.w && e.h ? {
        path: e.path, imgW: e.imgW, imgH: e.imgH, screen: { x: e.x ?? 0, y: e.y ?? 0, w: e.w, h: e.h },
        ...(typeof e.cx === "number" && typeof e.cy === "number" ? { cursor: { x: e.cx, y: e.cy } } : {}),
      } : undefined);
    });
    if (!send({ cmd: "capture", id })) { clearTimeout(timer); off(); resolve(undefined); }
  });
}

export function stopOverlay(): void { try { proc?.stdin.end(); } catch { /* gone */ } proc = null; }

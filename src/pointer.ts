// Point-and-ask: hold the push-to-talk key, point the mouse at something, ask about it.
// Everything goes through Cua, so it is the same on Windows and macOS: cursor position, the window under it, that
// window's controls (with on-screen frames) and, for Claude, a screenshot of that window only.
// Measured on Windows: cursor, window bounds and element frames share one physical-pixel space.
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandName } from "./contracts";
import { cuaCall, errorOf } from "./driver/cli";

export interface Frame { x: number; y: number; w: number; h: number }
export interface PointedElement { index: number; role: string; label: string; value?: string; frame: Frame }
export interface PointerContext {
  x: number; y: number; t: string;
  window?: { pid: number; windowId: number; title: string; app: string; bounds: { x: number; y: number; width: number; height: number } };
  element?: PointedElement;                // smallest control under the pointer
  nearby: PointedElement[];                // labelled controls near the pointer, closest first
  all: PointedElement[];                   // labelled controls of the window (for "where is ..." questions)
  screenshot?: { path: string; width: number; height: number; px: number; py: number };   // pointer position in the image
  typed?: boolean;                         // asked in the panel: the window the user was using, no pointer
}

const contains = (f: Frame, x: number, y: number) => x >= f.x && y >= f.y && x <= f.x + f.w && y <= f.y + f.h;
const dist = (f: Frame, x: number, y: number) => Math.hypot(f.x + f.w / 2 - x, f.y + f.h / 2 - y);

/** Where the pointer is right now (call it when the push-to-talk key goes down). */
export async function cursorNow(): Promise<{ x: number; y: number; t: string } | null> {
  const r = await cuaCall("get_cursor_position", {}, 4000);
  return typeof r.data?.x === "number" ? { x: r.data.x, y: r.data.y, t: new Date().toISOString() } : null;
}

/** Real windows a person can see: not Cua's cursor layer, the agent's own overlay, or invisible full-screen layers. */
function visibleWindows(lw: any): any[] {
  return (lw.data?.windows ?? [])
    .filter((w: any) => w.title && !w.minimized && w.is_on_screen !== false && w.bounds?.height > 40
      && !/^cua[.\s]/i.test(w.title) && !/cua-driver/i.test(w.app_name ?? "") && !/^agent-(mark|bubble|highlight)$/.test(w.title)
      && !/^(NVIDIA GeForce Overlay|Windows Input Experience)$/i.test(w.title) && !/^(NVIDIA Overlay|TextInputHost)\.exe$/i.test(w.app_name ?? ""))
    .sort((a: any, b: any) => (b.z_index ?? 0) - (a.z_index ?? 0));
}

/** The window and controls under a screen point. With `screenshot`, also captures that window (only) to a PNG. */
export async function lookAt(hand: HandName, at: { x: number; y: number; t: string }, opts: { screenshot?: boolean } = {}): Promise<PointerContext> {
  const lw = await cuaCall("list_windows", { session: hand });
  const under = visibleWindows(lw).find((w: any) => contains({ x: w.bounds.x, y: w.bounds.y, w: w.bounds.width, h: w.bounds.height }, at.x, at.y));
  return under ? lookAtWindow(hand, under, at, opts) : { ...at, nearby: [], all: [] };
}

/**
 * For a question typed in the panel ("describe what I'm looking at"): the window the user was using, i.e. the
 * frontmost one that is not the panel itself. The "pointer" is its centre.
 */
export async function lookBehindPanel(hand: HandName, panelTitle: RegExp, opts: { screenshot?: boolean } = {}): Promise<PointerContext> {
  const lw = await cuaCall("list_windows", { session: hand });
  const w = visibleWindows(lw).find((x: any) => !panelTitle.test(x.title) && x.title !== "Program Manager" && x.bounds.height > 100);
  const t = new Date().toISOString();
  if (!w) return { x: 0, y: 0, t, nearby: [], all: [], typed: true };
  const at = { x: Math.round(w.bounds.x + w.bounds.width / 2), y: Math.round(w.bounds.y + w.bounds.height / 2), t };
  return { ...(await lookAtWindow(hand, w, at, opts)), typed: true };
}

async function lookAtWindow(hand: HandName, under: any, at: { x: number; y: number; t: string }, opts: { screenshot?: boolean }): Promise<PointerContext> {
  const ctx: PointerContext = { ...at, nearby: [], all: [] };
  ctx.window = { pid: under.pid, windowId: under.window_id, title: under.title, app: under.app_name ?? "", bounds: under.bounds };
  const shotPath = join(tmpdir(), `agent-pointer-${Date.now()}.png`);
  const st = await cuaCall("get_window_state", {
    session: hand, pid: under.pid, window_id: under.window_id, max_elements: 1500, timeout_ms: 4000,
    include_screenshot: !!opts.screenshot, ...(opts.screenshot ? { screenshot_out_file: shotPath, max_image_dimension: 1400 } : {}),
  }, 15_000);
  if (errorOf(st.data)) return ctx;
  const els: PointedElement[] = (st.data.elements ?? [])
    .filter((e: any) => e.frame && e.frame.w > 0 && e.frame.h > 0)
    .map((e: any) => ({ index: e.element_index, role: String(e.role ?? ""), label: String(e.label ?? "").trim(), value: e.value ? String(e.value).slice(0, 300) : undefined, frame: e.frame }));
  const hits = els.filter(e => contains(e.frame, at.x, at.y) && !/^(Window|Pane|TitleBar)$/i.test(e.role));
  ctx.element = hits.sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0];
  const labelled = els.filter(e => e.label);
  ctx.nearby = labelled.filter(e => e !== ctx.element).sort((a, b) => dist(a.frame, at.x, at.y) - dist(b.frame, at.x, at.y)).slice(0, 12);
  ctx.all = labelled.slice(0, 200);
  if (opts.screenshot && st.data.screenshot_width && st.data.window_bounds?.width) {
    const b = st.data.window_bounds, scale = st.data.screenshot_width / b.width;
    ctx.screenshot = { path: shotPath, width: st.data.screenshot_width, height: st.data.screenshot_height,
      px: Math.round((at.x - b.x) * scale), py: Math.round((at.y - b.y) * scale) };
  }
  return ctx;
}

/** Glides the agent's coloured cursor to a control (the real mouse pointer is not moved). */
export async function pointAt(hand: HandName, e: PointedElement): Promise<boolean> {
  const r = await cuaCall("move_cursor", { session: hand, scope: "window", x: Math.round(e.frame.x + e.frame.w / 2), y: Math.round(e.frame.y + e.frame.h / 2) });
  return !errorOf(r.data);
}

export function describeElement(e: PointedElement | undefined): string {
  if (!e) return "nothing I can read";
  const what = e.label ? `the ${e.role.toLowerCase()} "${e.label}"` : `an unlabelled ${e.role.toLowerCase()}`;
  return e.value && e.value !== e.label ? `${what}, which shows "${e.value.slice(0, 120)}"` : what;
}

const LOOKING = /\b(what am i (looking at|seeing)|what'?s on (my|the) screen|what is on (my|the) screen|describe (what (i'?m|i am) (looking at|seeing)|(my|the) screen|this|it|the (page|window|picture|image|photo))|explain (this|my screen|what (i'?m|i am) looking at)|summari[sz]e (this|my screen|the page|this page)|read (this|my screen|the screen) (out|aloud|to me))\b/;
const DRAW = /\b(circle|draw (a |an )?(circle|box|ring|arrow|line|outline)|draw around|highlight|underline|point (to|at|out)|mark|put a box)\b/;

/**
 * Any question about the screen: pointing ("what is this?"), looking ("what am I looking at?", "describe my screen"),
 * or drawing ("circle the zebra", "highlight the cheetah and the hippo").
 */
export function isScreenQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(open|go to|search|look up|book|type|calculate|convert|move|copy|organi[sz]e|find out|send|email|play)\b/.test(t)) return false;
  if (DRAW.test(t) && /\b(in|using|with) (paint|word|powerpoint|excel|photoshop|notepad)\b/.test(t)) return false;   // a task in an app
  return isPointerQuestion(text) || LOOKING.test(t) || DRAW.test(t);
}

/** Is this utterance a question about what the user is pointing at (rather than a task to do)? */
export function isPointerQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (/^(open|go to|search|look up|book|write|type|calculate|convert|move|copy|organi[sz]e|find out|send|email|play)\b/.test(t)) return false;
  const deictic = /\b(this|that|these|those|here|over there|under (my|the) (mouse|cursor|pointer)|i'?m pointing|pointing at)\b/.test(t);
  const asks = /\?$|^(what|what's|whats|why|how|who|where|which|is|are|does|do|can|could|explain|tell me|read|translate|summari[sz]e|describe)\b/.test(t);
  // "where is the save button" is about the screen; "where is Tokyo" / "how do I get to the airport" are not.
  const ui = /\b(button|menu|tab|icon|settings?|option|toolbar|field|box|link|page|screen|window|app|setting|scroll ?bar|sidebar)\b/.test(t);
  return deictic && asks || /^(where (is|are|do i|can i)|how do i|how can i)\b/.test(t) && ui;
}

/**
 * "How do I make a pivot table?", "teach me how to ...": a how-to question that the window under the pointer gives
 * context for (Clicky's tutor case). Used only with Claude, which sees the window; travel and weather questions are
 * tasks, not screen questions.
 */
export function isTeachQuestion(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (!/^(how (do|can|should|would) i|how to|teach me|show me how|explain how|walk me through|what does .+ (do|mean))\b/.test(t)) return false;
  return !/\b(get to|get from|directions?|route|flights?|fly|weather|temperature|train to|bus to)\b/.test(t);
}

/** "where is the save button" / "how do I save" style: the user wants to be shown a control. */
export const wantsPointing = (text: string) => /^(where (is|are|do i|can i)|how do i|show me|which (button|one))\b/i.test(text.trim());

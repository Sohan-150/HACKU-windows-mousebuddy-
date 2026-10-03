// Screen questions without Claude (jev only), for explain mode: say what the control under the pointer is and read its
// text; for "where is X" jev picks the control (it is then ringed on the screen). Read-only: never clicks or types.
// Explaining and drawing freely from the picture of the screen needs Claude (explain.ts).
import { GATE, type JevExtra } from "./jev";
import { describeElement, wantsPointing, type Frame, type PointedElement, type PointerContext, type ScreenControl } from "./pointer";

/** what jevAnswer looks at: the controls on the screen (exact frames), where the pointer is, the window */
export interface ScreenView {
  controls: ScreenControl[];
  cursor?: { x: number; y: number };
  app?: string; windowTitle?: string;
  screen: Frame;
  typed?: boolean;
}

export interface JevAnswer { say: string; ring?: ScreenControl; by: "jev" | "code"; jevTokens: number }

const inside = (f: Frame, x: number, y: number) => x >= f.x && y >= f.y && x <= f.x + f.w && y <= f.y + f.h;
const dist = (f: Frame, x: number, y: number) => Math.hypot(f.x + f.w / 2 - x, f.y + f.h / 2 - y);

export async function jevAnswer(question: string, v: ScreenView, jev: { extra?: Partial<Pick<JevExtra, "pickControl">> } | null): Promise<JevAnswer> {
  const pick = jev?.extra?.pickControl?.bind(jev.extra);
  if (wantsPointing(question) && pick && v.controls.length) {
    // "where is the save button": jev picks one of the labelled controls on the screen.
    try {
      const r = await pick(question, v.controls.map(c => `${c.role} "${c.label}"`));
      const hit = r.index !== undefined && r.conf >= GATE ? v.controls[r.index] : undefined;
      if (hit) return { say: `It's ${describeElement(asElement(hit))}. I've circled it.`, ring: hit, by: "jev", jevTokens: r.inputTokens };
      return { say: `I couldn't find that on your screen.`, by: "jev", jevTokens: r.inputTokens };
    } catch { /* answer from what is under the pointer */ }
  }
  return { say: whatIsThis(question, asContext(v)), by: "code", jevTokens: 0 };
}

const asElement = (c: ScreenControl): PointedElement => ({ index: c.id, role: c.role, label: c.label, frame: c.frame });

/** the screen view as a pointer context (what whatIsThis reads) */
function asContext(v: ScreenView): PointerContext {
  const at = v.cursor ?? { x: v.screen.x + v.screen.w / 2, y: v.screen.y + v.screen.h / 2 };
  const els = v.controls.map(asElement);
  const element = v.cursor ? els.filter(e => inside(e.frame, at.x, at.y)).sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0] : undefined;
  return {
    ...at, t: new Date().toISOString(), typed: v.typed || !v.cursor,
    window: v.windowTitle ? { pid: 0, windowId: 0, title: v.windowTitle, app: v.app ?? "", bounds: { x: v.screen.x, y: v.screen.y, width: v.screen.w, height: v.screen.h } } : undefined,
    element, nearby: els.filter(e => e !== element).sort((a, b) => dist(a.frame, at.x, at.y) - dist(b.frame, at.x, at.y)).slice(0, 12), all: els,
  };
}

/** Without Claude: name the control under the pointer and read its text; say plainly what needs Claude. */
export function whatIsThis(question: string, p: PointerContext): string {
  const where = p.window ? ` in "${p.window.title}"` : "";
  // Typed in the panel, or "what am I looking at": there is no pointed-at control, so name the window.
  if (p.window && (p.typed || /\b(looking at|seeing|on (my|the) screen)\b/i.test(question))) {
    const app = p.window.app && !p.window.title.toLowerCase().includes(p.window.app.replace(/\.exe$/i, "").toLowerCase()) ? ` (${p.window.app})` : "";
    return `You're looking at "${p.window.title}"${app}. Describing what is in it needs a Claude API key.`;
  }
  const e = p.element?.label || p.element?.value ? p.element : p.nearby[0];
  if (!e) return `I can't read anything under your pointer${where}.`;
  const near = e === p.element ? "You're pointing at" : "The nearest thing I can read is";
  const text = e.value && e.value !== e.label ? e.value : e.label;
  if (/\b(read|say|says|saying|written)\b/i.test(question) && text) return `It says: ${text.slice(0, 400)}`;
  const needsClaude = /\b(explain|translate|summari[sz]e|mean|why|circle|draw|highlight)\b/i.test(question) ? " Explaining and drawing need a Claude API key." : "";
  return `${near} ${describeElement(e)}${where}.${needsClaude}`;
}

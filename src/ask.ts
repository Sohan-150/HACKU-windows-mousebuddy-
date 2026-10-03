// Point-and-ask: answers a question about what the user is pointing at (or looking at). Read-only: looks at one window,
// answers, and draws on the screen: circles, boxes, arrows or underlines around the things it talks about, and glides
// the agent's own cursor to the first. It never clicks or types.
//   Claude: sees a screenshot of that one window + its controls; may mark several controls or regions of the image.
//   jev only: says what the control under the pointer is (and reads its text); for "where is X" jev picks the control.
import { unlinkSync } from "node:fs";
import type { HandName } from "./contracts";
import type { Claude, ScreenMark, Turn } from "./claude";
import { GATE, JEV_USD_PER_INPUT_TOKEN, type JevExtra } from "./jev";
import { drawMark, type Shape } from "./overlay";
import { describeElement, lookAt, pointAt, wantsPointing, type PointedElement, type PointerContext } from "./pointer";

export interface AskDeps {
  hand: HandName;
  claude: Pick<Claude, "aboutScreen" | "usage"> | null;
  jev: { extra?: Partial<Pick<JevExtra, "pickControl">> } | null;
  conversation?: Turn[];
  look?: typeof lookAt; point?: typeof pointAt;                          // injectable for tests
  draw?: (r: PointedElement["frame"], o: { shape?: Shape; label?: string; color?: number; ms?: number }) => boolean;
}

export interface AskResult {
  answer: string; by: "claude" | "jev" | "code";
  window?: string; element?: string; pointedAt?: string; marked: string[];
  jevTokens: number; claudeUsd: number; ms: number;
}

/** `ctx` may be given when the window was already looked at (prefetched while speech was being transcribed). */
export async function askScreen(question: string, at: { x: number; y: number; t: string }, deps: AskDeps, ctx?: PointerContext): Promise<AskResult> {
  const t0 = performance.now();
  const look = deps.look ?? lookAt, point = deps.point ?? pointAt, draw = deps.draw ?? drawMark;
  const usd0 = deps.claude?.usage.usd ?? 0;
  const p = ctx ?? await look(deps.hand, at, { screenshot: !!deps.claude });
  const out: AskResult = { answer: "", by: "code", window: p.window?.title, element: p.element ? describeElement(p.element) : undefined, marked: [], jevTokens: 0, claudeUsd: 0, ms: 0 };
  const finish = (): AskResult => {
    if (p.screenshot) try { unlinkSync(p.screenshot.path); } catch { /* already gone */ }
    out.claudeUsd = (deps.claude?.usage.usd ?? 0) - usd0;
    out.ms = Math.round(performance.now() - t0);
    return out;
  };
  if (!p.window) { out.answer = "I can't see a window under your pointer. Point at something in an app or web page and ask again."; return finish(); }

  const targets: { el: PointedElement; shape: Shape; label: string }[] = [];
  if (deps.claude) {
    try {
      const r = await deps.claude.aboutScreen(question, p, deps.conversation ?? []);
      out.answer = r.answer.trim(); out.by = "claude";
      for (const m of r.marks) {
        const el = markTarget(m, p);
        if (el) targets.push({ el, shape: m.shape, label: m.label });
      }
    } catch { /* fall through to the jev answer below */ }
  }
  if (!out.answer) {
    const pick = deps.jev?.extra?.pickControl?.bind(deps.jev.extra);
    if (wantsPointing(question) && pick && p.all.length) {
      // "where is the save button": jev picks one of the window's labelled controls.
      const options = p.all.map(e => `${e.role} "${e.label}"`);
      let target: PointedElement | undefined;
      try {
        const r = await pick(question, options);
        out.jevTokens += r.inputTokens; out.by = "jev";
        if (r.index !== undefined && r.conf >= GATE && p.all[r.index]) target = p.all[r.index];
      } catch { /* answer from what is under the pointer */ }
      if (target) targets.push({ el: target, shape: "ring", label: target.label.slice(0, 24) });
      out.answer = target ? `It's ${describeElement(target)}. I've circled it and moved my cursor to it.` : `I couldn't find that in "${p.window.title}".`;
    } else {
      out.answer = whatIsThis(question, p);
    }
  }
  // Draw every mark (each its own colour), then glide the cursor to the first one.
  const ms = targets.length > 1 || targets.some(t => t.el.role === "region") ? 7000 : 3500;
  targets.forEach((t, i) => { if (draw(t.el.frame, { shape: t.shape, label: targets.length > 1 || t.el.role === "region" ? t.label : "", color: i, ms })) out.marked.push(t.label || describeElement(t.el)); });
  if (targets[0] && await point(deps.hand, targets[0].el).catch(() => false)) out.pointedAt = targets[0].el.role === "region" ? targets[0].label || "the place I marked" : describeElement(targets[0].el);
  return finish();
}

/** A mark from Claude -> something on screen: a control's frame, or a box in the window image -> screen pixels. */
export function markTarget(m: ScreenMark, p: PointerContext): PointedElement | undefined {
  if (m.control >= 0) return p.all[m.control];
  if (!m.box || !p.screenshot || !p.window) return undefined;
  const b = p.window.bounds, scale = p.screenshot.width / b.width;
  return { index: -1, role: "region", label: m.label, frame: { x: b.x + m.box.x / scale, y: b.y + m.box.y / scale, w: m.box.w / scale, h: m.box.h / scale } };
}

/** Without Claude: name the control under the pointer and read its text; say plainly what needs Claude. */
export function whatIsThis(question: string, p: PointerContext): string {
  const where = p.window ? ` in "${p.window.title}"` : "";
  const e = p.element?.label || p.element?.value ? p.element : p.nearby[0];
  if (!e) return `I can't read anything under your pointer${where}.`;
  const near = e === p.element ? "You're pointing at" : "The nearest thing I can read is";
  const text = e.value && e.value !== e.label ? e.value : e.label;
  if (/\b(read|say|says|saying|written)\b/i.test(question) && text) return `It says: ${text.slice(0, 400)}`;
  const needsClaude = /\b(explain|translate|summari[sz]e|mean|why|circle|draw|highlight)\b/i.test(question) ? " Explaining and drawing need a Claude API key." : "";
  return `${near} ${describeElement(e)}${where}.${needsClaude}`;
}

export const jevAskUsd = (r: AskResult) => r.jevTokens * JEV_USD_PER_INPUT_TOKEN;

// Explain mode (ported from the Mac version): press the talk keys, ask about anything on your screen, and Backstage
// answers out loud while it draws on top of your screen (rings, arrows, circles, underlines, labels) to show what it
// means. "How do I..." questions become a short lesson: one action per step, "next" (or Alt+Right) to continue.
//
// Privacy: the screen is captured ONLY when the talk keys go down or a question is asked (one picture of the screen
// under the cursor + the controls of the window under the cursor and the topmost window). The picture is deleted after
// the answer; the journal (runs/explain-journal.jsonl) keeps only the text.
//
// Precision: pointing does not rely on the model's pixel guess alone. The model gets the list of controls WITH their
// exact frames (UI Automation, through Cua) and points at them by id; a point it gives in the picture is snapped to the
// smallest control under it. Only when nothing is there is the drawing placed from the picture.
//
// Coordinates: physical screen pixels everywhere (the overlay is DPI-aware, and Cua's frames use the same space). The
// picture shows `screen` (a monitor, or one window when the question was typed in the panel), scaled to imgW x imgH.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jevAnswer } from "./ask";
import type { Claude, ExplainShape, Turn } from "./claude";
import type { HandName } from "./contracts";
import type { JevExtra } from "./jev";
import { RUNS_DIR } from "./logger";
import { captureScreen, type Shape } from "./overlay";
import { cursorNow, lookAt, lookBehindPanel, screenControls, type Frame, type PointerContext, type ScreenControl } from "./pointer";
import { Voice } from "./voice";

export interface Point { x: number; y: number }
export interface Capture {
  png?: string;                    // the picture the model sees (deleted after the answer)
  imgW: number; imgH: number;      // its size in pixels
  screen: Frame;                   // what it shows, in physical screen pixels
  app?: string; windowTitle?: string;
  controls: ScreenControl[];       // ids are what the model points at
  cursor?: Point;                  // where the pointer was (none when typed in the panel)
  typed?: boolean;                 // typed in the panel: the picture is the window the user was using
  ms: number;
  error?: string;
}
export interface ExplainResult {
  answer: string;                  // everything it said (all the steps of a lesson)
  steps: number; shapes: number;
  by: "claude" | "jev" | "code";
  usd: number; jevTokens: number; ms: number;
  app?: string; window?: string; error?: string;
  typed?: boolean; cursor?: Point;   // what it looked at: the window behind the panel, or the screen under this pointer
  handoff?: boolean;                 // it was a job after all: nothing was said or drawn, the agents should do it
}
export type OverlaySend = (m: { cmd: string; [k: string]: unknown }) => boolean;

export interface ExplainDeps {
  claude: Pick<Claude, "explain" | "usage"> | null;
  jev: { extra?: Partial<Pick<JevExtra, "pickControl">> } | null;
  send: OverlaySend;                                   // to the overlay; false when there is none
  speak: (text: string) => void;                       // the system voice, when there is no overlay
  hand?: HandName;                                     // the Cua session used for reading windows
  voice?: Voice;
  capture?: (cursor?: Point) => Promise<Capture>;      // injectable for tests
  ready?: () => Promise<void>;                         // starts the Cua session used for reading windows
  conversation?: () => Turn[];
  journal?: string;
}

const KINDS = ["ring", "box", "circle", "arrow", "underline", "label"] as const;
const NEXT = 'Say "next" when you\'re ready.';
// Sizes from the Mac version (screen points) scaled to typical Windows physical pixels (150% scaling).
const S = 1.5;
const ACK = /^(next|next step|continue|go on|ok|okay|done|got it|and then|then what)$/;
const AGAIN = /^(repeat|again|say that again|what|huh|sorry|come again|back|previous)$/;
const DISMISS = /^(stop|cancel|clear|never ?mind|hide|that's all|thanks|thank you)$/;

export class Explainer {
  private pending?: Promise<Capture>;
  private lesson?: { question: string; steps: { say: string; shapes: Shape[] }[]; index: number };
  private seq = 0;
  readonly voice: Voice;
  private hand: HandName;
  private journal: string;

  constructor(private deps: ExplainDeps) {
    this.voice = deps.voice ?? new Voice();
    this.hand = deps.hand ?? "Blue-9";
    this.journal = deps.journal ?? join(RUNS_DIR, "explain-journal.jsonl");
    this.voice.warm();
  }

  /** the talk keys went down: capture NOW, while the screen is as the user sees it */
  begin(cursor?: Point) {
    this.discard();
    this.pending = this.capture(cursor);
    this.pending.catch(() => {});
  }

  get inLesson() { return !!this.lesson; }

  /** words handled without looking at the screen: "never mind", and "next" / "repeat" / "back" during a lesson */
  inCode(text: string): boolean {
    const w = text.toLowerCase().replace(/[.!?,]/g, "").trim();
    return !w || DISMISS.test(w) || (!!this.lesson && (ACK.test(w) || AGAIN.test(w)));
  }

  /** move through a lesson (spoken words, or the overlay's keys: Alt + arrow) */
  go(to: "next" | "back" | "repeat"): string | undefined {
    if (!this.lesson) return undefined;
    return this.step(to === "next" ? this.lesson.index + 1 : to === "back" ? this.lesson.index - 1 : this.lesson.index);
  }

  /** end the lesson and clear the screen ("stop", or Esc twice) */
  dismiss() {
    this.lesson = undefined;
    this.seq++; // audio still on its way for the old answer is dropped
    this.deps.send({ cmd: "clear" });
  }

  /** the words were a job for the agents after all: throw away the capture taken when the keys went down */
  discard() {
    const p = this.pending;
    this.pending = undefined;
    p?.then(c => remove(c.png), () => {});
  }

  /** say something with no drawing (the agents' "On it." and their results); it stays on screen for `fadeMs` */
  say(text: string, fadeMs = 7000) { this.answer(text, [], fadeMs); }

  /** status on the buddy ("looking at your screen…") */
  status(text: string) { this.deps.send({ cmd: "status", text }); }

  /**
   * A question about the screen (spoken, typed in the overlay's box, or typed in the panel). Lesson words are handled
   * in code. `capture` overrides the picture (the panel passes the window behind it).
   */
  async ask(text: string, cursor?: Point, opts: { capture?: Promise<Capture> } = {}): Promise<ExplainResult> {
    const t0 = performance.now();
    const usd0 = this.deps.claude?.usage.usd ?? 0;
    const out: ExplainResult = { answer: "", steps: 0, shapes: 0, by: "code", usd: 0, jevTokens: 0, ms: 0 };
    const finish = () => { out.usd = (this.deps.claude?.usage.usd ?? 0) - usd0; out.ms = Math.round(performance.now() - t0); return out; };
    const q = text.trim();
    const w = q.toLowerCase().replace(/[.!?,]/g, "").trim();
    if (!q || DISMISS.test(w)) { this.discard(); this.dismiss(); out.answer = q ? "Cleared." : ""; return finish(); }
    if (this.lesson && ACK.test(w)) { this.discard(); out.answer = this.go("next") ?? ""; out.steps = 1; return finish(); }
    if (this.lesson && AGAIN.test(w)) { this.discard(); out.answer = this.go(/back|previous/.test(w) ? "back" : "repeat") ?? ""; out.steps = 1; return finish(); }

    this.status("looking at your screen…");
    const capP = opts.capture ?? this.pending ?? this.capture(cursor);
    if (opts.capture) this.discard(); else this.pending = undefined;
    const cap = await capP.catch((e): Capture => ({ imgW: 0, imgH: 0, screen: { x: 0, y: 0, w: 0, h: 0 }, controls: [], ms: 0, error: String(e?.message ?? e) }));
    if (cursor && !cap.typed) cap.cursor = cursor;     // where the pointer is now (the box was typed in near it)
    out.app = cap.app; out.window = cap.windowTitle; out.typed = cap.typed; out.cursor = cap.cursor;
    try {
      if (!this.deps.claude || !cap.png) {
        // jev only (or no picture): name what is under the pointer; for "where is X" jev picks the control.
        if (!cap.controls.length && !cap.windowTitle) {
          out.error = cap.error ?? "no capture";
          return this.fail(out, cap.typed ? "I can't see the window you were using. Click on it, then ask again." : `I couldn't see your screen (${out.error}).`, finish);
        }
        const r = await jevAnswer(q, cap, this.deps.jev);
        out.by = r.by; out.jevTokens = r.jevTokens;
        const shapes: Shape[] = r.ring ? [{ kind: "ring", ...r.ring.frame }] : [];
        this.lesson = { question: q, steps: [{ say: r.say, shapes }], index: 0 };
        out.answer = this.step(0) ?? r.say; out.steps = 1; out.shapes = shapes.length;
        this.write({ t: new Date().toISOString(), question: q, app: cap.app, window: cap.windowTitle, by: r.by, say: r.say, shapes: shapes.length, controls: cap.controls.length });
        return finish();
      }
      this.status("thinking…");
      const r = await this.think(q, cap);
      if (r.answer.task) {
        this.deps.send({ cmd: "idle" });
        out.handoff = true; out.by = "claude"; out.answer = "a job for the agents";
        return finish();
      }
      const steps = r.answer.steps.filter(s => s.say?.trim()).slice(0, 6).map(s => ({ say: s.say.trim(), shapes: (s.shapes ?? []).slice(0, 4).flatMap(m => place(m, cap)) }));
      if (!steps.length) return this.fail(out, "Sorry, I don't have an answer for that.", finish);
      this.lesson = { question: q, steps, index: 0 };
      out.by = "claude"; out.steps = steps.length; out.shapes = steps.reduce((a, s) => a + s.shapes.length, 0);
      out.answer = steps.map(s => s.say).join(" ");
      this.step(0);
      finish();
      this.write({ t: new Date().toISOString(), question: q, app: cap.app, window: cap.windowTitle, steps: steps.map(s => ({ say: s.say, shapes: s.shapes.length })), model: r.model, usd: +out.usd.toFixed(5), ms: r.ms, captureMs: cap.ms, controls: cap.controls.length });
      console.log(`[explain] "${q.slice(0, 60)}" -> ${steps.length} step(s), ${out.shapes} shape(s) · ${r.ms} ms · $${out.usd.toFixed(4)} · ${cap.controls.length} controls from ${cap.app ?? "?"}`);
      return out;
    } catch (e: any) {
      out.error = String(e?.message ?? e).slice(0, 160);
      return this.fail(out, `Sorry, I couldn't answer that: ${out.error}`, finish);
    } finally {
      remove(cap.png);
    }
  }

  private fail(out: ExplainResult, said: string, finish: () => ExplainResult): ExplainResult {
    out.answer = said;
    if (!this.deps.send({ cmd: "error", text: said })) this.deps.speak(said);
    return finish();
  }

  /** shows step i (and says it); returns what it says. Past the end: the lesson is over. */
  private step(i: number): string | undefined {
    const l = this.lesson;
    if (!l) return undefined;
    if (i >= l.steps.length) {
      this.lesson = undefined;
      const said = "That's everything. Ask me anything else.";
      this.answer(said, [], 4000);
      return said;
    }
    l.index = Math.max(0, i);
    const s = l.steps[l.index]!;
    const total = l.steps.length;
    const more = total > 1 && l.index < total - 1;
    // a lesson step stays until you continue; a single answer fades
    this.answer(this.sayFor(l.index), s.shapes, more ? 0 : 9000, total > 1 ? { index: l.index, total } : undefined);
    if (more) for (const t of this.sayFor(l.index + 1)) for (const p of Voice.parts(t)) void this.voice.speak(p); // fetch the next step while this one plays
    return s.say;
  }

  private sayFor(i: number): string[] {
    const l = this.lesson!;
    const more = l.steps.length > 1 && i < l.steps.length - 1;
    return more ? [l.steps[i]!.say, NEXT] : [l.steps[i]!.say];
  }

  /** draw now; the voice follows part by part as soon as each part's audio is ready (cached for repeat/back) */
  private answer(say: string | string[], shapes: Shape[], fadeMs: number, step?: { index: number; total: number }) {
    const seq = ++this.seq;
    const lines = typeof say === "string" ? [say] : say;
    const text = lines.join(" ");
    const voiceOn = this.voice.on;
    if (!this.deps.send({ cmd: "answer", seq, say: text, shapes, ...(step ? { step } : {}), fadeMs, audio: voiceOn ? "follows" : "system" })) {
      this.deps.speak(text);                       // no overlay: the system voice
      return;
    }
    if (!voiceOn) return;
    const parts = lines.flatMap(t => Voice.parts(t));
    const audio = parts.map(t => this.voice.speak(t)); // all requested now, sent in order
    void (async () => {
      for (const [i, p] of audio.entries()) {
        const v = await p;
        if (this.seq !== seq) return; // a newer answer took over
        const path = v.audio ? mp3File(v.audio) : undefined;
        if (path) this.deps.send({ cmd: "audio", seq, part: i, path });
        else this.deps.send({ cmd: "speak", seq, part: i, say: parts[i]! });
        console.log(`[voice] ${i + 1}/${parts.length} ${path ? (v.cached ? "already fetched" : `${v.model} ${v.ms} ms · ${v.credits} credits`) : `Windows voice (${v.error ?? "no audio"})`}`);
      }
    })();
  }

  // ---------- seeing ----------

  /** the screen under the cursor (the overlay takes the picture) + the controls the user can see */
  private async capture(cursor?: Point): Promise<Capture> {
    if (this.deps.capture) return this.deps.capture(cursor);
    const t0 = performance.now();
    const [shot] = await Promise.all([captureScreen(), this.deps.ready?.().catch(() => {})]);
    if (!shot) {
      // No overlay (OVERLAY=off): a picture of the window under the pointer, through Cua.
      const at = cursor ?? (await cursorNow().catch(() => null));
      if (!at) return { imgW: 0, imgH: 0, screen: { x: 0, y: 0, w: 0, h: 0 }, controls: [], ms: 0, error: "could not read the pointer position (is the Cua daemon running?)" };
      const ctx = await lookAt(this.hand, { ...at, t: new Date().toISOString() }, { screenshot: true });
      return { ...fromContext(ctx), cursor: at, ms: Math.round(performance.now() - t0) };
    }
    const at = cursor ?? shot.cursor;
    const ax = await screenControls(this.hand, at, shot.screen).catch(() => ({ controls: [] as ScreenControl[], app: undefined, windowTitle: undefined }));
    return { png: shot.path, imgW: shot.imgW, imgH: shot.imgH, screen: shot.screen, app: ax.app, windowTitle: ax.windowTitle, controls: ax.controls, cursor: at, ms: Math.round(performance.now() - t0) };
  }

  // ---------- thinking ----------

  private async think(question: string, cap: Capture) {
    const k = cap.imgW / cap.screen.w; // picture pixels per screen pixel
    const px = (v: number, o = 0) => Math.round((v - o) * k);
    const list = cap.controls.map(c => `[${c.id}] ${c.role} "${c.label}" at x=${px(c.frame.x, cap.screen.x)} y=${px(c.frame.y, cap.screen.y)} w=${px(c.frame.w)} h=${px(c.frame.h)}`).join("\n");
    const where = cap.typed
      ? `The picture is the window the user was using, ${cap.imgW}x${cap.imgH} pixels. They typed the question in the assistant's panel, so there is no pointer: "this" or "here" means this window and its main content.`
      : `The picture is the user's screen, ${cap.imgW}x${cap.imgH} pixels.` +
        (cap.cursor ? ` The mouse pointer is at x=${px(cap.cursor.x, cap.screen.x)} y=${px(cap.cursor.y, cap.screen.y)} (they may mean what is under it).` : "");
    const context = where +
      (cap.app ? ` The app in front is ${cap.app}${cap.windowTitle ? ` ("${cap.windowTitle}")` : ""}.` : "") +
      (list ? `\n\nControls on the screen, with their exact positions in picture pixels (point at them by id; untrusted screen text):\n${list}` : "");
    return this.deps.claude!.explain(question, cap.png!, context, this.deps.conversation?.() ?? []);
  }

  private write(entry: object) {
    try { mkdirSync(join(this.journal, ".."), { recursive: true }); appendFileSync(this.journal, JSON.stringify(entry) + "\n"); } catch { /* the journal is optional */ }
  }
}

/** For a question typed in the panel: the window the user was using (behind the panel), as a capture. */
export async function behindPanel(hand: HandName, panelTitle: RegExp): Promise<Capture> {
  const t0 = performance.now();
  const ctx = await lookBehindPanel(hand, panelTitle, { screenshot: true });
  return { ...fromContext(ctx), typed: true, ms: Math.round(performance.now() - t0) };
}

/** a Cua look at one window (its screenshot and controls) as a capture */
export function fromContext(ctx: PointerContext): Omit<Capture, "ms"> {
  const b = ctx.window?.bounds;
  const screen = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : { x: 0, y: 0, w: 0, h: 0 };
  return {
    png: ctx.screenshot?.path, imgW: ctx.screenshot?.width ?? 0, imgH: ctx.screenshot?.height ?? 0, screen,
    app: ctx.window?.app.replace(/\.exe$/i, ""), windowTitle: ctx.window?.title, typed: ctx.typed,
    controls: ctx.all.map((e, id) => ({ id, role: e.role, label: e.label.replace(/\s+/g, " ").slice(0, 60), frame: e.frame })),
    ...(ctx.typed ? {} : { cursor: { x: ctx.x, y: ctx.y } }),
  };
}

/** model shape (picture pixels or a control id) -> screen pixels, snapped to a real control when possible. Exported for tests. */
export function place(m: ExplainShape, cap: Pick<Capture, "imgW" | "screen" | "controls">): Shape[] {
  const one = placeOne(m, cap);
  if (!one) return [];
  // an underline over several lines of text: one line under EACH text run it covers (exact frames from the tree)
  if (one.kind === "underline" && !(m.control >= 0) && one.h! > 26 * S) {
    const r = { x: one.x!, y: one.y!, w: one.w!, h: one.h! };
    const runs = cap.controls.filter(c => {
      if (c.role !== "Text" && c.role !== "Hyperlink") return false;
      const f = c.frame;
      const ix = Math.max(0, Math.min(f.x + f.w, r.x + r.w) - Math.max(f.x, r.x));
      const iy = Math.max(0, Math.min(f.y + f.h, r.y + r.h) - Math.max(f.y, r.y));
      return ix * iy >= 0.5 * f.w * f.h && f.h < 40 * S;
    });
    // merge runs on the same line into one underline per line
    const lines = new Map<number, Frame>();
    for (const c of runs) {
      const key = Math.round((c.frame.y + c.frame.h) / (6 * S));
      const l = lines.get(key);
      lines.set(key, l ? { x: Math.min(l.x, c.frame.x), y: Math.min(l.y, c.frame.y), w: Math.max(l.x + l.w, c.frame.x + c.frame.w) - Math.min(l.x, c.frame.x), h: Math.max(l.h, c.frame.h) } : { ...c.frame });
    }
    if (lines.size) {
      const sorted = [...lines.values()].sort((a, b) => a.y - b.y);
      return sorted.map((f, i) => ({ kind: "underline" as const, ...f, text: i === sorted.length - 1 ? one.text : undefined }));
    }
  }
  return [one];
}

function placeOne(m: ExplainShape, cap: Pick<Capture, "imgW" | "screen" | "controls">): Shape | undefined {
  if (!KINDS.includes(m.kind as any) || !cap.imgW || !cap.screen.w) return undefined;
  const k = cap.screen.w / cap.imgW; // screen pixels per picture pixel
  const X = (v: number) => cap.screen.x + v * k, Y = (v: number) => cap.screen.y + v * k;
  const ctl = m.control >= 0 ? cap.controls.find(c => c.id === m.control) : undefined;
  let rect: Frame | undefined = ctl?.frame;
  let pt: Point | undefined;
  if (!rect && m.x >= 0 && m.y >= 0) {
    if (m.w > 0 && m.h > 0) rect = { x: X(m.x), y: Y(m.y), w: m.w * k, h: m.h * k };
    else pt = { x: X(m.x), y: Y(m.y) };
  }
  // a point (or a small region) inside a known control snaps to that control's exact frame
  if (!ctl && (m.kind === "ring" || m.kind === "underline" || m.kind === "circle") && (pt || (rect && rect.w * rect.h < 160 * S * 60 * S))) {
    const c = pt ?? { x: rect!.x + rect!.w / 2, y: rect!.y + rect!.h / 2 };
    const under = cap.controls.filter(x => c.x >= x.frame.x && c.x <= x.frame.x + x.frame.w && c.y >= x.frame.y && c.y <= x.frame.y + x.frame.h)
      .sort((a, b) => a.frame.w * a.frame.h - b.frame.w * b.frame.h)[0];
    if (under) { rect = under.frame; pt = undefined; }
  }
  if (!rect && pt) rect = { x: pt.x - 20 * S, y: pt.y - 20 * S, w: 40 * S, h: 40 * S };
  if (!rect) return undefined;
  const s = cap.screen;
  const r: Frame = { x: Math.max(s.x, Math.min(rect.x, s.x + s.w - 4)), y: Math.max(s.y, Math.min(rect.y, s.y + s.h - 4)), w: Math.max(4, rect.w), h: Math.max(4, rect.h) };
  const text = m.text?.trim().slice(0, 80) || undefined;
  if (m.kind === "arrow") {
    const to = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    const from = m.from_x >= 0 && m.from_y >= 0 ? { x: X(m.from_x), y: Y(m.from_y) } : { x: Math.max(s.x + 40 * S, to.x - 140 * S), y: Math.max(s.y + 40 * S, to.y - 110 * S) };
    return { kind: "arrow", from, to, text };
  }
  if (m.kind === "label") return { kind: "label", x: r.x + r.w / 2, y: r.y + r.h / 2, text: text ?? "" };
  return { kind: m.kind, x: r.x, y: r.y, w: r.w, h: r.h, text };
}

function remove(f?: string) { if (f) try { rmSync(f); } catch { /* already gone */ } }

let mp3n = 0;
/** the overlay plays the file, then deletes it */
function mp3File(audio: Uint8Array): string | undefined {
  try {
    const dir = join(tmpdir(), "backstage-voice");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `say-${Date.now()}-${++mp3n}.mp3`);
    writeFileSync(path, audio);
    return path;
  } catch { return undefined; }
}

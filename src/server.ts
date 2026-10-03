// Panel server: SSE /events; tasks (typed or spoken) run one at a time; approvals; stop; past runs.
// Voice (hold the push-to-talk key, speak, release):
//   a question about what the pointer is on ("what is this?", "where is save?"), or with Claude a how-to question
//   ("how do I make a pivot table?") -> answered at once from the window under the pointer, read-only;
//   "stop" -> stops the running task; "yes"/"no" -> answers the one pending approval;
//   anything else -> runs as a task (VOICE_MODE=draft puts it in the instruction box instead).
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { newTask, runTask, type ClaudeLike, type JevLike } from "./agent";
import { askScreen, jevAskUsd } from "./ask";
import type { Claude, Turn } from "./claude";
import type { ApprovalRequest, Driver, FileAction, HandName, LogLine, Task } from "./contracts";
import type { VoiceEvent } from "./intake";
import { undoMoves } from "./files";
import { JsonlLogger, newRunId, RUNS_DIR } from "./logger";
import { cursorNow, isPointerQuestion, isTeachQuestion, lookAt, pointAt, type PointerContext } from "./pointer";
import { speak, stopSpeaking } from "./speak";

export type AppClaude = ClaudeLike & Partial<Pick<Claude, "aboutScreen">>;
export type AppJev = JevLike;
type Point = { x: number; y: number; t: string };

type AppEvent =
  | { type: "state"; state: ReturnType<App["snapshot"]> }
  | { type: "voice"; voice: VoiceEvent }
  | { type: "status"; text: string }
  | LogLine;

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const POINTER_HAND: HandName = "Blue-9";      // its own cursor colour and session, so asks never disturb a running task
const STOP_WORDS = /^(stop|cancel|stop it|stop that|never ?mind|abort)[.!]*$/i;
const YES = /^(yes|yeah|yep|approve|approved|go ahead|do it|ok(ay)?|sure)\b/i, NO = /^(no|nope|deny|denied|don'?t|do not)\b/i;

export class App {
  tasks: Task[] = [];
  running?: Task;
  abort?: AbortController;
  approvals = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; timer: Timer }>();
  notices: { level: string; text: string }[] = [];
  voiceInfo = "voice off";
  draft = "";                          // last dictated instruction, shown in the box for the user to send
  lastMoves: { taskId: string; actions: FileAction[] } | null = null;    // for "undo last file moves"
  turns: Turn[] = [];                  // finished tasks and answers, for follow-ups ("write that in Notepad")
  voiceMode: "run" | "draft" = process.env.VOICE_MODE === "draft" ? "draft" : "run";
  private pointerDown?: Promise<Point | null>;
  private prefetch?: Promise<{ at: Point; ctx: PointerContext } | null>;
  private clients = new Set<(e: AppEvent) => void>();

  constructor(public driver: Driver, public claude: AppClaude | null, public jev: AppJev | null, public hand: HandName = "Mint-3") {}

  snapshot() {
    return {
      tasks: this.tasks.slice(-30), running: this.running?.id ?? null, approvals: [...this.approvals.values()].map(a => a.req),
      deciders: { jev: !!this.jev, claude: !!this.claude }, driver: this.driver.caps.name, notices: this.notices.slice(-4),
      voice: this.voiceInfo, voiceMode: this.voiceMode, draft: this.draft, canUndo: !!this.lastMoves,
    };
  }
  emit(e: AppEvent) { for (const f of this.clients) f(e); }
  pushState() { this.emit({ type: "state", state: this.snapshot() }); }
  notice(level: "info" | "warn" | "error", text: string) { this.notices.push({ level, text }); this.pushState(); }

  onVoice(v: VoiceEvent) {
    this.emit({ type: "voice", voice: v });
    if (v.event === "down") {
      stopSpeaking();
      this.pointerDown = this.driver.caps.platform === "sim" ? Promise.resolve(null) : cursorNow().catch(() => null);
      void this.buddy();
    } else if (v.event === "up") {
      // Look at the window under the pointer while the speech is being transcribed (both take ~1-3 s).
      this.prefetch = this.lookUnderPointer();
    } else if (v.event === "transcript" && v.text.trim()) void this.onSpoken(v.text.trim());
    else if (v.event === "error") this.notice("warn", `voice: ${v.msg}`);
    else if (v.event === "ready") this.pushState();
  }

  /** While you talk, the agent's cursor glides next to your pointer (Clicky's buddy), so you know it is listening. */
  private async buddy() {
    try {
      const at = await this.pointerDown;
      if (!at) return;
      await this.driver.ensureSession(POINTER_HAND);
      await pointAt(POINTER_HAND, { index: -1, role: "", label: "", frame: { x: at.x + 35, y: at.y + 12, w: 0, h: 0 } });
    } catch { /* only a visual cue */ }
  }

  private async lookUnderPointer(): Promise<{ at: Point; ctx: PointerContext } | null> {
    if (this.driver.caps.platform === "sim") return null;
    try {
      const at = (await cursorNow().catch(() => null)) ?? (await this.pointerDown);
      if (!at) return null;
      await this.driver.ensureSession(POINTER_HAND);
      return { at, ctx: await lookAt(POINTER_HAND, at, { screenshot: !!this.claude?.aboutScreen }) };
    } catch { return null; }
  }

  /** What to do with one spoken utterance. */
  async onSpoken(text: string) {
    const pre = this.prefetch;
    this.prefetch = undefined;
    const pending = [...this.approvals.values()];
    if (STOP_WORDS.test(text)) { this.stop(); speak("Stopped."); return discard(pre); }
    if (pending.length === 1 && (YES.test(text) || NO.test(text))) {
      const ok = YES.test(text);
      this.answer(pending[0].req.id, ok);
      speak(ok ? "Okay." : "Okay, I won't.");
      return discard(pre);
    }
    if (isPointerQuestion(text) || (this.claude?.aboutScreen && isTeachQuestion(text))) {
      const p = await pre;
      if (p) { await this.askAbout(text, p.at, "voice", p.ctx); return; }
      const at = await this.pointerDown;
      if (at) { await this.askAbout(text, at, "voice"); return; }
    }
    void discard(pre);
    if (this.voiceMode === "draft") { this.draft = text; this.pushState(); return; }
    this.add(text, "voice");
  }

  /** Answers a question about what is under a screen point. Read-only; recorded as a finished task. */
  async askAbout(question: string, at: Point, source: Task["source"], ctx?: PointerContext): Promise<Task> {
    const t = newTask(question, source);
    t.status = "running"; t.startedAt = new Date().toISOString();
    this.tasks.push(t);
    this.pushState();
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => this.emit(l)]));
    try {
      if (!ctx) await this.driver.ensureSession(POINTER_HAND);
      const claude = this.claude?.aboutScreen ? this.claude as Pick<Claude, "aboutScreen" | "usage"> : null;
      const r = await askScreen(question, at, { hand: POINTER_HAND, claude, jev: this.jev, conversation: this.turns.slice(-5) }, ctx);
      t.status = "done";
      t.result = { answer: r.answer, evidence: `pointer at ${at.x},${at.y}${r.window ? ` in "${r.window}"` : ""}${r.element ? ` on ${r.element}` : ""}; answered by ${r.by}${r.pointedAt ? `; moved my cursor to ${r.pointedAt}` : ""}` };
      t.counts.jev = r.jevTokens ? 1 : 0; t.counts.claude = r.by === "claude" ? 1 : 0;
      t.cost = { jevUsd: jevAskUsd(r), claudeUsd: r.claudeUsd };
      log.write({ type: "ask", runId: log.runId, t: new Date().toISOString(), taskId: t.id, question, window: r.window, element: r.element, answer: r.answer, by: r.by, pointedAt: r.pointedAt, ms: r.ms });
      this.turns.push({ instruction: question, answer: r.answer });
      speak(r.answer);
    } catch (e) {
      t.status = "failed";
      t.exception = { code: "driver_refused", reason: `could not look at the screen: ${(e as Error).message}` };
      speak("Sorry, I couldn't look at that.");
    }
    t.endedAt = new Date().toISOString();
    log.write({ type: "task_end", runId: log.runId, t: t.endedAt, task: t });
    this.pushState();
    return t;
  }

  add(instruction: string, source: Task["source"]): Task {
    const t = newTask(instruction, source);
    this.tasks.push(t);
    if (source === "voice" || instruction === this.draft) this.draft = "";
    this.pushState();
    void this.pump();
    return t;
  }

  /** Runs queued tasks one at a time. */
  private async pump() {
    if (this.running) return;
    const next = this.tasks.find(t => t.status === "queued");
    if (!next) return;
    this.running = next;
    this.abort = new AbortController();
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => {
      if (l.type === "files" && l.actions.some(a => a.kind === "move")) this.lastMoves = { taskId: l.taskId, actions: l.actions };
      this.emit(l);
    }]));
    const upd = (t: Task) => { const i = this.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.tasks[i] = t; };
    next.status = "planning";
    this.pushState();
    try {
      const done = await runTask(next, {
        driver: this.driver, claude: this.claude, jev: this.jev, log, signal: this.abort.signal, hand: this.hand,
        approve: req => this.ask(req),
        onStatus: text => this.emit({ type: "status", text }),
        conversation: this.turns.slice(-5),
      });
      upd(done);
      if (done.status === "done" && done.result) this.turns.push({ instruction: done.instruction, answer: done.result.answer });
      if (done.source === "voice") {
        speak(done.status === "done" ? done.result?.answer || "Done."
          : done.exception?.code === "needs_info" ? done.exception.reason
          : done.status === "stopped" ? "" : `I couldn't finish that. ${done.exception?.reason ?? ""}`);
      }
    } catch (e) {
      upd({ ...next, status: "failed", exception: { code: "model_error", reason: (e as Error).message } });
    } finally {
      this.running = undefined;
      for (const [, a] of this.approvals) { clearTimeout(a.timer); a.resolve(false); }
      this.approvals.clear();
      this.pushState();
      void this.pump();
    }
  }

  private ask(req: ApprovalRequest): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(req.id, false), APPROVAL_TIMEOUT_MS);
      this.approvals.set(req.id, { req, resolve, timer });
      this.pushState();
      if (this.running?.source === "voice") speak(`I need your okay to ${req.action}. Hold the talk key and say yes or no, or use the panel.`);
      // A stop cancels the pending approval too.
      this.abort?.signal.addEventListener("abort", () => this.answer(req.id, false), { once: true });
    });
  }

  answer(id: string, ok: boolean) {
    const a = this.approvals.get(id);
    if (!a) return false;
    clearTimeout(a.timer);
    this.approvals.delete(id);
    a.resolve(ok);
    this.pushState();
    return true;
  }

  stop() {
    this.abort?.abort();
    for (const t of this.tasks) if (t.status === "queued") t.status = "stopped";
    this.pushState();
  }

  clear() {
    this.tasks = this.tasks.filter(t => t === this.running);
    this.notices = this.notices.filter(n => n.level === "error");
    this.pushState();
  }

  serve(port: number) {
    const html = join(import.meta.dir, "..", "viewer", "index.html");
    const json = (x: unknown, status = 200) => Response.json(x, { status, headers: { "Cache-Control": "no-store" } });
    return Bun.serve({
      port, hostname: "127.0.0.1", idleTimeout: 0,
      fetch: async req => {
        const url = new URL(req.url), p = url.pathname;
        if (req.method === "GET" && p === "/") return new Response(readFileSync(html), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        if (req.method === "GET" && p === "/events") {
          let send: (e: AppEvent) => void;
          const stream = new ReadableStream({
            start: ctrl => {
              const enc = new TextEncoder();
              send = e => { try { ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)); } catch { this.clients.delete(send); } };
              this.clients.add(send);
              send({ type: "state", state: this.snapshot() });
            },
            cancel: () => { this.clients.delete(send); },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" } });
        }
        const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        if (req.method === "POST" && p === "/api/tasks") {
          const text = String(body.text ?? "").trim();
          if (!text) return json({ error: "empty instruction" }, 400);
          if (text.length > 2000) return json({ error: "instruction too long" }, 400);
          return json(this.add(text, body.source === "voice" ? "voice" : "typed"));
        }
        if (req.method === "POST" && p === "/api/ask") {
          // Point-and-ask without voice: explicit x,y (tests), or wherever the pointer is after a short countdown.
          const text = String(body.text ?? "").trim();
          if (!text || text.length > 500) return json({ error: "ask a question (up to 500 characters)" }, 400);
          let at: Point | null = Number.isFinite(body.x) && Number.isFinite(body.y) ? { x: Math.round(body.x), y: Math.round(body.y), t: new Date().toISOString() } : null;
          if (!at) {
            await Bun.sleep(Math.min(Math.max(Number(body.delayMs ?? 3000) || 0, 0), 8000));
            at = await cursorNow().catch(() => null);
          }
          if (!at) return json({ error: "could not read the pointer position (is the Cua daemon running?)" }, 503);
          return json(await this.askAbout(text, at, "typed"));
        }
        let m: RegExpMatchArray | null;
        if (req.method === "POST" && (m = p.match(/^\/api\/approvals\/([\w-]+)$/))) return json({ ok: this.answer(m[1], body.approve === true) });
        if (req.method === "POST" && p === "/api/stop") { this.stop(); return json({ ok: true }); }
        if (req.method === "POST" && p === "/api/clear") { this.clear(); return json({ ok: true }); }
        if (req.method === "POST" && p === "/api/undo-moves") {
          if (!this.lastMoves || this.running) return json({ ok: false, error: this.running ? "a task is running" : "nothing to undo" }, 400);
          const res = undoMoves(this.lastMoves.actions);
          this.lastMoves = null;
          const bad = res.filter(r => !r.ok);
          this.notice(bad.length ? "warn" : "info", `Undo: moved ${res.length - bad.length} file(s) back${bad.length ? `; ${bad.length} could not be: ${bad.slice(0, 2).map(b => b.detail).join("; ")}` : ""}.`);
          return json({ ok: true, results: res });
        }
        if (req.method === "GET" && p === "/api/runs") {
          return json(existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR).filter(n => n.startsWith("r-")).sort().reverse() : []);
        }
        if (req.method === "GET" && (m = p.match(/^\/api\/runs\/(r-[\w-]+)$/))) {
          const f = join(RUNS_DIR, m[1], "steps.jsonl");
          return existsSync(f) ? new Response(readFileSync(f), { headers: { "Content-Type": "application/x-ndjson" } }) : json({ error: "no such run" }, 404);
        }
        return json({ error: "not found" }, 404);
      },
    });
  }
}

/** A prefetched look that was not needed: remove its screenshot. */
async function discard(pre?: Promise<{ ctx: PointerContext } | null>) {
  const p = await pre?.catch(() => null);
  if (p?.ctx.screenshot) try { unlinkSync(p.ctx.screenshot.path); } catch { /* gone */ }
}

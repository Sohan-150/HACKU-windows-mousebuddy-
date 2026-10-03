// Panel server: SSE /events; tasks (typed or spoken); approvals; stop; past runs.
// Tasks start at once and share the computer: each part takes what it needs (the agent's browser, the desktop-app
// hand, Word, the files; see lanes.ts), so a web task runs while an app task waits on a download, and a task that needs
// something in use waits its turn (the bubble says what it is waiting for).
// Voice (hold the push-to-talk keys, speak, release):
//   a question about the screen ("what is this?", "what am I looking at?", "circle the zebra", "where is save?"), or
//   with Claude a how-to question ("how do I make a pivot table?") -> answered at once from the window under the
//   pointer, read-only; "stop" -> stops the running task; "yes"/"no" -> answers the one pending approval;
//   anything else -> runs as a task (VOICE_MODE=draft puts it in the instruction box instead).
// The same screen questions typed in the panel are answered from the window the user was using (behind the panel).
// Answers also appear in a small bubble on the screen (Windows overlay), so nobody has to switch to the panel.
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { newTask, runTask, type ClaudeLike, type JevLike } from "./agent";
import { askScreen, jevAskUsd, type AskResult } from "./ask";
import type { Claude, Turn } from "./claude";
import type { ApprovalRequest, Driver, FileAction, HandName, LogLine, Task } from "./contracts";
import type { VoiceEvent } from "./intake";
import { undoMoves } from "./files";
import { Locks } from "./lanes";
import { JsonlLogger, newRunId, RUNS_DIR } from "./logger";
import { hideBubble, onBubbleClosed, showBubble } from "./overlay";
import { cursorNow, isScreenQuestion, isTeachQuestion, lookAt, lookBehindPanel, pointAt, type PointerContext } from "./pointer";
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
const PANEL_TITLE = /^Background Agent\b/;    // the panel's browser window (viewer/index.html <title>): never what a typed question is about
const STOP_WORDS = /^(stop|cancel|stop it|stop that|never ?mind|abort)[.!]*$/i;
const YES = /^(yes|yeah|yep|approve|approved|go ahead|do it|ok(ay)?|sure)\b/i, NO = /^(no|nope|deny|denied|don'?t|do not)\b/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Progress lines worth showing on the screen (the panel shows every status).
const NOISE = /(?:reading the window|deciding|^idle)$/;

export class App {
  tasks: Task[] = [];
  running = new Map<string, { task: Task; abort: AbortController }>();
  locks = new Locks();                 // the browser, the app hand, Word, the files: shared by every task
  approvals = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; timer: Timer }>();
  notices: { level: string; text: string }[] = [];
  voiceInfo = "voice off";
  draft = "";                          // last dictated instruction, shown in the box for the user to send
  lastMoves: { taskId: string; actions: FileAction[] } | null = null;    // for "undo last file moves"
  turns: Turn[] = [];                  // finished tasks and answers, for follow-ups ("write that in Notepad")
  voiceMode: "run" | "draft" = process.env.VOICE_MODE === "draft" ? "draft" : "run";
  private pointerDown?: Promise<Point | null>;
  private prefetch?: Promise<{ at: Point; ctx: PointerContext } | null>;
  private listening = false;           // between key down and the transcript: voice errors then go in the bubble
  private listenTimer?: Timer;
  private progress = new Map<string, Map<string, string>>();    // task -> part ("" for one part) -> what it is doing
  private recent: { text: string; until: number }[] = [];       // results of tasks that ended while others still run
  private bubbleTimer?: Timer;
  private heldUntil = 0;               // an answer or "Thinking…" the user should read keeps progress off the bubble until then
  private progressMuted = false;       // the user clicked the progress bubble away: quiet until a task starts or ends
  private clients = new Set<(e: AppEvent) => void>();

  constructor(public driver: Driver, public claude: AppClaude | null, public jev: AppJev | null, public hand: HandName = "Mint-3") {
    onBubbleClosed(() => { if (this.running.size) this.progressMuted = true; });
  }

  snapshot() {
    return {
      tasks: this.tasks.slice(-30), running: [...this.running.keys()], approvals: [...this.approvals.values()].map(a => a.req),
      progress: Object.fromEntries([...this.progress].map(([id, parts]) => [id, [...parts].map(([part, text]) => part ? `${part}: ${text}` : text).join("\n")])),
      deciders: { jev: !!this.jev, claude: !!this.claude }, driver: this.driver.caps.name, notices: this.notices.slice(-4),
      voice: this.voiceInfo, voiceMode: this.voiceMode, draft: this.draft, canUndo: !!this.lastMoves,
    };
  }
  get busy(): boolean { return this.running.size > 0; }
  emit(e: AppEvent) { for (const f of this.clients) f(e); }
  pushState() { this.emit({ type: "state", state: this.snapshot() }); }
  notice(level: "info" | "warn" | "error", text: string) { this.notices.push({ level, text }); this.pushState(); }

  onVoice(v: VoiceEvent) {
    this.emit({ type: "voice", voice: v });
    if (v.event === "down") {
      stopSpeaking();
      this.listening = true;
      this.pointerDown = this.driver.caps.platform === "sim" ? Promise.resolve(null) : cursorNow().catch(() => null);
      void this.buddy();
      // Status in the corner, away from what is being pointed at (the answer comes next to the pointer). Shown after a
      // moment (longer than voice.py's 400 ms minimum hold), so a shortcut or a tap, which cancels, does not flash it.
      clearTimeout(this.listenTimer);
      this.listenTimer = setTimeout(() => showBubble("Listening… point at what you mean, then let go.", { title: "Listening", ms: 30_000 }), 450);
    } else if (v.event === "up") {
      clearTimeout(this.listenTimer);
      // Look at the window under the pointer while the speech is being transcribed (both take ~1-3 s).
      this.prefetch = this.lookUnderPointer();
      showBubble("Thinking…", { title: "Got it", ms: 20_000 });
      this.hold(5000);
    } else if (v.event === "cancel") {
      clearTimeout(this.listenTimer);
      this.listening = false;
      if (this.running.size) this.refreshBubble(0); else hideBubble();
    } else if (v.event === "transcript" && v.text.trim()) {
      this.listening = false;
      void this.onSpoken(v.text.trim());
    } else if (v.event === "error") {
      this.notice("warn", `voice: ${v.msg}`);
      if (this.listening) showBubble(v.msg, { title: "Voice", ms: 6000 });
      this.listening = false;
    } else if (v.event === "ready") this.pushState();
  }

  /** Is this utterance or typed instruction a question about the screen (answered from the window, not run as a task)? */
  isScreenAsk(text: string): boolean {
    return isScreenQuestion(text) || (!!this.claude?.aboutScreen && isTeachQuestion(text));
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
    if (STOP_WORDS.test(text)) { this.stop(); speak("Stopped."); showBubble("Stopped.", { title: "Agent", ms: 2500 }); this.hold(2500); return discard(pre); }
    if (pending.length && (YES.test(text) || NO.test(text))) {
      // The oldest question first (several tasks can be waiting for an okay).
      const ok = YES.test(text), req = pending[0].req;
      this.answer(req.id, ok);
      const said = ok ? (pending.length > 1 ? `Okay: ${req.action}.` : "Okay.") : (pending.length > 1 ? `Okay, I won't: ${req.action}.` : "Okay, I won't.");
      speak(said);
      showBubble(said, { title: "Agent", ms: 2500 });
      this.hold(2500);
      return discard(pre);
    }
    if (this.isScreenAsk(text)) {
      const p = await pre;
      if (p) { await this.askAbout(text, p.at, "voice", p.ctx); return; }
      const at = await this.pointerDown;
      if (at) { await this.askAbout(text, at, "voice"); return; }
    }
    void discard(pre);
    if (this.voiceMode === "draft") {
      this.draft = text; this.pushState();
      showBubble(`"${text}" is in the box on the panel: press Run to do it.`, { title: "Heard", ms: 6000 });
      return;
    }
    this.add(text, "voice");
  }

  /** Answers a question about the screen: the window under `at`, or (typed, no point) the window behind the panel. */
  askAbout(question: string, at: Point | null, source: Task["source"], ctx?: PointerContext): Promise<Task> {
    return this.startAsk(question, at, source, ctx).done;
  }

  /** Records the question as a task at once (the panel shows it) and answers it in the background. Read-only. */
  private startAsk(question: string, at: Point | null, source: Task["source"], ctx?: PointerContext): { task: Task; done: Promise<Task> } {
    const t = newTask(question, source);
    t.status = "running"; t.startedAt = new Date().toISOString();
    this.tasks.push(t);
    this.pushState();
    return { task: t, done: this.answerAsk(t, at, ctx) };
  }

  private async answerAsk(t: Task, at: Point | null, ctx?: PointerContext): Promise<Task> {
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => this.emit(l)]));
    try {
      const r = await this.screenAnswer(t.instruction, at, ctx);
      t.status = "done";
      t.result = { answer: r.answer, evidence: r.evidence };
      t.counts.jev = r.jevTokens ? 1 : 0; t.counts.claude = r.by === "claude" ? 1 : 0;
      t.cost = { jevUsd: jevAskUsd(r), claudeUsd: r.claudeUsd };
      log.write({ type: "ask", runId: log.runId, t: new Date().toISOString(), taskId: t.id, question: t.instruction, window: r.window, element: r.element, answer: r.answer, by: r.by, pointedAt: r.pointedAt, ms: r.ms });
      this.turns.push({ instruction: t.instruction, answer: r.answer });
      speak(r.answer);
    } catch (e) {
      t.status = "failed";
      t.exception = { code: "driver_refused", reason: `could not look at the screen: ${(e as Error).message}` };
      speak("Sorry, I couldn't look at that.");
      showBubble(`Sorry, I couldn't look at that: ${(e as Error).message}`, { title: "Agent", ms: 6000 });
    }
    t.endedAt = new Date().toISOString();
    log.write({ type: "task_end", runId: log.runId, t: t.endedAt, task: t });
    this.pushState();
    return t;
  }

  /**
   * Looks at the window (under `at`, or behind the panel when the question was typed), answers, draws the marks, and
   * shows the answer in the bubble: next to the pointer, or in the corner when there is no pointer or marks are drawn
   * (so the bubble never covers them).
   */
  private async screenAnswer(question: string, at: Point | null, ctx?: PointerContext): Promise<AskResult & { evidence: string }> {
    const claude = this.claude?.aboutScreen ? this.claude as Pick<Claude, "aboutScreen" | "usage"> : null;
    if (!ctx) await this.driver.ensureSession(POINTER_HAND);
    const p = ctx ?? (at ? await lookAt(POINTER_HAND, at, { screenshot: !!claude })
      : await lookBehindPanel(POINTER_HAND, PANEL_TITLE, { screenshot: !!claude }));
    const r = await askScreen(question, at ?? { x: p.x, y: p.y, t: p.t }, { hand: POINTER_HAND, claude, jev: this.jev, conversation: this.turns.slice(-5) }, p);
    showBubble(r.answer, { at: at && !r.marked.length ? at : null, title: "Answer" });
    this.hold(Math.min(25_000, 5000 + r.answer.length * 55));
    const evidence = `${at ? `pointer at ${at.x},${at.y}` : "typed: the window behind the panel"}${r.window ? ` in "${r.window}"` : ""}${at && r.element ? ` on ${r.element}` : ""}; answered by ${r.by}${r.marked.length ? `; marked ${r.marked.join(", ")}` : ""}${r.pointedAt ? `; moved my cursor to ${r.pointedAt}` : ""}`;
    return { ...r, evidence };
  }

  add(instruction: string, source: Task["source"]): Task {
    // A screen question ("what am I looking at?", "circle the zebra") is answered from the window, not planned as a task.
    // (Typed how-to questions stay with the planner: "how do I renew my passport" needs no screenshot.)
    if (this.driver.caps.platform !== "sim" && isScreenQuestion(instruction)) {
      if (instruction === this.draft) this.draft = "";
      return this.startAsk(instruction, null, source).task;
    }
    const t = newTask(instruction, source);
    this.tasks.push(t);
    if (source === "voice" || instruction === this.draft) this.draft = "";
    this.pushState();
    void this.start(t);
    return t;
  }

  /** Runs a task now, beside any others; its parts wait their turn for whatever another task is using. */
  private async start(next: Task) {
    const abort = new AbortController();
    this.running.set(next.id, { task: next, abort });
    this.progress.set(next.id, new Map());
    this.progressMuted = false;
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => {
      if (l.type === "files" && l.actions.some(a => a.kind === "move")) this.lastMoves = { taskId: l.taskId, actions: l.actions };
      this.emit(l);
    }]));
    const upd = (t: Task) => { const i = this.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.tasks[i] = t; };
    next.status = "planning";
    this.pushState();
    try {
      const done = await runTask(next, {
        driver: this.driver, claude: this.claude, jev: this.jev, log, signal: abort.signal, hand: this.hand, locks: this.locks,
        approve: req => this.ask(req),
        onStatus: text => this.onProgress(next, text),
        conversation: this.turns.slice(-5),
        // A plan that turns out to be about the screen: a spoken one is about where the pointer is now, a typed one
        // about the window behind the panel. The answer is shown (bubble, marks) here; the task records it.
        askScreen: this.driver.caps.platform === "sim" ? undefined : async question => {
          const at = next.source === "voice" ? await cursorNow().catch(() => null) : null;
          const r = await this.screenAnswer(question, at);
          log.write({ type: "ask", runId: log.runId, t: new Date().toISOString(), taskId: next.id, question, window: r.window, element: r.element, answer: r.answer, by: r.by, pointedAt: r.pointedAt, ms: r.ms });
          return { answer: r.answer, evidence: r.evidence, jevUsd: jevAskUsd(r), by: r.by };
        },
      });
      upd(done);
      if ((done.status === "done" || done.status === "partial") && done.result) this.turns.push({ instruction: done.instruction, answer: done.result.answer });
      const told = done.status === "done" || done.status === "partial" ? done.result?.answer || "Done."
        : done.exception?.code === "needs_info" ? done.exception.reason
        : done.status === "stopped" ? "" : `I couldn't finish that. ${done.exception?.reason ?? ""}`;
      if (done.source === "voice") speak(told);
      // On screen for every task (a typed one may finish while the user is in another window). A screen question's
      // answer is already in the bubble, next to what it is about.
      if (told && !done.plan?.aboutScreen) {
        const title = done.status === "done" ? "Done" : done.status === "partial" ? "Partly done" : done.exception?.code === "needs_info" ? "I need to know" : "Couldn't finish";
        this.running.delete(next.id);
        if (this.running.size) {
          // Others still run: the result stays in the progress bubble for a while, under them.
          this.recent.push({ text: `${title === "Done" ? "✓" : "•"} ${title}: ${clip(told.replace(/\s+/g, " "), 220)}`, until: Date.now() + 25_000 });
          this.progressMuted = false;
          this.refreshBubble(0);
        } else {
          // The last one to finish: with the results of any that finished just before it.
          const recent = this.recent.filter(r => r.until > Date.now()).map(r => r.text);
          this.recent = [];
          showBubble(recent.length ? [told, ...recent].join("\n") : told, { title });
        }
      }
    } catch (e) {
      upd({ ...next, status: "failed", exception: { code: "model_error", reason: (e as Error).message } });
    } finally {
      this.running.delete(next.id);
      this.progress.delete(next.id);
      for (const [id, a] of this.approvals) {
        if (a.req.taskId !== next.id) continue;
        clearTimeout(a.timer); this.approvals.delete(id); a.resolve(false);
      }
      this.pushState();
    }
  }

  /** A task's status: to the panel, to the task's progress lines, and (throttled) to the bubble. */
  private onProgress(t: Task, text: string) {
    this.emit({ type: "status", text: this.running.size > 1 ? `${clip(t.instruction, 40)}: ${text}` : text });
    const parts = this.progress.get(t.id);
    if (!parts || NOISE.test(text)) return;
    if (t.status === "planning" && text !== "planning") t.status = "running";
    const m = text.match(/^(part \d+): (.*)$/);
    parts.set(m ? m[1] : "", m ? m[2] : text);
    this.pushState();
    this.refreshBubble();
  }

  /** Keeps a bubble the user should read (an answer, "Thinking…") on screen for `ms` before progress replaces it. */
  private hold(ms: number) { this.heldUntil = Math.max(this.heldUntil, Date.now() + ms); }

  private refreshBubble(delay = 800) {
    if (this.bubbleTimer) return;
    this.bubbleTimer = setTimeout(() => { this.bubbleTimer = undefined; this.showProgress(); }, delay);
  }

  /** What every running task is doing (each part of one doing several things at once), and what just finished. */
  private showProgress() {
    if (!this.running.size || this.listening || this.approvals.size || this.progressMuted) return;     // those own the bubble for now
    const wait = this.heldUntil - Date.now();
    if (wait > 0) { this.refreshBubble(wait + 50); return; }
    const now = Date.now();
    this.recent = this.recent.filter(r => r.until > now);
    const lines = [...this.running.values()].map(({ task }) => {
      const parts = [...(this.progress.get(task.id) ?? new Map<string, string>())];
      const doing = parts.length ? parts.map(([part, text]) => `   ${part ? `${part}: ` : ""}${clip(text, 110)}`).join("\n") : "   starting";
      return `▶ ${clip(task.instruction, 70)}\n${doing}`;
    });
    showBubble([...lines, ...this.recent.map(r => r.text)].join("\n"), { title: this.running.size > 1 ? `Working on ${this.running.size} tasks` : "Working on it", ms: 30_000 });
  }

  private ask(req: ApprovalRequest): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(req.id, false), APPROVAL_TIMEOUT_MS);
      this.approvals.set(req.id, { req, resolve, timer });
      this.pushState();
      const run = this.running.get(req.taskId);
      const voice = run?.task.source === "voice";
      if (voice) speak(`I need your okay to ${req.action}. Hold the talk keys and say yes or no, or use the panel.`);
      showBubble(`${req.action}\n${req.why}\n\nApprove or deny on the panel${voice ? ", or hold the talk keys and say yes or no" : ""}.`, { title: "Needs your okay", ms: APPROVAL_TIMEOUT_MS });
      // A stop cancels the pending approval too.
      run?.abort.signal.addEventListener("abort", () => this.answer(req.id, false), { once: true });
    });
  }

  answer(id: string, ok: boolean) {
    const a = this.approvals.get(id);
    if (!a) return false;
    clearTimeout(a.timer);
    this.approvals.delete(id);
    a.resolve(ok);
    if (!this.approvals.size) { if (this.running.size) this.refreshBubble(0); else hideBubble(); }
    this.pushState();
    return true;
  }

  /** Stops one task, or every running task. */
  stop(taskId?: string) {
    for (const [id, r] of this.running) if (!taskId || id === taskId) r.abort.abort();
    for (const t of this.tasks) if (t.status === "queued" && (!taskId || t.id === taskId)) t.status = "stopped";
    this.pushState();
  }

  clear() {
    this.tasks = this.tasks.filter(t => this.running.has(t.id));
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
        if (req.method === "POST" && p === "/api/stop") { this.stop(typeof body.taskId === "string" ? body.taskId : undefined); return json({ ok: true }); }
        if (req.method === "POST" && p === "/api/clear") { this.clear(); return json({ ok: true }); }
        if (req.method === "POST" && p === "/api/undo-moves") {
          if (!this.lastMoves || this.running.size) return json({ ok: false, error: this.running.size ? "a task is running" : "nothing to undo" }, 400);
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

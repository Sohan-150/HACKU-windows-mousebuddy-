// Panel server: SSE /events; tasks (typed or spoken); approvals; stop; past runs. And the on-screen half: the overlay
// (overlay.ts) sends what was said or typed with the talk keys, and gets back what to say and draw (explain mode), the
// agents' widgets and the flashes where they act. The Windows twin of the Mac version's server.
//
// One hotkey for everything (router.ts): hold the talk keys, point, speak, release (or tap them and type):
//   a question about the screen ("what is this?", "how do I make a pivot table?", "circle the zebra") -> explain mode:
//     answered out loud while it draws on the screen, read-only; "how do I..." is a lesson ("next", Alt+Right);
//   a job ("open Calculator and work out 128 times 37") -> "On it.", the agents do it (each with a widget in the
//     bottom-right corner), then the result is said; "stop" -> stops them; "yes"/"no" -> answers a pending approval.
// Tasks start at once and share the computer: each part takes what it needs (the agent's browsers, the desktop-app
// hands, Word, the files; see lanes.ts), so a web task runs while an app task waits, and a part that needs something
// in use waits its turn (its widget says what it is waiting for).
// Questions about the screen typed in the panel are answered from the window behind the panel.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { newTask, runTask, type ClaudeLike, type JevLike } from "./agent";
import type { Claude, Turn } from "./claude";
import { AGENT_COLOURS, type AgentState, type ApprovalRequest, type Driver, type FileAction, type HandName, type LogLine, type Task } from "./contracts";
import { behindPanel, Explainer, lessonWord, type Capture, type ExplainResult, type OverlaySend } from "./explain";
import type { VoiceEvent } from "./intake";
import { undoMoves } from "./files";
import { JEV_USD_PER_INPUT_TOKEN } from "./jev";
import { Locks } from "./lanes";
import { JsonlLogger, newRunId, RUNS_DIR } from "./logger";
import { send as overlaySend, type OverlayEvent } from "./overlay";
import { cursorNow } from "./pointer";
import { spokenSummary, tidyAnswer } from "./results";
import { codeRoute, route } from "./router";
import { splitParts } from "./planner";
import { speak, stopSpeaking } from "./speak";
import type { Voice } from "./voice";

export type AppClaude = ClaudeLike & Partial<Pick<Claude, "explain">>;
export type AppJev = JevLike;
type Point = { x: number; y: number };

type AppEvent =
  | { type: "state"; state: ReturnType<App["snapshot"]> }
  | { type: "voice"; voice: VoiceEvent }
  | { type: "status"; text: string; taskId?: string }
  | LogLine;

/** for tests: no overlay, no Cua (a fake picture of the screen), no network voice */
export interface AppOptions { send?: OverlaySend; capture?: (cursor?: Point) => Promise<Capture>; behindPanel?: () => Promise<Capture>; voice?: Voice }

const APPROVAL_TIMEOUT_MS = 5 * 60_000;
const POINTER_HAND: HandName = "Blue-9";      // its own Cua session for reading windows, so asks never disturb a running task
// The panel's browser window (viewer/index.html <title> "Backstage", then " - Google Chrome" etc.): never what a typed
// question is about. ("Background Agent" was its old title.)
export const PANEL_TITLE = /^Backstage(\s+[-\u2013\u2014]\s+|$)|^Background Agent\b/;
const YES = /^(yes|yeah|yep|approve|approved|go ahead|do it|ok(ay)?|sure)\b/i, NO = /^(no|nope|deny|denied|don'?t|do not)\b/i;
const KEEP_FINISHED_MS = 20_000;              // a finished agent's widget stays this long while others still work

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class App {
  tasks: Task[] = [];
  running = new Map<string, { task: Task; abort: AbortController }>();
  locks = new Locks();                 // the browsers, the app hands, Word, the files: shared by every task
  approvals = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; timer: Timer }>();
  notices: { level: string; text: string }[] = [];
  voiceInfo = "voice off";
  draft = "";                          // last dictated instruction, shown in the box for the user to send
  lastMoves: { taskId: string; actions: FileAction[] } | null = null;    // for "undo last file moves"
  turns: Turn[] = [];                  // finished tasks and answers, for follow-ups ("write that in Notepad")
  voiceMode: "run" | "draft" = process.env.VOICE_MODE === "draft" ? "draft" : "run";
  agents = new Map<string, AgentState & { endedAt?: number }>();   // each part of each task: its widget
  readonly explainer: Explainer;
  private send: OverlaySend;
  private behind: () => Promise<Capture>;
  private listenTimer?: Timer;
  private dockTimer?: Timer;
  private stateTimer?: Timer;
  private fromHotkey = new Set<string>();   // tasks started with the talk keys: their result is said out loud
  private clients = new Set<(e: AppEvent) => void>();
  private lines: LogLine[] = [];          // the latest log lines, for a panel that opens later (like the Mac version)

  constructor(public driver: Driver, public claude: AppClaude | null, public jev: AppJev | null, public hand: HandName = "Mint-3", opts: AppOptions = {}) {
    this.send = opts.send ?? overlaySend;
    const explainClaude = claude?.explain ? claude as Pick<Claude, "explain" | "usage"> : null;
    this.explainer = new Explainer({
      claude: explainClaude, jev, send: this.send, speak, hand: POINTER_HAND, voice: opts.voice, capture: opts.capture,
      conversation: () => this.turns.slice(-5), ready: () => this.driver.ensureSession(POINTER_HAND),
    });
    this.behind = opts.behindPanel ?? (async () => { await this.driver.ensureSession(POINTER_HAND).catch(() => {}); return behindPanel(POINTER_HAND, PANEL_TITLE); });
    // every press or text insert flashes in the agent's colour where it happened (fast-lane actions have no Cua cursor)
    this.driver.onAction = n => { this.send({ cmd: "tap", colour: AGENT_COLOURS[n.hand] ?? "#2bb39a", kind: n.kind, via: n.via, pid: n.pid ?? 0, ...n.frame }); };
  }

  get desktop(): boolean { return this.driver.caps.platform !== "sim"; }

  snapshot() {
    return {
      tasks: this.tasks.slice(-30), running: [...this.running.keys()], approvals: [...this.approvals.values()].map(a => a.req),
      agents: [...this.agents.values()].slice(-40),
      deciders: { jev: !!this.jev, claude: !!this.claude }, driver: this.driver.caps.name, notices: this.notices.slice(-4),
      voice: this.voiceInfo, voiceOut: this.explainer.voice.name, credits: this.explainer.voice.credits ?? null,
      voiceMode: this.voiceMode, draft: this.draft, canUndo: !!this.lastMoves,
      fastLane: this.driver.fastLane?.() ?? null, colours: AGENT_COLOURS,
    };
  }
  get busy(): boolean { return this.running.size > 0; }
  emit(e: AppEvent) {
    if (e.type !== "state" && e.type !== "voice" && e.type !== "status") { this.lines.push(e); if (this.lines.length > 300) this.lines.shift(); }
    for (const f of this.clients) f(e);
  }
  pushState() { clearTimeout(this.stateTimer); this.stateTimer = undefined; this.emit({ type: "state", state: this.snapshot() }); }
  /** many agent updates a second: the panel gets at most four states a second */
  private pushStateSoon() { this.stateTimer ??= setTimeout(() => this.pushState(), 250); }
  notice(level: "info" | "warn" | "error", text: string) { this.notices.push({ level, text }); this.pushState(); }

  // ---------------------------------------------------------------------------------------------------------------
  // the talk keys (voice.py) and the overlay

  onVoice(v: VoiceEvent) {
    this.emit({ type: "voice", voice: v });
    if (v.event === "down") {
      stopSpeaking();
      // Capture now, as the user sees the screen (the overlay's own windows are never in the picture).
      if (this.desktop) this.explainer.begin();
      // "Listening" on the buddy after a moment (longer than voice.py's 400 ms minimum hold), so a shortcut or a tap,
      // which cancels, does not flash it.
      clearTimeout(this.listenTimer);
      this.listenTimer = setTimeout(() => this.send({ cmd: "listening" }), 450);
    } else if (v.event === "up") {
      clearTimeout(this.listenTimer);
      this.send({ cmd: "status", text: "thinking" });
    } else if (v.event === "cancel") {
      clearTimeout(this.listenTimer);
      // A tap opens the typing box (the picture taken on key down is kept for the question typed there).
      if (v.reason === "tap") this.send({ cmd: "typebox" });
      else { this.explainer.discard(); this.send({ cmd: "idle" }); }
    } else if (v.event === "transcript") {
      const said = v.text.trim();
      // "thank you", "okay": also what the speech model makes of silence; kept only when it means something now
      const meant = !v.maybe_noise || (this.explainer.inLesson && !!lessonWord(said)) || (this.approvals.size > 0 && (YES.test(said) || NO.test(said)));
      if (!meant) { this.explainer.discard(); this.send({ cmd: "error", text: "didn't catch that: hold the keys and speak a little louder" }); }
      else if (said) void this.onSpoken(said);
      else { this.explainer.discard(); this.send({ cmd: "idle" }); }
    } else if (v.event === "error") {
      this.notice("warn", `voice: ${v.msg}`);
      this.send({ cmd: "error", text: v.msg });
    } else if (v.event === "ready") this.pushState();
  }

  /** What the overlay sends: a question typed in its box, lesson keys, Esc twice, the tray menu's Stop. */
  onOverlay(e: OverlayEvent) {
    if (e.event === "ask") void this.hotkey(e.text, "typed", e.cursor).catch(err => console.error("[hotkey]", err));
    else if (e.event === "step") this.explainer.go(e.go === "back" ? "back" : "next");
    else if (e.event === "dismiss") this.explainer.dismiss();
    else if (e.event === "stop") { if (this.busy) this.explainer.say("Stopping the agents.", 4000); this.stop(); }
    else if (e.event === "key") console.log(`[keys] ${String(e.what ?? "").slice(0, 60)}`);
    else if (e.event === "ready") this.dock();
  }

  /** One spoken utterance (the talk keys). */
  onSpoken(text: string): Promise<void> { return this.hotkey(text, "voice"); }

  /** The talk keys' words (spoken, or typed in the overlay's box): a job for the agents, or a question for explain mode. */
  async hotkey(text: string, source: Task["source"], cursor?: Point): Promise<void> {
    const q = text.trim();
    const pending = [...this.approvals.values()];
    if (q && pending.length && (YES.test(q) || NO.test(q))) {
      // The oldest question first (several tasks can be waiting for an okay).
      this.explainer.discard();
      const ok = YES.test(q), req = pending[0].req;
      this.answer(req.id, ok, true);
      this.explainer.say(ok ? (pending.length > 1 ? `Okay: ${req.action}.` : "Okay.") : (pending.length > 1 ? `Okay, I won't: ${req.action}.` : "Okay, I won't."), 3000);
      return;
    }
    if (!q) { this.explainer.discard(); this.send({ cmd: "idle" }); return; }
    // "mute me on Discord and then show me how to calculate 5 times 79": the job goes to the agents, and the "show me
    // how" part is taught on the screen (the user does it), at the same time
    const parts = splitParts(q);
    if (parts.length > 1 && this.desktop) {
      const ctx = { lesson: this.explainer.inLesson, agentsBusy: this.busy };
      const teach = parts.filter(p => codeRoute(p, ctx) === "explain" && !this.explainer.inCode(p));
      const jobs = parts.filter(p => !teach.includes(p));
      if (teach.length && jobs.length) {
        this.explainer.discard();
        const t = this.addTask(jobs.join(". "), source);
        this.fromHotkey.add(t.id);
        void this.startExplain(teach.join(". "), source, cursor).done;
        return;
      }
    }
    const r = await route(q, { lesson: this.explainer.inLesson, agentsBusy: this.busy, jev: this.jev?.extra?.choose ? { choose: this.jev.extra.choose.bind(this.jev.extra) } : null });
    console.log(`[route] "${q.slice(0, 60)}" -> ${r.to} (${r.via}${r.confidence !== undefined ? ` ${r.confidence.toFixed(2)}` : ""}, ${r.ms} ms)`);
    if (r.to === "stop") {
      this.explainer.discard();
      if (this.explainer.inLesson) this.explainer.dismiss();   // "stop" also ends a lesson and clears its drawings
      this.stop();
      this.explainer.say("Stopping the agents.", 4000);
      return;
    }
    if (r.to === "explain") {
      // "next", "repeat", "never mind": the lesson and the drawings, no screen needed
      if (this.explainer.inCode(q)) { await this.explainer.ask(q, cursor); return; }
      if (this.desktop) {
        const t = await this.startExplain(q, source, cursor).done;
        if (!t.result?.handoff) return;
        // explain mode saw it was a job after all: the agents do it
      }
      // the simulator has no screen to look at: a task like any other
    }
    this.explainer.discard();
    if (this.voiceMode === "draft" && source === "voice") {
      this.draft = q; this.pushState();
      this.explainer.say(`"${clip(q, 80)}" is in the box on the panel: press Run to do it.`, 6000);
      return;
    }
    if (!this.jev && !this.claude) {
      this.explainer.say("No TypeSafe or Claude API key in the .env file, so the agents can't start.", 6000);
    } else this.explainer.say("On it.", 3000);
    const t = this.addTask(q, source);
    this.fromHotkey.add(t.id);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // explain mode, recorded on the panel like a task

  /** Records the question as a task at once (the panel shows it) and answers it with explain mode. Read-only. */
  private startExplain(question: string, source: Task["source"], cursor?: Point, capture?: Promise<Capture>): { task: Task; done: Promise<Task> } {
    const t = newTask(question, source);
    t.status = "running"; t.startedAt = new Date().toISOString();
    this.tasks.push(t);
    this.pushState();
    return { task: t, done: this.finishExplain(t, cursor, capture) };
  }

  private async finishExplain(t: Task, cursor?: Point, capture?: Promise<Capture>): Promise<Task> {
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => this.emit(l)]));
    const r = await this.explainer.ask(t.instruction, cursor, { capture });
    const evidence = explainEvidence(r);
    if (r.handoff) {
      // not a question after all: this record goes, and the job runs as a task (the caller starts it)
      this.tasks = this.tasks.filter(x => x !== t);
      t.result = { answer: "", evidence, handoff: true };
      this.pushState();
      return t;
    }
    if (r.error) {
      t.status = "failed";
      t.exception = { code: "driver_refused", reason: r.answer };
    } else {
      t.status = "done";
      t.result = { answer: r.answer, evidence };
      this.turns.push({ instruction: t.instruction, answer: r.answer });
    }
    t.counts.jev = r.jevTokens ? 1 : 0; t.counts.claude = r.by === "claude" ? 1 : 0;
    t.cost = { jevUsd: r.jevTokens * JEV_USD_PER_INPUT_TOKEN, claudeUsd: r.usd };
    log.write({ type: "ask", runId: log.runId, t: new Date().toISOString(), taskId: t.id, question: t.instruction, window: r.window, answer: r.answer, by: r.by, ms: r.ms });
    t.endedAt = new Date().toISOString();
    log.write({ type: "task_end", runId: log.runId, t: t.endedAt, task: t });
    this.pushState();
    return t;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // tasks

  add(instruction: string, source: Task["source"]): Task {
    // A screen question typed in the panel ("what am I looking at?", "circle the zebra") is answered from the window
    // behind the panel, not planned as a task. (Typed how-to questions stay with the planner: "how do I renew my
    // passport" needs no screenshot.)
    if (this.desktop && source === "typed" && codeRoute(instruction, { lesson: false, agentsBusy: false }) === "explain" && !this.explainer.inCode(instruction)) {
      if (instruction === this.draft) this.draft = "";
      const ask = this.startExplain(instruction, source, undefined, this.behind());
      // explain mode saw it was a job after all: the agents do it
      void ask.done.then(t => { if (t.result?.handoff) this.addTask(instruction, source); });
      return ask.task;
    }
    return this.addTask(instruction, source);
  }

  /** a task for the agents (the router already decided it is not a question about the screen) */
  private addTask(instruction: string, source: Task["source"]): Task {
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
    const log = new JsonlLogger(newRunId(), new Set([(l: LogLine) => {
      if (l.type === "files" && l.actions.some(a => a.kind === "move")) this.lastMoves = { taskId: l.taskId, actions: l.actions };
      this.emit(l);
    }]));
    const upd = (t: Task) => { const i = this.tasks.findIndex(x => x.id === t.id); if (i >= 0) this.tasks[i] = t; };
    next.status = "planning";
    this.pushState();
    let done: Task = next;
    try {
      done = await runTask(next, {
        driver: this.driver, claude: this.claude, jev: this.jev, log, signal: abort.signal, hand: this.hand, locks: this.locks,
        approve: req => this.ask(req),
        onStatus: text => this.onProgress(next, text),
        onAgent: a => this.onAgent(a),
        conversation: this.turns.slice(-5),
        // A plan that turns out to be about the screen: a spoken one is about the screen under the pointer now, a
        // typed one about the window behind the panel. Explain mode answers it (out loud, with drawings).
        askScreen: !this.desktop ? undefined : async question => {
          const r = await this.explainer.ask(question, undefined, { capture: next.source === "voice" ? undefined : this.behind() });
          if (r.error) throw new Error(r.error);
          log.write({ type: "ask", runId: log.runId, t: new Date().toISOString(), taskId: next.id, question, window: r.window, answer: r.answer, by: r.by, ms: r.ms });
          return { answer: r.answer, evidence: explainEvidence(r), jevUsd: r.jevTokens * JEV_USD_PER_INPUT_TOKEN, by: r.by };
        },
      });
      upd(done);
      if ((done.status === "done" || done.status === "partial") && done.result) this.turns.push({ instruction: done.instruction, answer: done.result.answer });
    } catch (e) {
      done = { ...next, status: "failed", exception: { code: "model_error", reason: (e as Error).message } };
      upd(done);
    } finally {
      this.running.delete(next.id);
      for (const [id, a] of this.approvals) {
        if (a.req.taskId !== next.id) continue;
        clearTimeout(a.timer); this.approvals.delete(id); a.resolve(false);
      }
      // the task's agents are finished: their widgets stay a little while, then go
      for (const a of this.agents.values()) if (a.taskId === next.id && !a.endedAt) a.endedAt = Date.now();
      this.pushState();
      this.dock();
    }
    // Started with the talk keys: say how it went (one sentence per agent), like the Mac version. A screen question
    // has already been answered out loud.
    if (this.fromHotkey.delete(next.id) && !done.plan?.aboutScreen) {
      const agents = [...this.agents.values()].filter(a => a.taskId === next.id);
      const status = done.status === "stopped" ? "stopped" : "finished";
      const error = done.exception?.reason ?? (done.status === "failed" ? "I couldn't finish that." : undefined);
      this.explainer.say(spokenSummary(agents, status, agents.length ? undefined : error), 12_000);
    }
  }

  /** A task's status: to the panel's live feed (the agents' widgets get theirs from onAgent). */
  private onProgress(t: Task, text: string) {
    if (/(reading the window|^idle)$/.test(text)) return;
    this.emit({ type: "status", taskId: t.id, text: this.running.size > 1 ? `${clip(t.instruction, 40)}: ${text}` : text });
    if (t.status === "planning" && text !== "planning") { t.status = "running"; this.pushStateSoon(); }
  }

  /** One part's widget changed: the panel and the overlay's dock. */
  private onAgent(a: AgentState) {
    const old = this.agents.get(a.id);
    this.agents.set(a.id, { ...a, ...(old?.endedAt ? { endedAt: old.endedAt } : {}), ...(a.status === "done" || a.status === "failed" ? { endedAt: old?.endedAt ?? Date.now() } : {}) });
    while (this.agents.size > 60) this.agents.delete(this.agents.keys().next().value!);
    this.pushStateSoon();
    this.dockSoon();
  }

  private dockSoon() { this.dockTimer ??= setTimeout(() => { this.dockTimer = undefined; this.dock(); }, 200); }

  /** The agents' widgets (bottom right): every running task's agents, and those that finished in the last moments. */
  dock() {
    const now = Date.now();
    const shown = [...this.agents.values()].filter(a => this.running.has(a.taskId) || (a.endedAt !== undefined && now - a.endedAt < KEEP_FINISHED_MS));
    this.send({
      cmd: "agents", running: this.busy,
      tasks: shown.map(a => ({
        id: a.id, name: a.name || "Agent", colour: a.colour, app: a.app, goal: cap1(a.goal), status: a.status, now: a.now,
        answer: tidyAnswer(a.answer ?? ""), reason: a.reason ?? "", seconds: a.seconds, steps: a.steps, windowId: a.windowId ?? 0, pid: a.pid ?? 0,
      })),
    });
  }

  private ask(req: ApprovalRequest): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.answer(req.id, false), APPROVAL_TIMEOUT_MS);
      this.approvals.set(req.id, { req, resolve, timer });
      this.pushState();
      const run = this.running.get(req.taskId);
      // Said and shown until answered (fadeMs 0): hold the talk keys and say yes or no, or use the panel.
      this.explainer.say(`I need your okay to ${req.action}. Hold the talk keys and say yes or no, or use the panel.`, 0);
      // A stop cancels the pending approval too.
      run?.abort.signal.addEventListener("abort", () => this.answer(req.id, false), { once: true });
    });
  }

  /** `quiet`: the caller says something itself (a spoken yes/no) */
  answer(id: string, ok: boolean, quiet = false) {
    const a = this.approvals.get(id);
    if (!a) return false;
    clearTimeout(a.timer);
    this.approvals.delete(id);
    a.resolve(ok);
    if (!quiet) this.explainer.say(ok ? "Okay, going ahead." : "Okay, I won't.", 2500);
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
    for (const [id, a] of this.agents) if (!this.running.has(a.taskId)) this.agents.delete(id);
    this.notices = this.notices.filter(n => n.level === "error");
    this.lines = [];
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
              for (const l of this.lines.slice(-200)) send(l);
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
          if (!this.desktop) return json({ error: "the simulator has no screen to look at" }, 400);
          let at: Point | null = Number.isFinite(body.x) && Number.isFinite(body.y) ? { x: Math.round(body.x), y: Math.round(body.y) } : null;
          if (!at) {
            await Bun.sleep(Math.min(Math.max(Number(body.delayMs ?? 3000) || 0, 0), 8000));
            at = await cursorNow().catch(() => null);
          }
          if (!at) return json({ error: "could not read the pointer position (is the Cua daemon running?)" }, 503);
          return json(await this.startExplain(text, "typed", at).done);
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

/** what explain mode looked at and did, for the panel */
function explainEvidence(r: ExplainResult): string {
  const seen = r.typed ? "typed: the window behind the panel" : r.cursor ? `pointer at ${Math.round(r.cursor.x)},${Math.round(r.cursor.y)}` : "the screen";
  const lesson = r.steps > 1 ? `; a lesson of ${r.steps} steps` : "";
  return `${seen}${r.window ? ` in "${r.window}"` : ""}; answered by ${r.by}${lesson}${r.shapes ? `; drew ${r.shapes} shape${r.shapes > 1 ? "s" : ""}` : ""}`;
}

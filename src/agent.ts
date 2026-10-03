// runTask: plan -> for each part: (files: preview, approve, run, check on disk) or (window: open -> steps -> check).
// Parts that do not use what an earlier part found run at the same time when they need different things (the browser
// and a desktop app; see lanes.ts); a part that fails does not stop the others.
// Deciders: TypeSafe jev first for everything it can do; Claude (optional) for planning that rules can't do, writing
// text nobody planned, steps jev is unsure about, and reading the result. Every task ends "done" with an answer and
// its evidence, "partial" (some parts done, the others with their reasons), or "failed" with a coded reason.
import { AGENT_COLOURS, type ActSpec, type ActionResult, type AgentState, type Approver, type Check, type Decision, type Driver, type ExceptionCode,
  type HandName, type Item, type Logger, type Observation, type Plan, type Subtask, type Task, type WindowRef } from "./contracts";
import { Claude, ModelError, type Turn } from "./claude";
import { DriverError } from "./driver/cli";
import { FileOpError, planFiles, runFiles } from "./files";
import { createWordDocument, toParagraphs } from "./office";
import { GATE, Jev, JEV_USD_PER_INPUT_TOKEN, type StepState } from "./jev";
import { goalValues, isFindField, isMessageField, messageOf, SEND_INTENT } from "./values";
import { APP_HANDS, BROWSER_HANDS, handsFor, Locks, lockName, locksFor, Stopped } from "./lanes";
import { joinFragments, NEEDS_NUMBER, perceive, relevantLines, screenText, signature } from "./perceive";
import { planWithJev, searchUrl } from "./planner";
import { clickNeedsApproval, personalDetailsMissing, typingForbidden } from "./safety";

export type ClaudeLike = Pick<Claude, "plan" | "decide" | "write" | "url" | "verify" | "usage"> & Partial<Pick<Claude, "answerFrom">>;
export type JevLike = Pick<Jev, "decide"> & { extra?: Pick<Jev["extra"], "classify" | "checkDone"> & Partial<Pick<Jev["extra"], "pickControl" | "choose">> };

export interface AgentDeps {
  driver: Driver; claude: ClaudeLike | null; jev: JevLike | null; log: Logger; approve: Approver; signal: AbortSignal;
  hand?: HandName; maxSteps?: number; onStatus?: (s: string) => void;   // hand: the first browser window (Mint-3)
  appHand?: HandName;                     // only this hand for desktop apps (default: the pool in lanes.ts)
  locks?: Locks;                          // shared by every task of the app; without it, the parts of this task share their own
  onAgent?: (a: AgentState) => void;      // each part as an agent: hand, colour, app, what it is doing, how it ended
  onWindow?: (w: WindowRef) => void;      // the window a part works in (set per part by runParts)
  conversation?: Turn[];                  // earlier tasks this session, for follow-ups ("book the cheapest one")
  /** Answers a question about the user's screen (point-and-ask), for plans that turn out to be one. */
  askScreen?: (question: string) => Promise<{ answer: string; evidence: string; jevUsd?: number; by?: "claude" | "jev" | "code" }>;
}

class TaskError extends Error { constructor(public code: ExceptionCode, reason: string) { super(reason); } }
const now = () => new Date().toISOString();
const RECONNECT = ["stale", "window_lost", "session_ended"];
const TYPEABLE = ["text field", "text area"];
const DONE_P = 0.6;                       // jev's "goal achieved" probability needed when nothing better can check

export function newTask(instruction: string, source: Task["source"]): Task {
  return {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, instruction: instruction.trim(), source, status: "queued",
    counts: { steps: 0, jev: 0, claude: 0, gui: 0, files: 0, approvals: 0, falseDoneCaught: 0 }, cost: { jevUsd: 0, claudeUsd: 0 },
  };
}

export async function runTask(input: Task, deps0: AgentDeps): Promise<Task> {
  // Past Claude's spending cap, a new task runs as if there were no Claude key (jev + rules).
  const capped = !!deps0.claude && "budgetUsd" in deps0.claude && deps0.claude.usage.usd >= (deps0.claude as { budgetUsd: number }).budgetUsd;
  const deps: AgentDeps = capped ? { ...deps0, claude: null } : deps0;
  if (capped) deps.onStatus?.("Claude's spending cap is reached: jev + rules only until restart");
  const { driver, claude, jev, log } = deps;
  const task: Task = { ...input, status: "planning", startedAt: now(), counts: { ...input.counts }, cost: { ...input.cost } };
  const claudeAtStart = claude?.usage.usd ?? 0;
  const finish = (t: Task): Task => {
    t.endedAt = now();
    t.cost.claudeUsd = (claude?.usage.usd ?? 0) - claudeAtStart;
    log.write({ type: "task_end", runId: log.runId, t: now(), task: t });
    return t;
  };
  log.write({ type: "task_start", runId: log.runId, t: now(), task, driver: driver.caps.name, deciders: [jev ? "jev" : "", claude ? "claude" : ""].filter(Boolean) });

  try {
    if (!jev && !claude) throw new TaskError("plan_failed", "No TYPESAFE_API_KEY or ANTHROPIC_API_KEY in .env: nothing can make decisions.");
    if (deps.signal.aborted) throw new TaskError("stopped", "stopped by you");
    deps.onStatus?.("planning");
    const plan = await makePlan(task, deps);
    task.plan = plan;
    if (plan.question) throw new TaskError("needs_info", plan.question);

    task.status = "running";
    if (plan.aboutScreen) {
      // "What am I looking at?", "circle the zebra": answered from the user's window, never by a guess without it.
      if (!deps.askScreen) throw new TaskError("needs_info", "To ask about something on the screen, point at it with the mouse, hold the talk keys and ask out loud (or type the question and press 'Point & ask' on the panel).");
      deps.onStatus?.("looking at your screen");
      const r = await deps.askScreen(task.instruction).catch(e => { throw new TaskError("driver_refused", `could not look at the screen: ${(e as Error).message}`); });
      task.cost.jevUsd += r.jevUsd ?? 0;
      if (r.by === "claude") task.counts.claude++; else if (r.by === "jev") task.counts.jev++;
      task.result = { answer: r.answer, evidence: r.evidence };
      task.status = "done";
      deps.onStatus?.("idle");
      return finish(task);
    }
    const parts = await runParts(task, plan, deps);
    if (parts.some(p => !p.ok && p.code === "stopped")) throw new TaskError("stopped", "stopped by you");
    const done = parts.filter((p): p is PartDone => p.ok), failed = parts.filter((p): p is PartFailed => !p.ok);
    if (parts.length === 1 && failed.length) throw new TaskError(failed[0].code, failed[0].reason);
    if (!failed.length) {
      task.result = parts.length > 1 ? { answer: done.map(p => p.answer).join(" "), evidence: done[done.length - 1].evidence } : done[0];
      task.status = "done";
    } else {
      // Say what happened to every part, in order: the ones that worked and why the others did not.
      const lines = parts.map((p, i) => p.ok ? p.answer : `Part ${i + 1} (${shortGoal(plan.subtasks[i])}) didn't work: ${p.reason}`);
      task.result = { answer: lines.join("\n"), evidence: done.length ? done[done.length - 1].evidence : "" };
      task.status = done.length ? "partial" : "failed";
      task.exception = { code: failed[0].code, reason: failed.map(f => f.reason).join(" | ") };
      if (!done.length) task.result = undefined;
    }
  } catch (e) {
    const err = asTaskError(e);
    task.status = err.code === "stopped" ? "stopped" : "failed";
    task.exception = { code: err.code, reason: err.message };
  }
  deps.onStatus?.("idle");
  return finish(task);
}

function asTaskError(e: unknown): TaskError {
  return e instanceof TaskError ? e
    : e instanceof Stopped ? new TaskError("stopped", "stopped by you")
    : e instanceof ModelError ? new TaskError("model_error", e.message)
    : e instanceof FileOpError ? new TaskError("needs_info", e.message)
    : e instanceof DriverError ? new TaskError(e.code === "window_lost" ? "window_lost" : "driver_refused", e.message)
    : new TaskError("model_error", `unexpected error: ${(e as Error).message ?? e}`);
}

type PartDone = { ok: true; answer: string; evidence: string };
type PartFailed = { ok: false; code: ExceptionCode; reason: string };
type PartOutcome = PartDone | PartFailed;

/** A part uses what earlier parts found (and so waits for them): said so in the plan, or an answer written from them. */
function needsEarlier(sub: Subtask, k: number): boolean {
  if (k === 0) return false;
  return !!sub.usePreviousAnswer || !!sub.needsPrevious || sub.surface.kind === "answer"
    || (sub.surface.kind === "document" && sub.surface.text.includes("{previous answer}"));
}

/** What a part works in, for progress lines: "YouTube", "Spotify", "Word". */
export function partLabel(s: Subtask["surface"]): string {
  if (s.kind === "browser") {
    try {
      const u = new URL(s.url), host = u.hostname.replace(/^www\./, "");
      if (/(^|\.)youtube\.com$/.test(host)) return "YouTube";
      if (/^google\./.test(host)) return u.pathname.startsWith("/travel/flights") ? "Google Flights" : u.pathname.startsWith("/maps") ? "Google Maps" : "Google";
      if (/duckduckgo\.com$/.test(host)) return "web search";
      return host || "web";
    } catch { return "web"; }
  }
  return s.kind === "app" ? s.app : s.kind === "document" ? "Word" : s.kind === "files" ? "files" : "answer";
}

const shortGoal = (sub: Subtask) => {
  const g = sub.goal.replace(/\s+/g, " ").trim();
  return g.length > 70 ? `${g.slice(0, 67)}...` : g;
};

/**
 * Runs the parts of a plan. Each takes what it needs (its app, Word, the files, then a hand: a browser window or an app
 * hand) for as long as it runs; parts needing different things run at the same time, parts needing the same thing take
 * turns in plan order. A part that uses what earlier ones found waits for them, and is skipped if one of them failed.
 */
async function runParts(task: Task, plan: Plan, deps: AgentDeps): Promise<PartOutcome[]> {
  const locks = deps.locks ?? new Locks();
  const browserHands = [deps.hand ?? BROWSER_HANDS[0], ...BROWSER_HANDS.filter(h => h !== (deps.hand ?? BROWSER_HANDS[0]))];
  const appHands = deps.appHand ? [deps.appHand] : APP_HANDS;
  const n = plan.subtasks.length;
  const runs: Promise<PartOutcome>[] = [];
  for (let k = 0; k < n; k++) {
    const earlier = needsEarlier(plan.subtasks[k], k) ? runs.slice(0, k) : [];
    const label = `part ${k + 1} (${partLabel(plan.subtasks[k].surface)})`;
    // The part as an agent (its widget): who does it, what it is doing now, how it ended.
    const surface0 = plan.subtasks[k].surface;
    const agent: AgentState = {
      id: `${task.id}/${k}`, taskId: task.id, sub: k, name: "", colour: "#8a8f98", app: partLabel(surface0), goal: shortGoal(plan.subtasks[k]),
      status: "queued", now: earlier.length ? "waiting for the parts before it" : "starting", steps: 0, seconds: 0,
    };
    const showAgent = () => {
      if (agent.startedAt) agent.seconds = Math.round((Date.now() - agent.startedAt) / 100) / 10;
      deps.onAgent?.({ ...agent });
    };
    const logAgent = () => deps.log.write({ type: "agent", runId: deps.log.runId, t: now(), taskId: task.id, agent: { ...agent } });
    showAgent();
    const status = (s: string) => {
      deps.onStatus?.(n > 1 ? `${label}: ${s}` : s);
      if (/(reading the window|^idle)$/.test(s)) return;
      const m = s.match(/^step (\d+): (.*)$/);
      if (m) agent.steps = Math.max(agent.steps, Number(m[1]));
      agent.now = (m ? m[2] : s).replace(/^deciding$/, "deciding what to do next");
      showAgent();
    };
    const partDeps: AgentDeps = { ...deps, onStatus: status, onWindow: win => { agent.windowId = win.windowId; agent.pid = win.pid; showAgent(); } };
    /** the part starts: with a hand (its Cua session and colour), or as a part that needs no window */
    const started = (hand?: HandName) => {
      const who = hand ?? (surface0.kind === "document" ? "Amber-4" : surface0.kind === "files" ? "Lime-8" : "Pink-2");
      Object.assign(agent, { hand, name: who.replace(/-\d+$/, ""), colour: AGENT_COLOURS[who] ?? agent.colour, status: "running", startedAt: Date.now(), now: "starting" });
      logAgent(); showAgent();
    };
    runs.push((async (): Promise<PartOutcome> => {
      const releases: (() => void)[] = [];
      const outcome = await (async (): Promise<PartOutcome> => { try {
        let notes: string[] = [];
        if (earlier.length) {
          const before = await Promise.all(earlier);
          const bad = before.findIndex(b => !b.ok);
          if (bad >= 0) {
            const b = before[bad] as PartFailed;
            return b.code === "stopped" ? b : { ok: false, code: "needs_info", reason: `skipped: it needs what part ${bad + 1} was to find` };
          }
          notes = before.map(b => (b as PartDone).answer);
        }
        let sub = plan.subtasks[k];
        if (sub.usePreviousAnswer) sub = withPrevious(sub, notes.at(-1) ?? "");
        const waitFor = (lock: string) => (holder: string) => status(`waiting for ${lockName(lock)} (in use by "${holder.slice(0, 60)}")`);
        for (const lock of locksFor(sub.surface)) releases.push(await locks.acquire(lock, task.instruction, deps.signal, waitFor(lock)));
        const pool = handsFor(sub.surface, browserHands, appHands);
        let hand: HandName | undefined;
        if (pool.length) {
          const got = await locks.acquireAny(pool.map(h => `hand:${h}`), task.instruction, deps.signal, waitFor(`hand:${pool[0]}`));
          releases.push(got.release);
          hand = got.name.slice(5) as HandName;
        }
        if (deps.signal.aborted) throw new Stopped();
        started(hand);
        const r = sub.surface.kind === "answer" ? await answerPart(task, sub, notes, partDeps)
          : sub.surface.kind === "files" ? await runFilesPart(task, k, sub, partDeps)
          : sub.surface.kind === "document" ? await runDocumentPart(task, k, sub, notes, partDeps)
          : await runWindowPart(task, k, sub, notes, partDeps, hand!);
        return { ok: true, ...r };
      } catch (e) {
        const err = asTaskError(e);
        return { ok: false, code: err.code, reason: err.message };
      } finally {
        for (const release of releases.reverse()) release();
        // a hand that nobody picks up again: its coloured cursor is hidden, so it doesn't stay on the screen
        const used = agent.hand as HandName | undefined;
        if (used && deps.driver.release) {
          setTimeout(() => { if (!locks.holder(`hand:${used}`)) deps.driver.release!(used).catch(() => {}); }, 1500);
        }
      } })();
      // The part's line in the progress says how it ended, while the others carry on.
      if (n > 1 && !(!outcome.ok && outcome.code === "stopped")) status(outcome.ok ? `✓ ${outcome.answer.replace(/\s+/g, " ").slice(0, 140)}` : `✗ ${outcome.reason.slice(0, 140)}`);
      Object.assign(agent, outcome.ok ? { status: "done", answer: outcome.answer, now: "done" } : { status: "failed", reason: outcome.code === "stopped" ? "stopped by you" : outcome.reason, now: "" });
      if (!agent.name) agent.name = "Agent";
      showAgent(); logAgent();
      return outcome;
    })());
  }
  return Promise.all(runs);
}

/**
 * jev + rules first (cheap). Calculations, writing text and file tasks stay with them (their results are checked in
 * code). Open-ended tasks (web, apps, chat) go to Claude when it is available, and so does anything the rules can't parse.
 */
async function makePlan(task: Task, deps: AgentDeps): Promise<Plan> {
  const { driver, claude, jev, log } = deps;
  const apps = await driver.listApps().catch(() => [] as string[]);
  let plan: Plan | undefined, ms = 0, deferred = false;
  if (jev?.extra) {
    const r = await planWithJev(task.instruction, jev.extra as any, apps, {
      // jev + rules plan what they plan well (open an app and use it, play, mute, message, look something up): no
      // 4-12 s wait for Claude before anything starts. Claude plans the open-ended kinds, and anything unsure.
      defer: claude ? ["web_task", "chat", "unclear"] : [],
      previousAnswer: deps.conversation?.at(-1)?.answer,
    });
    task.counts.jev += 1; task.cost.jevUsd += r.tokens * JEV_USD_PER_INPUT_TOKEN;
    plan = r.deferred ? undefined : r.plan; ms = r.ms; deferred = r.deferred;
  }
  if (claude && (!plan || plan.question || deferred)) {
    const r = await claude.plan(task.instruction, { today: now().slice(0, 10), platform: driver.caps.platform === "darwin" ? "macOS" : "Windows", apps, conversation: deps.conversation });
    task.counts.claude++;
    plan = r.plan; ms += r.ms;
  }
  if (!plan) throw new TaskError("plan_failed", "Nothing can plan this task: the TypeSafe classifier is not available and there is no ANTHROPIC_API_KEY.");
  log.write({ type: "plan", runId: log.runId, t: now(), taskId: task.id, plan, ms });
  return plan;
}

function withPrevious(sub: Subtask, answer: string): Subtask {
  const fill = (s: string) => s.replace("{previous answer}", answer);
  return {
    ...sub, values: sub.values.map(v => ({ ...v, text: fill(v.text) })),
    check: sub.check?.kind === "field_equals" ? { ...sub.check, expected: fill(sub.check.expected) } : sub.check,
  };
}

// ------------------------------------------------------------------ files
async function runFilesPart(task: Task, k: number, sub: Subtask, deps: AgentDeps): Promise<{ answer: string; evidence: string }> {
  if (sub.surface.kind !== "files") throw new Error("not a files part");
  const op = sub.surface.op;
  deps.onStatus?.("looking at the files");
  const plan = planFiles(op);
  if (plan.answer && !plan.actions.length) {
    deps.log.write({ type: "files", runId: deps.log.runId, t: now(), taskId: task.id, sub: k, op, actions: [], results: [] });
    return { answer: plan.answer, evidence: plan.summary };
  }
  if (!plan.actions.length) return { answer: plan.summary, evidence: plan.summary };
  const preview = plan.actions.filter(a => a.kind !== "mkdir").slice(0, 6)
    .map(a => a.kind === "write" ? `write ${a.path}` : a.kind === "open" ? `open ${a.path}` : `${a.kind} ${shortName(a.from)} -> ${a.to}`).join("; ");
  const more = plan.actions.filter(a => a.kind !== "mkdir").length - 6;
  if (plan.needsApproval && !(await ask(task, deps, `${task.id}-${k}-files`, plan.summary, `${preview}${more > 0 ? `; and ${more} more` : ""}. Nothing is deleted or overwritten.`))) {
    throw new TaskError("declined", `you declined: ${plan.summary}`);
  }
  deps.onStatus?.(plan.summary);
  const results = await runFiles(plan.actions);
  task.counts.files += plan.actions.length;
  deps.log.write({ type: "files", runId: deps.log.runId, t: now(), taskId: task.id, sub: k, op, actions: plan.actions, results });
  const failed = results.filter(r => !r.ok);
  const done = results.filter(r => !r.detail.startsWith("made folder"));
  deps.log.write({ type: "verify", runId: deps.log.runId, t: now(), taskId: task.id, sub: k, complete: failed.length === 0, answer: plan.summary, evidence: `${done.filter(r => r.ok).length} checked on disk`, by: "code", ms: 0 });
  if (failed.length) throw new TaskError("driver_refused", `${failed.length} of ${results.length} file actions failed: ${failed.slice(0, 3).map(f => f.detail).join("; ")}`);
  if (plan.answer) return { answer: plan.answer, evidence: `${done.length} result(s) checked on disk: ${done.slice(0, 3).map(r => r.detail).join("; ")}` };
  const past = plan.summary.replace(/^(Move|Copy|Convert|Write)\b/, m => ({ Move: "Moved", Copy: "Copied", Convert: "Converted", Write: "Wrote" }[m]!));
  return { answer: `${past}.`, evidence: `${done.length} result(s) checked on disk: ${done.slice(0, 3).map(r => r.detail).join("; ")}${done.length > 3 ? "; ..." : ""}` };
}
const shortName = (p: string) => p.split(/[\\/]/).pop();

/** An answer part. After other parts (look something up, then compare), it is written from what they found, not
 *  from what Claude guessed while planning. */
async function answerPart(task: Task, sub: Subtask, notes: string[], deps: AgentDeps): Promise<{ answer: string; evidence: string }> {
  if (sub.surface.kind !== "answer") throw new Error("not an answer part");
  if (!notes.length || !deps.claude?.answerFrom) return { answer: sub.surface.reply, evidence: "answered by Claude; no computer action was needed" };
  const r = await deps.claude.answerFrom(task.instruction, sub.goal, notes);
  task.counts.claude++;
  return { answer: r.answer, evidence: `written from the results of the earlier steps: ${notes.join(" | ").slice(0, 200)}` };
}

/** A Word document written through Word itself (headings, bullets), shown, not saved; checked by reading it back. */
async function runDocumentPart(task: Task, k: number, sub: Subtask, notes: string[], deps: AgentDeps): Promise<{ answer: string; evidence: string }> {
  if (sub.surface.kind !== "document") throw new Error("not a document part");
  const { title } = sub.surface;
  const text = sub.surface.text.replace("{previous answer}", notes.at(-1) ?? "").trim() || notes.join("\n\n");
  if (!text) throw new TaskError("needs_info", "What should the document say?");
  deps.onStatus?.(`writing "${title}" in a new Word document`);
  const r = await createWordDocument(title, text);
  task.counts.gui++;
  const expected = toParagraphs(title, text).reduce((n, p) => n + p.text.length + 1, 0);
  const complete = r.ok && r.chars >= expected * 0.9;
  const evidence = r.ok ? `Word reports ${r.chars} characters in ${r.paragraphs} paragraphs in ${r.name} (expected about ${expected})` : `Word: ${r.error}`;
  deps.log.write({ type: "verify", runId: deps.log.runId, t: now(), taskId: task.id, sub: k, complete, answer: title, evidence, by: "code", ms: r.ms });
  if (!r.ok) throw new TaskError("driver_refused", `Word could not be used: ${r.error}`);
  if (!complete) throw new TaskError("false_done", `the document in Word is shorter than what was written (${evidence})`);
  return { answer: `I wrote "${title}" in a new Word document (${r.name}, ${r.paragraphs} paragraphs). It isn't saved yet: press Ctrl+S in Word to keep it.`, evidence };
}

async function ask(task: Task, deps: AgentDeps, id: string, action: string, why: string): Promise<boolean> {
  deps.onStatus?.(`waiting for your approval: ${action}`);
  const request = { id, taskId: task.id, action, why };
  const ok = await deps.approve(request);
  task.counts.approvals++;
  deps.log.write({ type: "approval", runId: deps.log.runId, t: now(), taskId: task.id, request, approved: ok });
  return ok;
}

// ------------------------------------------------------------------ checks
/** What the window looked like when the part started: music already playing then is not what was asked for. */
export interface CheckStart { title?: string; playing?: boolean; query?: string }

/** A check in code (stronger than reading the screen). null = this part has none. */
export function codeCheck(check: Check | undefined, obs: Observation, items: Item[], start: CheckStart = {}): { complete: boolean; answer: string; evidence: string } | null {
  if (!check) return null;
  if (check.kind === "display_equals") {
    const re = typeof check.label === "string" ? new RegExp(`^${check.label}`) : check.label;
    const line = obs.text.find(t => re.test(t));
    const shown = line ? Number(line.replace(re, "").replace(/[^\d.\-]/g, "")) : NaN;
    const ok = Number.isFinite(shown) && Math.abs(shown - check.expected) <= Math.max(1e-9, Math.abs(check.expected) * 1e-9);
    return { complete: ok, answer: `The result is ${line ? line.replace(re, "") : "not shown"}.`, evidence: line ? `${line} (expected ${check.expected})` : `no '${re.source}' text on screen` };
  }
  if (check.kind === "playing") {
    // Something new is playing when the window changed since the part started (or names what was asked for).
    const changed = !start.playing || obs.title !== start.title || (!!start.query && wordsMatch(start.query, obs.title));
    // Media players show a Pause button while something plays (YouTube "Pause (k)", Spotify "Pause").
    const pause = obs.elements.find(e => /^(button|other)$/.test(e.role) && /^pause( \(k\))?$/i.test((e.label ?? "").trim()));
    if (pause && changed) return { complete: true, answer: "It's playing.", evidence: `the player shows '${pause.label}'` };
    // Spotify's window title is "Artist - Song" while it plays and "Spotify Premium" / "Spotify Free" when it does not
    // (its player bar can be beyond the controls the window reports).
    if (spotifyPlaying(obs) && (obs.title !== start.title || (!!start.query && wordsMatch(start.query, obs.title)))) {
      return { complete: true, answer: `It's playing: ${obs.title}.`, evidence: `Spotify's window title shows "${obs.title}"` };
    }
    return { complete: false, answer: "", evidence: pause ? `the player shows '${pause.label}', but it was already playing before` : "no Pause button showing, so nothing is playing yet" };
  }
  const clean = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  // The full value from the window: items carry a shortened copy (200 characters) for the deciders.
  const full = (i: Item) => String(obs.elements.find(e => e.token === i.token)?.value ?? i.value ?? "");
  const field = items.find(i => i.role === check.role && clean(full(i)) === clean(check.expected));
  const any = items.find(i => i.role === check.role);
  return field
    ? { complete: true, answer: `Wrote "${check.expected.slice(0, 80)}" in ${obs.title}.`, evidence: `${field.role} '${field.text}' reads back "${(field.value ?? "").slice(0, 80)}"` }
    : { complete: false, answer: "", evidence: `${check.role} holds "${(any?.value ?? "").slice(0, 80)}", expected "${check.expected.slice(0, 80)}"` };
}

// ------------------------------------------------------------------ window parts
async function runWindowPart(task: Task, k: number, sub: Subtask, notes: string[], deps: AgentDeps, hand: HandName): Promise<{ answer: string; evidence: string }> {
  const { driver, claude, jev, log, signal } = deps;
  if (sub.surface.kind !== "browser" && sub.surface.kind !== "app") throw new Error(`${sub.surface.kind} part in the window loop`);
  const surface = sub.surface;
  // Open-ended web tasks (search, pick, fill in) need more steps than a single form.
  const maxSteps = deps.maxSteps ?? (surface.kind === "browser" ? 40 : 30);
  const where = surface.kind === "browser" ? `the browser at ${surface.url}` : `the app ${surface.app}`;

  deps.onStatus?.(`opening ${where}`);
  await driver.ensureSession(hand);
  const tOpen = performance.now();
  let w: WindowRef = await driver.open(hand, surface);
  deps.onWindow?.(w);
  log.write({ type: "notice", runId: log.runId, t: now(), level: "info", text: `${task.id}/${k}: opened ${where} in ${Math.round(performance.now() - tOpen)} ms` });
  const history: string[] = [`opened ${where}`];
  let tried: string[] = [];
  let prevSig = "", actedLast = false, idle = 0, repeats = 0, rescues = 0, falseDone = 0, reconnects = 0, refusals = 0, waits = 0;
  let lastTyped: { id: string } | undefined;
  const typedIds = new Set<string>();
  let peekedSig = "", safeMoves = 0, settles = 0, consentClicks = 0, newDocTried = false, firstTried = false;
  let forceWhy = "";                       // the next decision goes to Claude with this reason
  const facts: string[] = [];              // learned during this part; kept for every later step (history keeps 8)
  const readPages = new Set<string>(), scrolls = new Map<string, number>();
  const mediaTried = new Set<string>();
  let emptyWaits = 0, sparseWaits = 0, retriedStuck = false;
  let start: CheckStart | undefined;          // the window when the part started (for the "playing" check)
  const searchedFor = new Set<string>();      // what the agent already searched for in the app (once each)
  const appName = surface.kind === "app" ? surface.app : "";
  const wants = goalValues(sub.goal, appName);  // who or what the goal asks to reach, and the texts it gives
  const sendOk = SEND_INTENT.test(sub.goal);    // only then may a message field be filled, or Enter / Send pressed in it
  let toggleClicks = 0;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) throw new TaskError("stopped", "stopped by you");
    const t0 = performance.now();

    // OBSERVE (exactly once per step: a newer snapshot makes older control tokens stale)
    deps.onStatus?.(`step ${step}: reading the window`);
    let obs: Observation;
    try {
      obs = await driver.observe(hand, w);
    } catch (e) {
      const err = e as DriverError;
      if (RECONNECT.includes(err.code) && reconnects < 3) {
        reconnects++;
        await driver.ensureSession(hand).catch(() => {});
        // Re-binding the browser keeps its page. An app window keeps its id, so it is reopened only if it is gone.
        if (w.kind === "browser") w = await driver.open(hand, { kind: "browser", url: "" });
        else if (err.code === "window_lost") w = (await driver.rebind?.(hand, w).catch(() => null)) ?? await driver.open(hand, surface);
        deps.onWindow?.(w);
        step--; continue;
      }
      throw err;
    }
    const tObs = performance.now();

    // PERCEIVE + facts in code
    const { items, dropped } = perceive(obs, `${task.instruction} ${sub.goal} ${sub.values.map(v => v.text).join(" ")}`, 120);
    // A page or window that is still loading shows nothing: wait for it (no model call) instead of judging an empty screen.
    // (Apps get longer: Spotify and other web-view apps can show an empty window for several seconds while starting.)
    if (!items.length && !obs.text.length && emptyWaits < (w.kind === "app" ? 14 : 8)) {
      emptyWaits++; deps.onStatus?.(`step ${step}: waiting for the page to load`);
      await Bun.sleep(700); step--; continue;
    }
    // An app that still shows nothing after that draws its window in a way accessibility tools cannot read (some game
    // launchers): say so now rather than wait on it.
    if (!items.length && !obs.text.length && w.kind === "app") {
      const name = obs.title || (surface.kind === "app" ? surface.app : "This app"), uri = surface.kind === "app" ? surface.uri : undefined;
      throw new TaskError("needs_info", `${name} doesn't show its buttons or text to accessibility tools, so I can't see or use it.${uri ? ` I opened it with its own link (${uri}), so it may already be doing what you asked.` : ""}`);
    }
    emptyWaits = 0;
    if (!start) start = sub.check?.kind === "playing" ? { title: obs.title, playing: !!codeCheck(sub.check, obs, items)?.complete || spotifyPlaying(obs), query: mediaQuery(sub) } : {};
    // A part with a code check (Calculator display, text read back, a Pause button) is done the moment it passes.
    if (sub.check && step > 1) {
      const c = codeCheck(sub.check, obs, items, start);
      if (c?.complete) {
        log.write({ type: "verify", runId: log.runId, t: now(), taskId: task.id, sub: k, complete: true, answer: c.answer, evidence: c.evidence, by: "code", ms: 0 });
        return { answer: c.answer, evidence: c.evidence };
      }
    }
    // A player page still filling in (YouTube's results arrive after its header, Spotify's search after its frame):
    // wait for it, without asking a model.
    if (sub.check?.kind === "playing" && items.length < 6 && obs.text.length < 3 && sparseWaits < 6) {
      sparseWaits++; deps.onStatus?.(`step ${step}: waiting for the page to fill in`);
      await Bun.sleep(800); step--; continue;
    }
    // Mute / unmute / deafen: the toggle is read and pressed in code; done the moment it shows the wanted state
    const toggle = w.kind === "app" ? toggleGoal(sub.goal) : undefined;
    if (toggle) {
      const st = toggleState(toggle, items);
      const word = toggle.what === "mute" ? (toggle.on ? "muted" : "unmuted") : (toggle.on ? "deafened" : "undeafened");
      if (st.on === toggle.on) {
        const evidence = st.on ? `'${st.release!.text}' is shown` : `'${st.press!.text}' is shown and not on`;
        log.write({ type: "verify", runId: log.runId, t: now(), taskId: task.id, sub: k, complete: true, answer: `You're ${word}.`, evidence, by: "code", ms: 0 });
        return { answer: `You're ${word} in ${obs.title.replace(/\s+[-–]\s+.*$/, "") || appName}.`, evidence };
      }
      const press = toggle.on ? st.press : st.release;
      if (st.on !== undefined && press && toggleClicks < 2) {
        toggleClicks++;
        deps.onStatus?.(`step ${step}: pressing '${press.text}'`);
        const ta = performance.now();
        const acted: ActSpec = { tool: "click", token: press.token };
        const result = await driver.act(hand, w, acted);
        task.counts.steps++; task.counts.gui++;
        const decision: Decision = { kind: "click", item: press.i, conf: { kind: 1, item: 1 }, gate: 1, backend: "rule", why: `the goal is to be ${word}; '${press.text}' does that`, model: "rule", inputTokens: 0, outputTokens: 0, ms: 0 };
        log.write({ type: "step", runId: log.runId, t: now(), taskId: task.id, sub: k, step, window: { title: obs.title, url: obs.url }, items, nDropped: dropped, decision, acted, result,
          ms: { observe: Math.round(tObs - t0), decide: 0, act: Math.round(performance.now() - ta), total: Math.round(performance.now() - t0) } });
        history.push(`clicked '${press.text}'`);
        await Bun.sleep(400);
        continue;
      }
    }

    const sig = signature(obs, items);
    if (sig === prevSig) { if (actedLast) idle++; } else { idle = 0; repeats = 0; tried = []; }
    prevSig = sig;
    const state: StepState = {
      instruction: task.instruction, sub, notes: [...notes, ...facts], surface: w.kind, windowTitle: obs.title, url: obs.url,
      screenText: obs.text, items, previousActions: history.slice(-8), alreadyTriedHere: tried, canGoToUrl: !!claude,
      conversation: deps.conversation,
    };
    const jevState: StepState = { ...state, screenText: screenText(obs, 2500) };

    // What the goal asks to reach ("message Mohit", "open the chat with Mum") isn't on screen, but the app has a
    // search field: search for it (what a person does) instead of clicking whatever else is there. On screen = a
    // control whose label STARTS with it (a mention inside some message text doesn't count). (Mac version.)
    if (w.kind === "app" && wants.targets.length) {
      const low = (x: string) => x.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
      const shown = (t: string) => items.some(i => !TYPEABLE.includes(i.role) && low(i.text).startsWith(low(t)));
      const missing = wants.targets.find(t => low(t).length >= 2 && !shown(t) && !searchedFor.has(low(t)));
      const search = missing ? items.find(i => (TYPEABLE.includes(i.role) || i.role === "pop-up") && isFindField(i.text)) : undefined;
      if (missing && search) {
        searchedFor.add(low(missing));
        deps.onStatus?.(`step ${step}: searching for ${missing}`);
        const ta = performance.now();
        const acted: ActSpec = { tool: "type", token: search.token, text: missing };
        const result = await driver.act(hand, w, acted);
        task.counts.steps++; task.counts.gui++;
        const decision: Decision = { kind: "type", item: search.i, text: missing, conf: { kind: 1, item: 1 }, gate: 1, backend: "rule", why: `"${missing}" is not on screen: searched for it`, model: "rule", inputTokens: 0, outputTokens: 0, ms: 0 };
        log.write({ type: "step", runId: log.runId, t: now(), taskId: task.id, sub: k, step, window: { title: obs.title, url: obs.url }, items, nDropped: dropped, decision, acted, result,
          note: `searched for "${missing}" (it was not on screen) in '${search.text}'`, ms: { observe: Math.round(tObs - t0), decide: 0, act: Math.round(performance.now() - ta), total: Math.round(performance.now() - t0) } });
        history.push(`searched for "${missing}" in '${search.text}'${result.ok ? "" : " (refused)"}`);
        lastTyped = { id: search.id };
        actedLast = true;
        await Bun.sleep(800);
        continue;
      }
    }

    // DECIDE: jev first; on doubt, jev again with only its top candidates; then Claude if there is one
    deps.onStatus?.(`step ${step}: deciding`);
    let why = forceWhy;
    forceWhy = "";
    let narrowTo: number[] | undefined;
    if (idle >= 2 || repeats >= 1 || waits >= 3) {
      if (rescues >= 2) throw new TaskError("stalled", "the last actions kept leaving the window unchanged");
      rescues++;
      why = waits >= 3 ? "the window has looked unchanged through several waits; decide whether to act or stop"
        : "the last actions did not change the window (or repeated an earlier one); choose something different from what was already tried";
      waits = 0;
      // Without Claude: ask jev again with the controls it already tried taken out.
      const triedIds = new Set(tried.map(t => t.split(":").slice(1, -1).join(":")));
      narrowTo = items.filter(i => !triedIds.has(i.id)).map(i => i.i);
    } else if (!jev) why = "the fast classifier (TypeSafe jev) is not configured";

    let dec: Decision | undefined, unsure: Decision | undefined;
    // A cookie wall: choose the private option ("Reject all") in code. Never "Accept all" without the user.
    const reject = w.kind === "browser" && consentClicks < 2 ? consentReject(obs, items) : undefined;
    const media = !reject && sub.check?.kind === "playing" ? mediaStep(items, mediaQuery(sub), mediaTried) : undefined;
    if (reject) {
      readPages.delete(obs.url ?? obs.title);         // what was read behind the banner may not be the page
      consentClicks++;
      dec = { kind: "click", item: reject.i, conf: { kind: 1, item: 1 }, gate: 1, backend: "rule", why: "cookie banner: the private choice", model: "rule", inputTokens: 0, outputTokens: 0, ms: 0 };
    } else if (media) {
      // Playing something: skip an ad, press a paused player's Play, or start the first result that matches.
      mediaTried.add(media.item.id);
      dec = { kind: "click", item: media.item.i, conf: { kind: 1, item: 1 }, gate: 1, backend: "rule", why: media.why, model: "rule", inputTokens: 0, outputTokens: 0, ms: 0 };
    } else if (jev && (!why || (!claude && narrowTo))) {
      try {
        dec = await jev.decide(jevState, narrowTo);
        task.counts.jev++; task.cost.jevUsd += dec.inputTokens * JEV_USD_PER_INPUT_TOKEN;
        let doubt = jevDoubt(dec);
        if (doubt && dec.probs?.item && !narrowTo) {
          // A narrower question often settles it: re-ask with only the six likeliest controls.
          const top = Object.entries(dec.probs.item).filter(([key]) => key !== "none").sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key]) => Number(key));
          if (top.length > 1) {
            const again = await jev.decide(jevState, top);
            task.counts.jev++; task.cost.jevUsd += again.inputTokens * JEV_USD_PER_INPUT_TOKEN;
            const doubt2 = jevDoubt(again);
            if (!doubt2) { dec = { ...again, why: `re-asked with the top ${top.length} controls after: ${doubt}` }; doubt = ""; }
          }
        }
        if (doubt) { why = why || doubt; unsure = dec; dec = undefined; }
      } catch (e) {
        why = `the fast classifier failed (${(e as Error).message.slice(0, 120)})`;
        dec = undefined;
      }
    }
    if (!dec && !claude && jev?.extra && sub.question && peekedSig !== sig && !why.startsWith("the last actions")) {
      // jev was unsure what to DO; the answer may already be on screen. Look before giving up (read-only).
      peekedSig = sig;
      deps.onStatus?.(`step ${step}: looking for the answer on screen`);
      const tv = performance.now();
      const v = await jevVerify(task, sub, state, obs, w, deps, hand);
      if (v.read) prevSig = "";
      log.write({ type: "verify", runId: log.runId, t: now(), taskId: task.id, sub: k, complete: v.complete, answer: v.answer, evidence: v.evidence, by: "jev", ms: Math.round(performance.now() - tv) });
      if (v.complete) return { answer: v.answer, evidence: v.evidence };
      history.push("looked for the answer on screen: not there yet");
    }
    if (!dec && !claude && unsure?.kind === "click" && !firstTried && /open the first matching result/i.test(sub.goal)) {
      // "play X on YouTube": the results are open and jev cannot choose among them; the first result that matches is.
      const first = firstMatch(items, sub.values[0]?.text ?? "");
      if (first) { firstTried = true; dec = { ...unsure, item: first.i, backend: "rule", why: `${why}; opened the first result matching "${sub.values[0].text}"` }; }
    }
    if (!dec && !claude && unsure && ["scroll_down", "scroll_up", "wait"].includes(unsure.kind) && safeMoves < 4) {
      // An unsure scroll or wait cannot change anything, so it is safe to try.
      safeMoves++;
      dec = { ...unsure, why: `${why}; a ${unsure.kind.replace("_", " ")} changes nothing, so it is tried anyway` };
    } else if (!dec && !claude && unsure && settles < 2) {
      // The page may still be loading (results, menus): wait and look again before giving up.
      settles++;
      dec = { ...unsure, kind: "wait", item: undefined, why: `${why}; waiting for the window to settle, then looking again` };
    }
    if (!dec) {
      if (!claude) {
        throw new TaskError(why.startsWith("the last actions") || why.startsWith("the window") ? "stalled" : "low_confidence",
          `${why || "no decision"}. Stopping rather than guessing (an ANTHROPIC_API_KEY would let Claude take over such steps).`);
      }
      dec = await claude.decide(state, why);
      task.counts.claude++;
    }
    const tDec = performance.now();
    task.counts.steps++;

    const it: Item | undefined = dec.item !== undefined ? items[dec.item] : undefined;
    let acted: ActSpec | undefined, result: ActionResult | undefined, note = "";
    const logStep = () => {
      const tEnd = performance.now();
      log.write({
        type: "step", runId: log.runId, t: now(), taskId: task.id, sub: k, step, window: { title: obs.title, url: obs.url },
        items, nDropped: dropped, decision: dec!, acted, result, note: note || undefined,
        ms: { observe: Math.round(tObs - t0), decide: Math.round(tDec - tObs), act: Math.round(tEnd - tDec), total: Math.round(tEnd - t0) },
      });
    };

    // A question on a web page: reading the whole page (one read-only call, ~0.3 s) finds what scrolling would find
    // screen by screen. Once per page. If the answer is not on it, Claude is told so (or the user, without Claude).
    const pageKey = obs.url ?? obs.title;
    if (sub.question && w.kind === "browser" && (dec.kind === "scroll_down" || dec.kind === "scroll_up") && driver.readMore && !readPages.has(pageKey)) {
      readPages.add(pageKey);
      deps.onStatus?.(`step ${step}: reading the whole page`);
      const tv = performance.now();
      let v: { complete: boolean; answer: string; evidence: string }, by: "claude" | "jev";
      const lines = await driver.readMore(hand, w);
      if (lines.join(" ").length < 1500) readPages.delete(pageKey);   // still loading or behind a banner: not really read
      if (claude) {
        v = await claude.verify({ ...state, screenText: lines }, 30_000); by = "claude"; task.counts.claude++;
      } else if (jev?.extra) {
        v = await jevVerify(task, sub, { ...state, screenText: lines }, obs, w, deps, hand); by = "jev";
      } else throw new TaskError("low_confidence", "nothing available to check the result");
      prevSig = "";                                  // the extra read made this step's tokens stale
      log.write({ type: "verify", runId: log.runId, t: now(), taskId: task.id, sub: k, complete: v.complete, answer: v.answer, evidence: v.evidence, by, ms: Math.round(performance.now() - tv) });
      if (v.complete) { note = `answered from the whole page (${by})`; logStep(); return { answer: v.answer, evidence: v.evidence }; }
      note = "read the whole page: the answer is not on it"; logStep(); actedLast = false;
      history.push(`read the whole page "${obs.title}": the answer is not on it (${v.evidence.slice(0, 160)})`);
      facts.push(`The whole page ${pageKey} was read: it does not have the answer (${v.evidence.slice(0, 200)}). Do not scroll it or go back to it.`);
      if (!claude) throw new TaskError("needs_info", `I read the whole page "${obs.title}" and it does not answer this. Try asking it another way, or name a site that has it.`);
      forceWhy = "the whole page was read and the answer is not on it: do not scroll; open a page that has the answer (for example a web search for it), or stop if it cannot be found";
      continue;
    }

    // DONE: a code check, else Claude, else jev must agree before the part counts as done
    if (dec.kind === "done") {
      deps.onStatus?.(`step ${step}: checking the result`);
      const tv = performance.now();
      let v: { complete: boolean; answer: string; evidence: string }, by: "code" | "claude" | "jev";
      const c = codeCheck(sub.check, obs, items, start);
      if (c) { v = c; by = "code"; }
      else if (claude) {
        // A web answer is often further down than the screen (a top-10 list): check against the whole page.
        const whole = w.kind === "browser" && sub.question && driver.readMore ? await driver.readMore(hand, w).catch(() => []) : [];
        v = await claude.verify(whole.length > obs.text.length ? { ...state, screenText: whole } : state, whole.length ? 30_000 : 16_000);
        by = "claude"; task.counts.claude++;
      }
      else if (jev?.extra) {
        const r = await jevVerify(task, sub, state, obs, w, deps, hand);
        if (r.read) prevSig = "";                    // the extra reading made this step's tokens stale
        v = r; by = "jev";
      } else throw new TaskError("low_confidence", "nothing available to check the result");
      log.write({ type: "verify", runId: log.runId, t: now(), taskId: task.id, sub: k, complete: v.complete, answer: v.answer, evidence: v.evidence, by, ms: Math.round(performance.now() - tv) });
      note = v.complete ? `verified by ${by}` : `not done yet (${by}): ${v.evidence}`;
      logStep();
      if (v.complete) return { answer: v.answer, evidence: v.evidence };
      task.counts.falseDoneCaught++;
      falseDone++;
      history.push(`said done, but the ${by} check disagreed (${v.evidence.slice(0, 120)})`);
      // A check in code costs nothing and a page or player that is still loading often fails it once (YouTube between
      // the results and the player): one more try, after a short wait. A model check gets two.
      const strikes = by === "code" ? 3 : 2;
      if (falseDone >= strikes) throw new TaskError("false_done", `the goal looked done ${falseDone} times but the ${by} check disagrees: ${v.evidence}`);
      tried.push("done"); actedLast = false;
      if (by === "code") await Bun.sleep(1000);
      continue;
    }
    if (dec.kind === "stuck") {
      const why = dec.reason || "the agent could not see a way to reach the goal from this window";
      // On the web there is usually another way (other dates, a nearby airport or city, another site): one more try.
      if (w.kind === "browser" && claude && !retriedStuck) {
        retriedStuck = true;
        note = "about to give up: trying another way first"; logStep(); actedLast = false;
        history.push(`was about to stop: ${why.slice(0, 160)}`);
        facts.push(`It looked impossible once: ${why.slice(0, 200)}. Another way was tried after that.`);
        forceWhy = `you were about to stop because: ${why.slice(0, 200)}. Try another way once before stopping: change the search (other words, dates or places, fewer filters) or open a different site that has it. Choose stuck again only if there is truly no way`;
        deps.onStatus?.(`step ${step}: that didn't work, trying another way`);
        continue;
      }
      logStep();
      throw new TaskError("needs_info", why);
    }
    if (dec.kind === "wait") {
      waits++;
      // An app that is downloading, updating or installing can take many minutes: say so and stop instead of waiting
      // (the user is told what it is doing and the browser / app hand is free for other tasks).
      const busy = waits >= 3 && w.kind === "app" ? busyLine(obs) : undefined;
      if (busy) {
        note = `still busy: ${busy}`; logStep();
        throw new TaskError("needs_info", `${obs.title} is still busy ("${busy}"). I've stopped waiting so you can do other things; ask me again when it has finished.`);
      }
      deps.onStatus?.(`step ${step}: waiting${dec.reason ? ` (${dec.reason.slice(0, 120)})` : " for the window"}`);
      note = "waiting"; logStep(); actedLast = false; await Bun.sleep(1200); continue;
    }
    waits = 0;

    // BUILD THE ACTION + GUARDRAILS
    const triedKey = `${dec.kind}:${it?.id ?? ""}:${dec.text ?? dec.url ?? ""}`;
    if (tried.includes(triedKey)) repeats++;
    tried.push(triedKey);
    let describe = "";
    if ((dec.kind === "scroll_down" || dec.kind === "scroll_up") && sub.question && readPages.has(pageKey) && w.kind === "browser") {
      // This page was read in full already and does not have the answer: scrolling it cannot help.
      note = "this page was already read in full"; logStep(); actedLast = false;
      if (!claude || dec.backend === "claude") throw new TaskError("needs_info", `I read the whole page "${obs.title}" and it does not answer this.`);
      forceWhy = "this page was already read in full and does not have the answer: open a different page (a DuckDuckGo search) or stop";
      continue;
    }
    if (dec.kind === "scroll_down" || dec.kind === "scroll_up") {
      const n = (scrolls.get(pageKey) ?? 0) + 1;
      scrolls.set(pageKey, n);
      if (n > 8) {
        // Scrolling back and forth on one page is a loop, even though each scroll changes the screen.
        note = "too much scrolling on this page"; logStep(); actedLast = false;
        if (!claude || n > 10) throw new TaskError("stalled", `scrolled ${n - 1} times on "${obs.title}" without reaching the goal`);
        forceWhy = `scrolled ${n - 1} times on this page without reaching the goal: choose a different action (open another page, use a control) or stop`;
        continue;
      }
      const dir = dec.kind === "scroll_down" ? "down" : "up";
      acted = { tool: "scroll", direction: dir }; describe = `scrolled ${dir}`;
    } else if (dec.kind === "go_to_url") {
      let url = dec.url ?? sub.values.find(v => /^https?:\/\//i.test(v.text))?.text;
      if (!url && claude) { url = (await claude.url(state)).url; task.counts.claude++; }
      if (!url || !/^https?:\/\//i.test(url)) { note = `no valid address (${url ?? "none"})`; history.push(`could not open a page: ${note}`); logStep(); actedLast = false; continue; }
      if (w.kind !== "browser") { note = "go_to_url only works in the browser"; history.push(note); logStep(); actedLast = false; continue; }
      url = searchUrl(url);
      acted = { tool: "navigate", url }; describe = `opened ${url}`;
    } else if (dec.kind === "press_enter") {
      const target = (lastTyped && items.find(x => x.id === lastTyped!.id)) ?? it;
      if (!target && w.kind === "browser") { note = "no field to press Enter in"; history.push(note); logStep(); actedLast = false; continue; }
      // SAFETY: Enter in a message field sends it: only when the goal asks to send something
      if (target && isMessageField(target.text) && !sendOk) {
        note = `blocked: Enter in '${target.text}' would send it, and the goal does not ask to send anything`; history.push(note); logStep(); actedLast = false; continue;
      }
      acted = { tool: "key", key: "enter", token: target?.token }; describe = `pressed Enter${target ? ` in '${target.text}'` : ""}`;
    } else if (dec.kind === "click") {
      if (!it) { note = "no control chosen"; logStep(); actedLast = false; continue; }
      // SAFETY: a Send button only when the goal asks to send something
      if (/^send\b/i.test(it.text.trim()) && !sendOk) { note = "blocked: the goal does not ask to send anything"; history.push(`did not click '${it.text}': ${note}`); logStep(); actedLast = false; continue; }
      // Two controls with the same label (a chat-list row and the chat's header title): the one in a list is the item.
      const row = it.role !== "list item" ? items.find(x => x !== it && x.role === "list item" && x.text.trim() === it.text.trim()) : undefined;
      const target = row ?? it;
      if (row) note = `the list row '${row.text}', not the ${it.role} with the same name`;
      const risky = clickNeedsApproval(target);
      if (risky && !(await ask(task, deps, `${task.id}-${k}-${step}`, `Click '${target.text}' in ${obs.title}`, risky))) {
        note = "you declined"; logStep(); throw new TaskError("declined", `you declined: click '${target.text}'`);
      }
      acted = { tool: "click", token: target.token }; describe = `clicked ${target.role} '${target.text}'`;
    } else if (dec.kind === "type") {
      if (!it) { note = "no field chosen"; logStep(); actedLast = false; continue; }
      // A desktop app's search box is often a combo box (Spotify's "What do you want to play?"): it takes typing too.
      if (!TYPEABLE.includes(it.role) && !(w.kind === "app" && it.role === "pop-up")) {
        note = `cannot type into a ${it.role}`; history.push(`tried to type into ${it.role} '${it.text}' (not a text field)`); logStep(); actedLast = false; continue;
      }
      const secret = typingForbidden(it);
      if (secret) { note = secret; logStep(); throw new TaskError("unsafe", secret); }
      let text = dec.text;
      if (dec.backend === "jev" && (!dec.valueName || (dec.conf.value ?? 0) < GATE)) {
        // With a single prepared text there is nothing to choose: jev picked the field, the text is that one.
        text = sub.values.length === 1 ? sub.values[0].text : undefined;
      }
      // Which value goes in THIS field is decided by what the field is for (Mac version): a search or recipient field
      // gets who to reach, a message field what to say, and a message field is filled only when the goal asks to send.
      const messageField = w.kind === "app" && isMessageField(it.text);
      if (messageField && !sendOk) {
        note = `blocked: '${it.text}' is a message field and the goal does not ask to send anything`; history.push(note); logStep(); actedLast = false; continue;
      }
      if (w.kind === "app" && isFindField(it.text) && wants.targets.length === 1 && dec.backend !== "claude") text = wants.targets[0];
      if (messageField && text !== undefined && wants.targets.some(t => t.toLowerCase() === text!.trim().toLowerCase())) {
        // the name of who to reach never goes into a message field: the message is the other value, if there is one
        const say = messageOf(sub.goal, appName).text ?? sub.values.find(v => v.name === "message")?.text;
        if (!say) { note = `blocked: "${text}" is who to reach, not what to say`; history.push(note); logStep(); actedLast = false; continue; }
        text = say;
      }
      if (text === undefined) {
        if (!claude) { note = "no prepared text fits"; logStep(); throw new TaskError("needs_info", `I don't know what to type into '${it.text}'. Put the text in quotes in your instruction.`); }
        text = (await claude.write(state, it)).text;
        task.counts.claude++;
        note = "text written by Claude";
      }
      // Personal details (a booking's passenger form) only from the user's own words: otherwise this is as far as the
      // agent goes, the step before paying, and the part ends here with that said plainly.
      const personal = personalDetailsMissing(it, text, task.instruction);
      if (personal) {
        note = "personal details: stopped before filling them"; logStep();
        return { answer: `${personal} (Page: "${obs.title}".)`, evidence: `stopped at the field '${it.text}' on ${obs.url ?? obs.title}` };
      }
      // Typing replaces a field's content. In a desktop app, existing text the agent did not write may be yours:
      // open a new tab/document if the app offers one, else ask before replacing it.
      const fresh = w.kind === "app" && it.value && !typedIds.has(it.id) && !newDocTried
        ? items.find(x => x.role === "button" && /^(add new tab|new tab|new document|new blank document)$/i.test(x.text)) : undefined;
      if (fresh) {
        newDocTried = true;
        acted = { tool: "click", token: fresh.token }; describe = `clicked '${fresh.text}' so the text already there stays`;
      } else {
        if (w.kind === "app" && it.value && !typedIds.has(it.id) && (it.role === "text area" || it.value.length > 60)) {
          const action = `Replace the text in '${it.text}' (${obs.title}), which starts "${it.value.slice(0, 60)}"`;
          if (!(await ask(task, deps, `${task.id}-${k}-${step}`, action, "this text was already there; replacing it may lose your work"))) {
            note = "you declined"; logStep(); throw new TaskError("declined", `you declined: ${action}`);
          }
        }
        acted = { tool: "type", token: it.token, text }; describe = `typed ${JSON.stringify(text.slice(0, 80))} into '${it.text}'`;
        lastTyped = { id: it.id };
        typedIds.add(it.id);
      }
    }

    // ACT
    deps.onStatus?.(`step ${step}: ${describe}`);
    result = await driver.act(hand, w, acted!);
    // A click can open a new tab: follow it so the next step reads the page the user would now see.
    if (result.ok && w.kind === "browser" && acted!.tool === "click" && driver.followActiveTab) w = await driver.followActiveTab(hand, w).catch(() => w);
    task.counts.gui++;
    logStep();
    actedLast = true;
    if (!result.ok) {
      const code = result.error?.code ?? "other";
      history.push(`${describe} -> refused (${code}${result.error?.hint ? `: ${result.error.hint.slice(0, 100)}` : ""})`);
      if (RECONNECT.includes(code)) { prevSig = ""; continue; }
      if (++refusals >= 3) throw new TaskError("driver_refused", `the window refused actions three times (last: ${code} ${result.error?.hint ?? ""})`);
      continue;
    }
    history.push(describe);
  }
  throw new TaskError("step_limit", `more than ${maxSteps} steps for: ${sub.goal}`);
}

/** "mute me on Discord", "unmute my mic", "deafen": a call's own toggle, read and pressed in code (no model) */
export function toggleGoal(goal: string): { what: "mute" | "deafen"; on: boolean } | undefined {
  const g = goal.toLowerCase();
  if (/\bun-?mut(e|ed|ing)\b/.test(g)) return { what: "mute", on: false };
  if (/\bun-?deafen(ed|ing)?\b/.test(g)) return { what: "deafen", on: false };
  if (/\bdeafen(ed|ing)?\b/.test(g)) return { what: "deafen", on: true };
  if (/\bmut(e|ed|ing)\b/.test(g)) return { what: "mute", on: true };
  return undefined;
}

/** true = muted (or deafened) now, false = not, undefined = no such control on screen. An "Unmute" button means
 *  muted; a "Mute" button that is on (pressed, checked) means muted; a "Mute" button alone means not muted. Other
 *  people's tiles ("dark_ravager, Muted") don't start with the word, so they don't count. */
export function toggleState(t: { what: "mute" | "deafen" }, items: Item[]): { on?: boolean; press?: Item; release?: Item } {
  const un = items.find(i => new RegExp(`^un${t.what}\\b`, "i").test(i.text.trim()));
  const plain = items.filter(i => new RegExp(`^${t.what}\\b`, "i").test(i.text.trim()) && i.role !== "text");
  const pressed = plain.find(i => i.state === "on" || i.state === "checked" || i.state === "selected");
  if (un || pressed) return { on: true, release: un ?? pressed };
  if (plain.length) return { on: false, press: plain[0] };
  return {};
}

/** jev's check of the screen: is the goal achieved, and (for a question) which line answers it. Reads further down a
 *  web page when the answer is not in the first snapshot. `read` = the page was read further (tokens went stale). */
async function jevVerify(task: Task, sub: Subtask, state: StepState, obs: Observation, w: WindowRef, deps: AgentDeps, hand: HandName) {
  const { jev, driver } = deps;
  // the lines that can answer it: split sentences joined, and (on a long page) the ones shaped like the answer
  const goalText = `${task.instruction} ${sub.goal}`;
  const answerLines = (lines: string[]) => relevantLines(joinFragments(lines), goalText, 150, 20);
  let d = await jev!.extra!.checkDone({ ...state, screenText: answerLines(screenText(obs, 9000)) }, !!sub.question);
  let read = false;
  if (sub.question && (!d.answer || d.answerConf < GATE) && w.kind === "browser" && driver.readMore) {
    // The answer may be further down the page than one snapshot reaches: read more of it and ask again.
    deps.onStatus?.("reading more of the page");
    const more = await driver.readMore(hand, w, 4);
    task.counts.jev++; task.cost.jevUsd += d.inputTokens * JEV_USD_PER_INPUT_TOKEN;
    d = await jev!.extra!.checkDone({ ...state, screenText: answerLines(more) }, true);
    read = true;
  }
  task.counts.jev++; task.cost.jevUsd += d.inputTokens * JEV_USD_PER_INPUT_TOKEN;
  // a quantity question needs a number in the answer, otherwise it is not answered yet; the title is never the answer
  if (sub.question && d.answer && ((NEEDS_NUMBER.test(goalText) && !/\d/.test(d.answer)) || d.answer.trim() === obs.title.trim())) d = { ...d, answer: undefined, answerConf: 0 };
  const complete = d.done >= DONE_P && (!sub.question || (!!d.answer && d.answerConf >= GATE));
  return {
    complete, read, answer: d.answer ?? (complete ? `Done: ${sub.goal.replace(/\s*\([^)]*\)\s*(?=\.?$)/, "").replace(/\.$/, "")}. Now showing "${obs.title}".` : ""),
    evidence: d.answer ? `"${d.answer}" (jev: goal achieved p=${d.done.toFixed(2)}, answer line confidence ${d.answerConf.toFixed(2)})` : `jev: goal achieved p=${d.done.toFixed(2)}`,
  };
}

const CONSENT_PAGE = /\b(cookies?|before you continue|consent|privacy choices|your privacy|informasjonskapsler|før du fortsetter|bevor sie fortfahren|avant de continuer|antes de continuar|prima di continuare)\b/i;
// "Reject all" in the languages a site may pick from the IP address (en, no, sv, da, de, fr, es, it, nl, pt, pl, fi, zh, ja).
const REJECT = /^(reject all|reject( all)? cookies|decline( all)?|refuse all|only (necessary|essential)( cookies)?|(use )?(strictly )?necessary (cookies )?only|continue without accepting|reject non-essential|avvis alle|avvisa alla|neka alla|afvis alle|alle ablehnen|tout refuser|refuser tout|continuer sans accepter|rechazar todo|rechazar todas|rifiuta tutto|rifiuta tutti|alles afwijzen|alles weigeren|rejeitar tudo|recusar tudo|odrzuć wszystkie|hylkää kaikki|全部拒絕|全部拒绝|拒絕全部|すべて拒否)$/i;

/** Spotify's title while it plays: "Artist - Song" (not "Spotify", "Spotify Premium" or "Spotify Free"). */
export function spotifyPlaying(obs: Observation): boolean {
  const t = obs.title.trim();
  return obs.window.kind === "app" && /spotify/i.test(obs.window.app) && /\S \u2013 \S|\S - \S/.test(t) && !/^spotify\b/i.test(t);
}

/** A line on screen saying the window is busy for a while: updating, downloading, installing, a percentage. */
export function busyLine(obs: Observation): string | undefined {
  const BUSY = /\b(updating|downloading|installing|verifying|preparing|patching|queued|update in progress|download in progress)\b|\b\d{1,3}(?:\.\d+)?\s?%/i;
  return obs.text.find(l => BUSY.test(l))?.slice(0, 120)
    ?? obs.elements.map(e => [e.label, e.value].filter(Boolean).join(" ")).find(l => BUSY.test(l))?.slice(0, 120);
}

/** What to play: the planned search words, else the words in a spotify:search: link or a results URL. */
export function mediaQuery(sub: Subtask): string {
  if (sub.values[0]?.text) return sub.values[0].text;
  const s = sub.surface;
  let raw: string | null | undefined = "";
  try {
    raw = s.kind === "app" ? s.uri?.replace(/^spotify:search:/i, "") : s.kind === "browser" ? new URL(s.url).searchParams.get("search_query") ?? new URL(s.url).searchParams.get("q") : "";
    return decodeURIComponent(raw ?? "").replace(/\+/g, " ");
  } catch { return raw ?? ""; }
}

/** Words match when equal, one starts the other, or one letter differs ("weekend" ~ "Weeknd"): speech gets spellings wrong. */
export function wordsMatch(query: string, text: string, need = 0.6): boolean {
  const ws = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !["the", "and", "for", "play", "music", "song", "songs", "video", "videos", "about"].includes(w));
  const q = ws(query), t = ws(text);
  if (!q.length) return false;
  const near = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 5 && b.length >= 5 && edits(a, b) <= 1);
  return q.filter(w => t.some(x => near(w, x))).length >= Math.ceil(q.length * need);
}
function edits(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The next click towards "X is playing": skip an ad, a paused player's Play, a "Play <X>" button, else X's first result. */
export function mediaStep(items: Item[], query: string, tried: Set<string>): { item: Item; why: string } | undefined {
  const fresh = items.filter(i => !tried.has(i.id));
  const skip = fresh.find(i => i.role === "button" && /^skip( ad| ads)?$/i.test(i.text.trim()));
  if (skip) return { item: skip, why: "an ad can be skipped" };
  const paused = fresh.find(i => i.role === "button" && /^play \(k\)$/i.test(i.text.trim()));
  if (paused) return { item: paused, why: "the video is paused: press Play" };
  const playX = fresh.find(i => (i.role === "button" || i.role === "link") && /^play\s+\S/i.test(i.text) && wordsMatch(query, i.text.replace(/^play\s+/i, "")));
  if (playX) return { item: playX, why: `start "${playX.text.replace(/^play\s+/i, "")}"` };
  if (items.some(i => /^(pause|play)( \(k\))?$/i.test(i.text.trim()))) return undefined;      // already on a player
  const first = fresh.find(i => i.role === "link" && i.text.length >= 8 && wordsMatch(query, i.text));
  return first ? { item: first, why: `open the first result for "${query}"` } : undefined;
}

/** The first link (in page order) whose text has most of the query's words: the top search result. */
export function firstMatch(items: Item[], query: string): Item | undefined {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  if (!words.length) return undefined;
  return items.find(i => i.role === "link" && i.text.length >= 8 && words.filter(w => i.text.toLowerCase().includes(w)).length >= Math.ceil(words.length * 0.6));
}

/** On a cookie banner or wall, the "Reject all" style button, if there is one. */
export function consentReject(obs: Observation, items: Item[]): Item | undefined {
  const buttons = items.filter(i => i.role === "button" || i.role === "link");
  // A button that says it rejects cookies is a consent dialog by itself ("Reject the use of cookies and other data ...").
  const selfEvident = buttons.find(i => /^(reject|decline|refuse)\b.{0,80}\bcookies?\b/i.test(i.text.trim()));
  if (selfEvident) return selfEvident;
  if (!CONSENT_PAGE.test(obs.title) && !obs.text.slice(0, 80).some(l => CONSENT_PAGE.test(l))) return undefined;
  return buttons.find(i => REJECT.test(i.text.trim()));
}

/** Why a jev decision should not be acted on as it is, or "" if it is fine. */
function jevDoubt(d: Decision): string {
  if (d.kind === "stuck") return "the fast classifier found nothing on screen that helps";
  if (d.kind !== "done" && d.gate < GATE) return `the fast classifier was unsure (${d.kind}, gate ${d.gate.toFixed(2)} < ${GATE})`;
  if ((d.kind === "click" || d.kind === "type") && d.item === undefined) return `the fast classifier chose ${d.kind} without a control`;
  return "";
}

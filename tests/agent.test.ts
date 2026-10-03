// The whole loop on a simulated desktop, with scripted deciders standing in for jev and Claude.
import { describe, expect, test } from "bun:test";
import { runTask, newTask, type ClaudeLike, type JevLike } from "../src/agent";
import type { Decision, Kind, LogLine, Plan } from "../src/contracts";
import { SimDriver, SITE, type SimPage } from "../src/driver/sim";
import type { StepState } from "../src/jev";
import { MemoryLogger } from "../src/logger";

const browserPlan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "browser", url: "https://search.test/" }, goal: "The founding year of HKU is visible on screen.", values: [{ name: "query", text: "hku" }] }] };

function jevDecision(kind: Kind, item?: number, extra: Partial<Decision> = {}): Decision {
  return { kind, item, conf: { kind: 0.9, item: 0.9, value: 0.9 }, gate: 0.9, backend: "jev", model: "fake-jev", inputTokens: 500, outputTokens: 0, ms: 1, ...extra };
}

/** A fake jev that browses the sim site sensibly. */
function smartJev(): JevLike & { calls: number } {
  return {
    calls: 0,
    async decide(s: StepState) {
      this.calls++;
      const idx = (re: RegExp) => s.items.find(i => re.test(i.text))?.i;
      if (s.url === "https://search.test/") {
        const field = s.items.find(i => i.role === "text field")!;
        return field.value ? jevDecision("press_enter", field.i) : jevDecision("type", field.i, { valueName: "query", text: "hku" });
      }
      if (s.url?.startsWith("https://search.test/?q=")) return jevDecision("click", idx(/Wikipedia/));
      if (s.screenText.some(t => /founded/.test(t))) return jevDecision("done");
      return jevDecision("scroll_down");
    },
  };
}

function fakeClaude(over: Partial<ClaudeLike> = {}): ClaudeLike & { decided: string[] } {
  const decided: string[] = [];
  return {
    decided,
    usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    async plan() { return { plan: browserPlan, ms: 1 }; },
    async decide(_s: StepState, why: string) { decided.push(why); return { kind: "stuck", reason: "cannot continue", conf: { kind: 1 }, gate: 1, backend: "claude", why, model: "fake", inputTokens: 1, outputTokens: 1, ms: 1 } as Decision; },
    async write() { return { text: "written by claude", ms: 1 }; },
    async url() { return { url: "https://search.test/", ms: 1 }; },
    async verify(s: StepState) {
      const hit = s.screenText.find(t => /1911/.test(t));
      return hit ? { complete: true, answer: "HKU was founded in 1911.", evidence: hit, ms: 1 } : { complete: false, answer: "", evidence: "no founding year visible", ms: 1 };
    },
    ...over,
  };
}

const deps = (over: Record<string, unknown> = {}) => ({
  driver: new SimDriver(), log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true, ...over,
}) as any;

describe("runTask", () => {
  test("web question: search, open result, scroll, done is confirmed by a second reading, answer returned", async () => {
    const jev = smartJev(), claude = fakeClaude(), log = new MemoryLogger();
    const t = await runTask(newTask("When was HKU founded?", "typed"), deps({ jev, claude, log }));
    expect(t.status).toBe("done");
    expect(t.result?.answer).toBe("HKU was founded in 1911.");
    expect(t.result?.evidence).toContain("1911");
    expect(t.counts.jev).toBe(5);          // type, enter, click, scroll, done
    expect(t.counts.claude).toBe(2);       // the plan (this fake jev has no classifier) and the final check
    expect(claude.decided).toEqual([]);
    const types = log.lines.map(l => l.type);
    expect(types[0]).toBe("task_start");
    expect(types).toContain("plan");
    expect(types).toContain("verify");
    expect(types.at(-1)).toBe("task_end");
  });

  test("jev unsure (gate < 0.4) hands the step to Claude, with the reason", async () => {
    const jev: JevLike = { async decide() { return jevDecision("click", 0, { gate: 0.2, conf: { kind: 0.3, item: 0.2 } }); } };
    const claude = fakeClaude();
    const t = await runTask(newTask("When was HKU founded?", "typed"), deps({ jev, claude }));
    expect(claude.decided[0]).toContain("unsure");
    expect(t.status).toBe("failed");
    expect(t.exception?.code).toBe("needs_info");      // the fake Claude says stuck
  });

  test("no jev: Claude decides every step", async () => {
    const claude = fakeClaude();
    await runTask(newTask("When was HKU founded?", "typed"), deps({ jev: null, claude }));
    expect(claude.decided[0]).toContain("not configured");
  });

  test("no planner at all: the task fails with a clear reason", async () => {
    const t = await runTask(newTask("anything", "typed"), deps({ jev: smartJev(), claude: null }));
    expect(t.exception?.code).toBe("plan_failed");
    expect(t.exception?.reason).toContain("ANTHROPIC_API_KEY");
  });

  test("typing that never lands: stall is detected and Claude is asked for something different", async () => {
    const jev = smartJev(), claude = fakeClaude();
    const t = await runTask(newTask("When was HKU founded?", "typed"), deps({ jev, claude, driver: new SimDriver(SITE, { dropTyping: true }) }));
    expect(claude.decided.some(w => /did not change|different/.test(w))).toBe(true);
    expect(t.status).toBe("failed");
  });

  test("a premature done is caught by the check, counted, and the run continues", async () => {
    let first = true;
    const inner = smartJev();
    const jev: JevLike = { async decide(s: StepState) { if (first) { first = false; return jevDecision("done"); } return inner.decide(s); } };
    const t = await runTask(newTask("When was HKU founded?", "typed"), deps({ jev, claude: fakeClaude() }));
    expect(t.counts.falseDoneCaught).toBe(1);
    expect(t.status).toBe("done");
  });

  test("planner question: nothing runs, the question goes to the user", async () => {
    const claude = fakeClaude({ async plan() { return { plan: { by: "claude", question: "Which account?", subtasks: [] }, ms: 1 }; } });
    const d = new SimDriver();
    const t = await runTask(newTask("email my boss", "typed"), deps({ jev: smartJev(), claude, driver: d }));
    expect(t.exception).toEqual({ code: "needs_info", reason: "Which account?" });
    expect(d.log).toEqual([]);
  });

  test("an irreversible click waits for approval; denied stops the task before clicking", async () => {
    const notePlan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad" }, goal: "The list is saved.", values: [{ name: "list", text: "eggs, milk" }] }] };
    const jev: JevLike = { async decide(s: StepState) {
      const doc = s.items.find(i => i.role === "text area")!;
      return doc.value ? jevDecision("click", s.items.find(i => i.text === "Save")!.i) : jevDecision("type", doc.i, { valueName: "list", text: "eggs, milk" });
    } };
    const asked: string[] = [];
    const d = new SimDriver();
    const t = await runTask(newTask("write a list and save it", "voice"),
      deps({ jev, claude: fakeClaude({ async plan() { return { plan: notePlan, ms: 1 }; } }), driver: d, approve: async (r: any) => { asked.push(r.action); return false; } }));
    expect(asked[0]).toContain("Save");
    expect(t.exception?.code).toBe("declined");
    expect(d.doc).toBe("eggs, milk");
    expect(d.log.filter(a => a.tool === "click")).toEqual([]);
  });

  test("never types into a password field", async () => {
    const site: Record<string, SimPage> = { "https://login.test/": { title: "Sign in", text: ["Sign in"], controls: [{ role: "text field", label: "Password" }] } };
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "browser", url: "https://login.test/" }, goal: "signed in", values: [{ name: "pw", text: "hunter2" }] }] };
    const jev: JevLike = { async decide() { return jevDecision("type", 0, { valueName: "pw", text: "hunter2" }); } };
    const d = new SimDriver(site);
    const t = await runTask(newTask("log in", "typed"), deps({ jev, claude: fakeClaude({ async plan() { return { plan, ms: 1 }; } }), driver: d }));
    expect(t.exception?.code).toBe("unsafe");
    expect(d.log.filter(a => a.tool === "type")).toEqual([]);
  });

  test("a value jev is unsure about is written by Claude instead", async () => {
    const site: Record<string, SimPage> = { "https://form.test/": { title: "Form", text: ["Form"], controls: [{ role: "text field", label: "Comment" }] } };
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "browser", url: "https://form.test/" }, goal: "comment typed", values: [] }] };
    let n = 0;
    const jev: JevLike = { async decide() { return n++ === 0 ? jevDecision("type", 0) : jevDecision("done"); } };
    const d = new SimDriver(site);
    const claude = fakeClaude({ async plan() { return { plan, ms: 1 }; }, async verify() { return { complete: true, answer: "typed", evidence: "Comment", ms: 1 }; } });
    const log = new MemoryLogger();
    const t = await runTask(newTask("leave a comment", "typed"), deps({ jev, claude, driver: d, log }));
    expect(t.status).toBe("done");
    expect(d.values.Comment).toBe("written by claude");
    const step = log.lines.find((l): l is Extract<LogLine, { type: "step" }> => l.type === "step")!;
    expect(step.note).toBe("text written by Claude");
  });

  test("stop", async () => {
    const ac = new AbortController(); ac.abort();
    const t = await runTask(newTask("When was HKU founded?", "typed"), deps({ jev: smartJev(), claude: fakeClaude(), signal: ac.signal }));
    expect(t.status).toBe("stopped");
  });
});

test("in a desktop app, replacing text that was already there needs approval", async () => {
  const notePlan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad" }, goal: "list written", values: [{ name: "list", text: "eggs" }] }] };
  const d = new SimDriver();
  const origOpen = d.open.bind(d);
  d.open = async (h, s) => { const w = await origOpen(h, s); d.doc = "my unsaved essay"; return w; };
  const jev: JevLike = { async decide(s: StepState) { return jevDecision("type", s.items.find(i => i.role === "text area")!.i, { valueName: "list", text: "eggs" }); } };
  const asked: string[] = [];
  const t = await runTask(newTask("write eggs", "typed"),
    deps({ jev, claude: fakeClaude({ async plan() { return { plan: notePlan, ms: 1 }; } }), driver: d, approve: async (r: any) => { asked.push(r.action); return false; } }));
  expect(asked[0]).toContain("my unsaved essay");
  expect(t.exception?.code).toBe("declined");
  expect(d.doc).toBe("my unsaved essay");
});

// Screen questions (typed, spoken, or recognised while planning), finding files and folders by name, and code checks
// that let a loading page settle. No network, no Cua (the driver path points at nothing).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newTask, runTask, type ClaudeLike, type JevLike } from "../src/agent";
import { whatIsThis } from "../src/ask";
import { Claude } from "../src/claude";
import type { Decision, Driver, Kind, Plan } from "../src/contracts";
import { SimDriver } from "../src/driver/sim";
import { fromContext, type Capture } from "../src/explain";
import { findByName, nameTokens, planFiles } from "../src/files";
import type { Classification, TaskType } from "../src/jev";
import { MemoryLogger } from "../src/logger";
import { findOp, looksLikeFind, planWithJev } from "../src/planner";
import { isScreenQuestion } from "../src/pointer";
import { App } from "../src/server";

process.env.SPEAK = "off";
process.env.OVERLAY = "off";
// Absolute on Windows and elsewhere (the planner only works inside an absolute user folder).
const HOME = join(tmpdir(), "tester-home");
const cls = (type: TaskType, extra: Partial<Classification> = {}): Classification => ({ type, typeConf: 0.9, appConf: 0, fileOpConf: 0, inputTokens: 300, ms: 1, ...extra });
const jevSays = (type: TaskType, extra: Partial<Classification> = {}) => ({ classify: async () => cls(type, extra) }) as any;

describe("which instructions are about the screen", () => {
  test("the questions from the live runs", () => {
    for (const q of ["What am I looking at?", "describe what I'm looking at.", "describe what I am looking at", "Can you draw a circle around the cheetah and the hippopotamus?",
      "Can you circle the zebra?", "Can you draw a circle around the buffalo?", "Can you draw a circle around this D-bra here?", "How many lions are in this picture?",
      "highlight the cheetah and the hippo", "point at the save button", "summarise this page"]) expect([q, isScreenQuestion(q)]).toEqual([q, true]);
    for (const q of ["find the top fastest animals in sea and then play a video about safari on youtube", "Where is my year one folder?", "Open Spotify and play the weekend for me.",
      "Create a Word document and write a Japan itinerary for me.", "highlight the title in Word", "mark the email as read", "when is the next circle line train",
      "draw a cat in Paint", "show me where Tokyo is on a map", "what is the capital of France"]) expect([q, isScreenQuestion(q)]).toEqual([q, false]);
  });

  test("jev only, typed or nothing under a control: names the window instead of guessing", () => {
    const p = { x: 0, y: 0, t: "", nearby: [], all: [], typed: true, window: { pid: 1, windowId: 2, title: "Animals of the Okavango - Google Chrome", app: "chrome.exe", bounds: { x: 0, y: 0, width: 800, height: 600 } } };
    expect(whatIsThis("what am I looking at?", p)).toBe(`You're looking at "Animals of the Okavango - Google Chrome". Describing what is in it needs a Claude API key.`);
  });
});

describe("screen questions reach point-and-ask, wherever they come from", () => {
  const before = process.env.CUA_DRIVER;
  beforeAll(() => { process.env.CUA_DRIVER = join(tmpdir(), "no-such-cua-driver.exe"); });   // Cua calls fail fast and alike everywhere
  afterAll(() => { if (before === undefined) delete process.env.CUA_DRIVER; else process.env.CUA_DRIVER = before; });
  // A desktop that is not the simulator, so screen questions are routed (Cua itself is unreachable here).
  const desktop = (): Driver => Object.assign(new SimDriver(), { caps: { platform: "win32" as const, name: "test desktop" } });
  const settle = async (app: App) => { for (let i = 0; i < 100 && app.tasks.some(t => t.status === "running" || t.status === "planning" || t.status === "queued"); i++) await Bun.sleep(20); };

  // What explain mode sees, without Cua or the overlay: the window behind the panel, or the screen under the pointer.
  const window = { pid: 1, windowId: 2, title: "Animals of the Okavango - Google Chrome", app: "chrome.exe", bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const behindPanel = async (): Promise<Capture> => ({ ...fromContext({ x: 400, y: 300, t: "", nearby: [], all: [], typed: true, window }), ms: 1 });
  const screen = async (): Promise<Capture> => ({ imgW: 960, imgH: 540, screen: { x: 0, y: 0, w: 1920, h: 1080 }, app: "chrome", windowTitle: window.title, controls: [], cursor: { x: 900, y: 500 }, ms: 1 });

  test("typed in the panel: answered from the window behind the panel, never planned as a task", async () => {
    let planned = 0;
    const claude = { usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, plan: async () => { planned++; return { plan: { by: "claude", question: "", subtasks: [] } as Plan, ms: 1 }; } } as any;
    const app = new App(desktop(), claude, null, "Mint-3", { send: () => false, behindPanel });
    const t = app.add("What am I looking at?", "typed");
    expect(t.status).toBe("running");
    await settle(app);
    expect(planned).toBe(0);
    expect(app.tasks).toHaveLength(1);
    expect(app.tasks[0].status).toBe("done");
    expect(app.tasks[0].result?.answer).toBe(`You're looking at "Animals of the Okavango - Google Chrome". Describing what is in it needs a Claude API key.`);
    expect(app.tasks[0].result?.evidence).toContain("typed: the window behind the panel");
  });

  test("spoken: explain mode answers from the screen under the pointer", async () => {
    const app = new App(desktop(), null, null, "Mint-3", { send: () => false, capture: screen });
    await app.onSpoken("Can you circle the zebra?");
    await settle(app);
    expect(app.tasks.map(t => [t.instruction, t.source, t.status, !!t.plan])).toEqual([["Can you circle the zebra?", "voice", "done", false]]);
    expect(app.tasks[0].result?.evidence).toStartWith(`pointer at 900,500 in "Animals of the Okavango - Google Chrome"; answered by code`);
  });

  test("the screen can't be seen: the question fails and says why", async () => {
    const app = new App(desktop(), null, null, "Mint-3", { send: () => false, capture: async () => ({ imgW: 0, imgH: 0, screen: { x: 0, y: 0, w: 0, h: 0 }, controls: [], ms: 0, error: "Cua is not running" }) });
    await app.onSpoken("what is this?");
    await settle(app);
    expect(app.tasks[0].status).toBe("failed");
    expect(app.tasks[0].exception?.reason).toContain("Cua is not running");
  });

  test("the simulator keeps the old behaviour (no screen to look at)", async () => {
    const app = new App(new SimDriver(), null, null);
    app.add("What am I looking at?", "typed");
    await settle(app);
    expect(app.tasks[0].exception?.code).toBe("plan_failed");        // no deciders: planned, not asked
  });

  test("a plan that turns out to be about the screen is answered by askScreen", async () => {
    const claude: ClaudeLike = { usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, plan: async () => ({ plan: { by: "claude", question: "", subtasks: [], aboutScreen: true }, ms: 1 }),
      decide: async () => { throw new Error("no steps"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => ({ complete: false, answer: "", evidence: "", ms: 0 }) };
    const asked: string[] = [];
    const deps = { driver: new SimDriver(), claude, jev: null, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true };
    const t = await runTask(newTask("Could you put a ring round the buffalo", "typed"), { ...deps, askScreen: async q => { asked.push(q); return { answer: "The buffalo is bottom left; I've circled it.", evidence: "typed: the window behind the panel", jevUsd: 0.0001, by: "claude" }; } });
    expect(asked).toEqual(["Could you put a ring round the buffalo"]);
    expect(t.status).toBe("done");
    expect(t.result?.answer).toContain("circled");
    expect(t.cost.jevUsd).toBeCloseTo(0.0001);
    expect(t.counts.claude).toBe(2);                                   // one call planned it, one answered it from the screen
    const without = await runTask(newTask("Could you put a ring round the buffalo", "typed"), deps);
    expect(without.exception?.code).toBe("needs_info");
    expect(without.exception?.reason).toContain("Point & ask");
  });

  test("jev only: a confident screen question becomes a screen plan; an unsure one does not", async () => {
    expect((await planWithJev("what does this icon mean", jevSays("screen_question"), [], { home: HOME })).plan.aboutScreen).toBe(true);
    const unsure = await planWithJev("tell me about the thing", jevSays("screen_question", { typeConf: 0.4 }), [], { home: HOME });
    expect(unsure.plan.aboutScreen).toBeUndefined();
    expect(unsure.plan.question).toContain("point at it");
  });

  test("Claude's plan can say the instruction is about the screen", async () => {
    let body: any;
    const fetch = (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_details: null,
        content: [{ type: "text", text: JSON.stringify({ question: "", about_screen: true, subtasks: [] }) }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any;
    const r = await new Claude({ apiKey: "k", fetch }).plan("Could you put a ring round the buffalo", { today: "2026-10-03", platform: "Windows", apps: [] });
    expect(r.plan).toEqual({ by: "claude", question: "", subtasks: [], aboutScreen: true });
    expect(body.output_config.format.schema.required).toContain("about_screen");
  });
});

describe("finding a file or folder by name", () => {
  test("which instructions are a search by name, and what is searched", () => {
    for (const q of ["Where is my year one folder?", "where's my Year 1 folder", "find my essay in Documents", "open my tax return pdf", "where did I save the budget spreadsheet"]) expect([q, looksLikeFind(q)]).toEqual([q, true]);
    for (const q of ["where is Tokyo", "where is my order", "find flights to Tokyo", "where is the save button", "where is the file menu", "open Notepad"]) expect([q, looksLikeFind(q)]).toEqual([q, false]);
    expect(findOp("Where is my year one folder?", HOME)).toEqual({ op: "find", folder: HOME, name: "my year one folder", want: "folder", open: false });
    expect(findOp("open my tax return pdf", HOME)).toMatchObject({ name: "my tax return pdf", want: "file", open: true });
    expect(findOp("find my essay in Documents", HOME)).toMatchObject({ folder: join(HOME, "Documents"), name: "my essay" });
    expect(() => findOp("where is my folder", HOME)).toThrow("Which file or folder");
  });

  test("jev + rules: searched on disk whatever jev called it, even when Claude would plan open-ended tasks", async () => {
    const r = await planWithJev("Where is my year one folder?", jevSays("open_app", { app: "File Explorer", appConf: 0.8 }), ["File Explorer"], { home: HOME, defer: ["web_question", "web_task", "open_app", "chat", "unclear"] });
    expect(r.deferred).toBe(false);
    expect(r.plan.subtasks.map(s => s.surface)).toEqual([{ kind: "files", op: { op: "find", folder: HOME, name: "my year one folder", want: "folder", open: false } }]);
  });

  test("names match whatever the spelling of numbers, case and separators; the user folder itself may be searched", () => {
    expect(nameTokens("Year One")).toEqual(nameTokens("year_1"));
    expect(nameTokens("Year1st")).toEqual(["year", "1"]);
    const home = mkdtempSync(join(tmpdir(), "agent-find-"));
    mkdirSync(join(home, "OneDrive", "Uni", "year 1"), { recursive: true });
    mkdirSync(join(home, "Documents", "Year 2"), { recursive: true });
    writeFileSync(join(home, "Documents", "year 1 notes.txt"), "x");
    const hits = findByName(home, "my year one folder", "folder");
    expect(hits.map(h => h.path)).toEqual([join(home, "OneDrive", "Uni", "year 1")]);
    const plan = planFiles({ op: "find", folder: home, name: "my year one folder", want: "folder", open: false }, home);
    expect(plan.answer).toBe(`Your folder "year 1" is in ${join(home, "OneDrive", "Uni")}.`);
    expect(plan.needsApproval).toBe(false);
    // Changes still stay below the user folder: organising the user folder itself is refused.
    expect(() => planFiles({ op: "organize", folder: home }, home)).toThrow("only work inside");
  });
});

test("a code check that fails while the window is still loading gets a third look before the part fails", async () => {
  const jevDecision = (kind: Kind, item?: number, extra: Partial<Decision> = {}): Decision =>
    ({ kind, item, conf: { kind: 0.9, item: 0.9, value: 0.9 }, gate: 0.9, backend: "jev", model: "fake", inputTokens: 1, outputTokens: 0, ms: 1, ...extra });
  let n = 0;
  // Says "done" twice before typing, as jev did on YouTube between the results page and the player.
  const jev: JevLike = { async decide(s) { return ++n <= 2 ? jevDecision("done") : jevDecision("type", s.items.find(i => i.role === "text area")!.i, { valueName: "text", text: "eggs" }); } };
  const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad" }, goal: "The text is written.", values: [{ name: "text", text: "eggs" }], check: { kind: "field_equals", role: "text area", expected: "eggs" } }] };
  const claude: ClaudeLike = { usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, plan: async () => ({ plan, ms: 1 }),
    decide: async () => { throw new Error("jev is sure every step"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }),
    verify: async () => { throw new Error("the code check decides"); } };
  const t = await runTask(newTask("write eggs in Notepad", "typed"), { driver: new SimDriver(), claude, jev, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
  expect(t.status).toBe("done");
  expect(t.counts.falseDoneCaught).toBe(2);
}, 10_000);

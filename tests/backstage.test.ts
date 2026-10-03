// The parts ported from the Mac version (Backstage): the router (agents or explain), explain mode (lessons, drawing
// placement, voice), ElevenLabs with its fallbacks, and how results are shown and said. No network, no Cua, no overlay.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExplainAnswer, ExplainShape } from "../src/claude";
import type { AgentState } from "../src/contracts";
import { SimDriver } from "../src/driver/sim";
import { Explainer, lessonWord, place, type Capture } from "../src/explain";
import { FastLane } from "../src/fastlane";
import { findShortcut } from "../src/driver/win";
import type { ScreenControl } from "../src/pointer";
import { sayable, spokenSummary, tidyAnswer } from "../src/results";
import { route } from "../src/router";
import { App } from "../src/server";
import { Voice } from "../src/voice";

process.env.SPEAK = "off";
process.env.OVERLAY = "off";

// ---------------------------------------------------------------------------------------------------------------
describe("router: one hotkey, a job for the agents or a question about the screen", () => {
  const ctx = { lesson: false, agentsBusy: false, jev: null };
  const to = async (text: string, c: Partial<Parameters<typeof route>[1]> = {}) => (await route(text, { ...ctx, ...c })).to;

  test("clear cases are decided in code", async () => {
    for (const q of ["Open Calculator and compute 128 times 37", "play the weeknd on Spotify", "where is my Year 1 folder?", "how do I get to the airport from Central",
      "what's the weather in Tokyo", "what is 45 times 12", "search YouTube for lofi beats", "write a shopping list in Notepad", "find flights from Hong Kong to Tokyo"]) {
      expect([q, await to(q)]).toEqual([q, "agents"]);
    }
    for (const q of ["How do I make a pivot table?", "what does this button do", "circle the zebra", "what am I looking at", "where is the save button",
      "explain this chart", "teach me how to add a border", "never mind"]) {
      expect([q, await to(q)]).toEqual([q, "explain"]);
    }
  });

  test("orders go to the agents, whatever words they contain (the requests from the first Windows run)", async () => {
    for (const q of ["Mute my mic on Discord.", "Can you open discord and mute myself?", "Can you open VS Code?",
      "Can you open Spotify and play Drake and then unmute myself on Discord and also send a message to my like most recent open chat on Discord saying hi, this is the background agent typing and then go to WhatsApp and message Mohit hi.",
      "message Mohit hi on WhatsApp", "unmute me", "Discord, mute me please", "join the general voice channel"]) {
      expect([q, await to(q)]).toEqual([q, "agents"]);
    }
    // unclear and not a question: done, not explained
    expect(await to("my mic off please")).toBe("agents");
    expect(await to("is my mic on?")).toBe("explain");
  });

  test("'stop' stops only when agents are working; lesson words stay with the lesson", async () => {
    expect(await to("stop", { agentsBusy: true })).toBe("stop");
    expect(await to("Stop everything.", { agentsBusy: true })).toBe("stop");
    expect(await to("stop")).toBe("explain");                    // nothing running: clears the drawings
    for (const q of ["next", "go on", "repeat", "back", "ok"]) expect(await to(q, { lesson: true })).toBe("explain");
    // "quit" / "quite" alone, or "okay next", are lesson words even when the lesson state was lost: never a job that
    // closes an app; "quit Spotify" still is one
    for (const q of ["quit", "Quite.", "quiet", "exit", "okay, next please", "go back"]) expect([q, await to(q)]).toEqual([q, "explain"]);
    expect(await to("quit Spotify")).toBe("agents");
    expect(await to("Quite.", { agentsBusy: true })).toBe("explain");
  });

  test("unclear: jev decides; without a sure answer a question is explained and anything else is done", async () => {
    const jev = (choice: string, confidence: number) => ({ choose: async () => ({ choice, confidence, inputTokens: 50 }) });
    const r = await route("the quarterly numbers", { ...ctx, jev: jev("explain", 0.8) });
    expect([r.to, r.via, r.confidence]).toEqual(["explain", "jev", 0.8]);
    expect(await to("the quarterly numbers", { jev: jev("agents", 0.7) })).toBe("agents");
    expect(await to("the quarterly numbers", { jev: jev("explain", 0.3) })).toBe("agents");    // unsure: do it
    expect(await to("the quarterly numbers?", { jev: jev("agents", 0.3) })).toBe("explain");  // unsure question: explain
    expect(await to("the quarterly numbers", { jev: { choose: async () => { throw new Error("offline"); } } })).toBe("agents");
    expect(await to("the quarterly numbers")).toBe("agents");   // no jev
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("results: tidy for the widgets, sayable for the voice", () => {
  const agent = (over: Partial<AgentState>): AgentState => ({ id: "t/0", taskId: "t", sub: 0, name: "Mint", colour: "#33d499", app: "browser", goal: "find it", status: "done", now: "done", steps: 3, seconds: 4, ...over });

  test("answers", () => {
    expect(tidyAnswer("https://www.bbc.com › weather › 1819729... Hong Kong: 27°C , sunny")).toBe("Hong Kong: 27°C, sunny");
    expect(tidyAnswer("45 × 12 540")).toBe("45 × 12 = 540");
    expect(sayable("45 × 12 = 540")).toBe("45 times 12 is 540");
    expect(sayable("Saved C:\\Users\\sohan\\Documents\\Japan trip.docx for you.")).toBe("Saved Japan trip.docx for you.");
    expect(sayable("One. Two. Three.")).toBe("One. Two.");
  });

  test("what is said when a task ends", () => {
    expect(spokenSummary([agent({ app: "Calculator", answer: "45 × 12 540" })], "finished")).toBe("45 times 12 is 540.");
    expect(spokenSummary([agent({ app: "browser", answer: "It is sunny" }), agent({ name: "Red", app: "Spotify", status: "failed", reason: "Spotify needs you to sign in" })], "finished"))
      .toBe("In browser: It is sunny. Red couldn't finish in Spotify: Spotify needs you to sign in.");
    expect(spokenSummary([agent({ app: "Notepad", goal: "write a shopping list: eggs, milk", answer: "eggs, milk" })], "finished")).toBe("Done in Notepad.");
    expect(spokenSummary([], "stopped")).toBe("Stopped. The agents left everything as it is now.");
    expect(spokenSummary([], "finished", "Which city do you mean?")).toBe("Which city do you mean?");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A 1920x1080 screen whose picture is 960x540 (k = 0.5): picture (x, y) = screen (2x, 2y).
const SCREEN = { x: 0, y: 0, w: 1920, h: 1080 };
const c = (id: number, role: string, label: string, x: number, y: number, w = 120, h = 40): ScreenControl => ({ id, role, label, frame: { x, y, w, h } });
const CONTROLS = [c(0, "Button", "Save", 100, 60), c(1, "Button", "Insert", 300, 60), c(2, "Text", "First line of the essay", 400, 400, 600, 30), c(3, "Text", "Second line", 400, 440, 300, 30)];
const shape = (over: Partial<ExplainShape>): ExplainShape => ({ kind: "ring", control: -1, x: -1, y: -1, w: -1, h: -1, from_x: -1, from_y: -1, text: "", ...over });
const cap = (over: Partial<Capture> = {}): Capture => ({ png: "nothing.png", imgW: 960, imgH: 540, screen: SCREEN, app: "Word", windowTitle: "Essay - Word", controls: CONTROLS, cursor: { x: 700, y: 500 }, ms: 3, ...over });

describe("explain mode: where the drawings go", () => {
  test("a control id uses its exact frame; a point in the picture snaps to the control under it", () => {
    expect(place(shape({ control: 1 }), cap())).toEqual([{ kind: "ring", x: 300, y: 60, w: 120, h: 40, text: undefined }]);
    expect(place(shape({ x: 60, y: 40, text: "Save" }), cap())).toEqual([{ kind: "ring", x: 100, y: 60, w: 120, h: 40, text: "Save" }]);
    // nothing under it: a small ring around the point
    expect(place(shape({ x: 800, y: 50 }), cap())).toEqual([{ kind: "ring", x: 1570, y: 70, w: 60, h: 60, text: undefined }]);
  });

  test("regions, arrows and labels are scaled from the picture; a second monitor is offset", () => {
    expect(place(shape({ kind: "box", x: 100, y: 100, w: 200, h: 100 }), cap())).toEqual([{ kind: "box", x: 200, y: 200, w: 400, h: 200, text: undefined }]);
    expect(place(shape({ kind: "arrow", control: 0, from_x: 400, from_y: 300 }), cap())).toEqual([{ kind: "arrow", from: { x: 800, y: 600 }, to: { x: 160, y: 80 }, text: undefined }]);
    expect(place(shape({ kind: "label", x: 480, y: 270, text: "the ribbon" }), cap())[0]).toMatchObject({ kind: "label", x: 960, y: 540, text: "the ribbon" });
    const right = cap({ screen: { x: 1920, y: 0, w: 1920, h: 1080 }, controls: [] });
    expect(place(shape({ kind: "box", x: 10, y: 10, w: 20, h: 20 }), right)).toEqual([{ kind: "box", x: 1940, y: 20, w: 40, h: 40, text: undefined }]);
  });

  test("an underline over several lines becomes one line under each text run", () => {
    const u = place(shape({ kind: "underline", x: 195, y: 195, w: 330, h: 45, text: "these two" }), cap());
    expect(u).toEqual([
      { kind: "underline", x: 400, y: 400, w: 600, h: 30, text: undefined },
      { kind: "underline", x: 400, y: 440, w: 300, h: 30, text: "these two" },
    ]);
  });

  test("unknown kinds and missing coordinates draw nothing", () => {
    expect(place(shape({ kind: "sparkle" as any, control: 0 }), cap())).toEqual([]);
    expect(place(shape({}), cap())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const fakeClaude = (answer: ExplainAnswer, seen: any[] = []) => {
  const claude = {
    usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    explain: async (question: string, png: string, context: string, conversation: any[]) => { seen.push({ question, png, context, conversation }); claude.usage.usd += 0.003; return { answer, ms: 5, model: "test" }; },
  };
  return claude;
};
const overlay = () => { const sent: any[] = []; return { sent, send: (m: any) => { sent.push(m); return true; } }; };
const quietVoice = () => new Voice({ key: "" });

describe("explain mode: answers and lessons", () => {
  test("a plain question: the screen and its controls go to Claude in picture pixels; one answer, drawn and said", async () => {
    const seen: any[] = [];
    const o = overlay();
    const ex = new Explainer({ claude: fakeClaude({ steps: [{ say: "That's the Insert tab. I've ringed it.", shapes: [shape({ control: 1 })] }] }, seen), jev: null, send: o.send, speak: () => {}, voice: quietVoice(), capture: async () => cap(), journal: "/dev/null" });
    const r = await ex.ask("what is the insert tab for?");
    expect(seen[0].context).toContain("The picture is the user's screen, 960x540 pixels. The mouse pointer is at x=350 y=250");
    expect(seen[0].context).toContain('[1] Button "Insert" at x=150 y=30 w=60 h=20');
    expect(seen[0].context).toContain("The app in front is Word (\"Essay - Word\")");
    expect(r).toMatchObject({ by: "claude", steps: 1, shapes: 1, answer: "That's the Insert tab. I've ringed it." });
    expect(r.usd).toBeCloseTo(0.003);
    expect(o.sent.map(m => m.cmd)).toEqual(["status", "status", "answer"]);
    expect(o.sent[2]).toMatchObject({ say: "That's the Insert tab. I've ringed it.", shapes: [{ kind: "ring", x: 300, y: 60, w: 120, h: 40 }], fadeMs: 9000, audio: "system" });
    expect(o.sent[2].step).toBeUndefined();
  });

  test("'how do I…': a lesson, one step at a time (next, back, repeat), then it ends", async () => {
    const o = overlay();
    const steps = [{ say: "Click Insert.", shapes: [shape({ control: 1 })] }, { say: "Click Table.", shapes: [] }, { say: "Pick the size.", shapes: [] }];
    const ex = new Explainer({ claude: fakeClaude({ steps }), jev: null, send: o.send, speak: () => {}, voice: quietVoice(), capture: async () => cap(), journal: "/dev/null" });
    await ex.ask("how do I add a table?");
    const answers = () => o.sent.filter(m => m.cmd === "answer");
    expect(answers()[0]).toMatchObject({ say: 'Click Insert. Say "next" when you\'re ready.', step: { index: 0, total: 3 }, fadeMs: 60_000 });
    expect(ex.inLesson).toBe(true);
    expect(ex.inCode("Next.")).toBe(true);
    expect((await ex.ask("next")).answer).toBe("Click Table.");
    ex.go("back");
    expect(answers().at(-1)).toMatchObject({ step: { index: 0, total: 3 } });
    ex.go("repeat");
    expect(answers().at(-1)).toMatchObject({ step: { index: 0, total: 3 } });
    ex.go("next"); ex.go("next");
    expect(answers().at(-1)).toMatchObject({ say: "Pick the size.", step: { index: 2, total: 3 }, fadeMs: 9000 });
    expect((await ex.ask("okay")).answer).toBe("That's everything. Ask me anything else.");
    expect(ex.inLesson).toBe(false);
    ex.dismiss();
    expect(o.sent.at(-1)).toEqual({ cmd: "clear" });
  });

  test("lesson words with fillers and mishearings: 'okay next', 'next please', 'quite' / 'quiet' clear the drawings", async () => {
    expect(["next", "Next.", "okay, next", "next please", "um next", "go to the next step", "what's the next step?", "nest", "done", "okay"].map(lessonWord)).toEqual(Array(10).fill("next"));
    expect(["back", "go back", "previous step", "the last step"].map(lessonWord)).toEqual(Array(4).fill("back"));
    expect(["repeat", "say that again", "pardon?"].map(lessonWord)).toEqual(Array(3).fill("again"));
    expect(["quit", "Quite.", "quiet", "exit", "okay thanks", "stop", "that's enough", "I'm done", "close it", "never mind"].map(lessonWord)).toEqual(Array(10).fill("dismiss"));
    expect(["how do I add a table", "next to the bold button what is that", "open Notepad", "quit Spotify"].map(lessonWord)).toEqual(Array(4).fill(undefined));

    const o = overlay();
    const steps = [{ say: "Click Insert.", shapes: [shape({ control: 1 })] }, { say: "Click Table.", shapes: [] }];
    const ex = new Explainer({ claude: fakeClaude({ steps }), jev: null, send: o.send, speak: () => {}, voice: quietVoice(), capture: async () => cap(), journal: "/dev/null" });
    await ex.ask("how do I add a table?");
    expect((await ex.ask("Okay, next please.")).answer).toBe("Click Table.");
    expect((await ex.ask("Quite.")).answer).toBe("Cleared.");
    expect(o.sent.at(-1)).toEqual({ cmd: "clear" });
    expect(ex.inLesson).toBe(false);
    // with no lesson going on, "next" asks nothing new: it says so and clears the screen
    const r = await ex.ask("next");
    expect(r.answer).toBe("There's no lesson going on. Ask me how to do something.");
    expect(o.sent.filter(m => m.cmd === "answer").at(-1)).toMatchObject({ say: r.answer, shapes: [] });
  });

  test("the voice: ElevenLabs audio follows the drawing as MP3 files, in order; a failed part uses the Windows voice", async () => {
    const o = overlay();
    let n = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/user/subscription")) return Response.json({ character_limit: 10_000, character_count: 100, tier: "free" });
      const text = JSON.parse(String(init!.body)).text as string;
      if (text.startsWith("Then")) return new Response("busy", { status: 429 });
      n++;
      return new Response(new Uint8Array([0x49, 0x44, 0x33, n]), { headers: { "character-cost": String(Math.ceil(text.length / 2)) } });
    };
    const voice = new Voice({ key: "test-key", fetch });
    const say = "First you open the Insert tab at the top of the window. Then you choose Table and drag across the grid.";
    const ex = new Explainer({ claude: fakeClaude({ steps: [{ say, shapes: [] }] }), jev: null, send: o.send, speak: () => {}, voice, capture: async () => cap(), journal: "/dev/null" });
    await ex.ask("how do tables work here");
    for (let i = 0; i < 50 && o.sent.filter(m => m.cmd === "audio" || m.cmd === "speak").length < 2; i++) await Bun.sleep(10);
    const answer = o.sent.find(m => m.cmd === "answer");
    expect(answer.audio).toBe("follows");
    const parts = o.sent.filter(m => m.cmd === "audio" || m.cmd === "speak");
    expect(parts.map(p => [p.cmd, p.seq, p.part])).toEqual([["audio", answer.seq, 0], ["speak", answer.seq, 1]]);
    expect(existsSync(parts[0].path)).toBe(true);
    expect([...readFileSync(parts[0].path)]).toEqual([0x49, 0x44, 0x33, 1]);
    expect(parts[1].say).toBe("Then you choose Table and drag across the grid.");
    rmSync(parts[0].path);
    expect(voice.credits).toBe(9900 - 28);       // the quota, counted down by the first part's cost
  });

  test("ElevenLabs: a key that can't read the quota still speaks; a rejected key switches to the Windows voice", async () => {
    const limited = new Voice({ key: "tts-only", fetch: async (url: string) => url.endsWith("/subscription")
      ? new Response(JSON.stringify({ detail: { status: "missing_permissions", message: "The API key you used is missing the permission user_read" } }), { status: 401 })
      : new Response(new Uint8Array([1, 2, 3])) });
    expect((await limited.speak("Hello there.")).audio).toEqual(new Uint8Array([1, 2, 3]));
    expect(limited.on).toBe(true);
    const bad = new Voice({ key: "wrong", fetch: async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key" } }), { status: 401 }) });
    expect((await bad.speak("Hello there.")).audio).toBeUndefined();
    expect([bad.on, bad.name]).toEqual([false, "Windows voice"]);
    expect(Voice.parts("Click the File menu at the top left of the window. Then choose Save As. Pick a folder.")).toEqual(["Click the File menu at the top left of the window.", "Then choose Save As. Pick a folder."]);
    expect(Voice.parts("Short one. And then the rest of it.")).toEqual(["Short one. And then the rest of it."]);
  });

  test("no overlay: the answer is spoken with the system voice", async () => {
    const said: string[] = [];
    const ex = new Explainer({ claude: fakeClaude({ steps: [{ say: "It saves the file.", shapes: [] }] }), jev: null, send: () => false, speak: t => said.push(t), voice: quietVoice(), capture: async () => cap(), journal: "/dev/null" });
    await ex.ask("what does this do");
    expect(said).toEqual(["It saves the file."]);
  });

  test("Claude failing or no picture: says so, nothing is drawn", async () => {
    const o = overlay();
    const claude = { usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, explain: async () => { throw new Error("overloaded"); } };
    const ex = new Explainer({ claude, jev: null, send: o.send, speak: () => {}, voice: quietVoice(), capture: async () => cap(), journal: "/dev/null" });
    const r = await ex.ask("what is this");
    expect(r.error).toBe("overloaded");
    expect(o.sent.at(-1)).toEqual({ cmd: "error", text: "Sorry, I couldn't answer that: overloaded" });
    const blind = new Explainer({ claude: fakeClaude({ steps: [] }), jev: null, send: o.send, speak: () => {}, voice: quietVoice(), journal: "/dev/null",
      capture: async () => ({ imgW: 0, imgH: 0, screen: { x: 0, y: 0, w: 0, h: 0 }, controls: [], ms: 0, error: "no overlay" }) });
    expect((await blind.ask("what is this")).answer).toBe("I couldn't see your screen (no overlay).");
  });

  test("the picture taken when the keys went down is the one used, and is thrown away for a job", async () => {
    let captures = 0;
    const ex = new Explainer({ claude: fakeClaude({ steps: [{ say: "ok", shapes: [] }] }), jev: null, send: () => true, speak: () => {}, voice: quietVoice(), journal: "/dev/null",
      capture: async () => { captures++; return cap(); } });
    ex.begin();
    await ex.ask("what is this");
    expect(captures).toBe(1);
    ex.begin();
    ex.discard();
    await ex.ask("and this?");
    expect(captures).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the server: the hotkey's words, the agents' widgets", () => {
  const settle = async (app: App) => { for (let i = 0; i < 200 && (app.busy || app.tasks.some(t => t.status === "running")); i++) await Bun.sleep(10); };
  const desktop = () => Object.assign(new SimDriver(), { caps: { platform: "win32" as const, name: "test desktop" } });

  test("a job: 'On it.', the agents' widgets in the dock, then the result is said", async () => {
    const o = overlay();
    const claude = {
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      plan: async () => ({ plan: { by: "claude" as const, question: "", subtasks: [{ surface: { kind: "answer" as const, reply: "Paris is the capital of France." }, goal: "answer", values: [] }] }, ms: 1 }),
      decide: async () => { throw new Error("no steps"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => ({ complete: true, answer: "", evidence: "", ms: 0 }),
    };
    const app = new App(new SimDriver(), claude as any, null, "Mint-3", { send: o.send, voice: quietVoice() });
    await app.hotkey("open the atlas and tell me the capital of France", "voice");
    await settle(app);
    await Bun.sleep(300);
    const said = o.sent.filter(m => m.cmd === "answer").map(m => m.say);
    expect(said[0]).toBe("On it.");
    expect(said.at(-1)).toBe("Paris is the capital of France.");
    const dock = o.sent.filter(m => m.cmd === "agents").at(-1);
    expect(dock.running).toBe(false);
    expect(dock.tasks).toEqual([expect.objectContaining({ name: "Pink", colour: "#ff5fa2", status: "done", answer: "Paris is the capital of France." })]);
    expect(app.snapshot().agents).toHaveLength(1);
  });

  test("'stop' while agents work stops them; 'never mind' with nothing running clears the screen and records nothing", async () => {
    const o = overlay();
    const app = new App(desktop(), null, null, "Mint-3", { send: o.send, voice: quietVoice(), capture: async () => cap() });
    await app.hotkey("never mind", "voice");
    expect(o.sent).toContainEqual({ cmd: "clear" });
    expect(app.tasks).toHaveLength(0);
    const abort = new AbortController();
    app.running.set("t1", { task: {} as any, abort });
    await app.hotkey("stop", "voice");
    expect(abort.signal.aborted).toBe(true);
    expect(o.sent.filter(m => m.cmd === "answer").at(-1).say).toBe("Stopping the agents.");
  });

  test("'thank you' / 'okay' (also what silence becomes) count only in a lesson; 'stop' while agents work also clears a lesson", async () => {
    const o = overlay();
    const steps = [{ say: "Click Insert.", shapes: [shape({ control: 1 })] }, { say: "Click Table.", shapes: [] }];
    const app = new App(desktop(), fakeClaude({ steps }) as any, null, "Mint-3", { send: o.send, voice: quietVoice(), capture: async () => cap() });
    app.onVoice({ event: "transcript", lang: "en", text: "Thank you.", ms: 5, maybe_noise: true });
    await Bun.sleep(20);
    expect(o.sent.at(-1)).toEqual({ cmd: "error", text: "didn't catch that: hold the keys and speak a little louder" });
    expect(app.tasks).toHaveLength(0);
    await app.hotkey("how do I add a table?", "voice");
    for (let i = 0; i < 100 && !app.explainer.inLesson; i++) await Bun.sleep(10);
    app.onVoice({ event: "transcript", lang: "en", text: "Okay.", ms: 5, maybe_noise: true });
    for (let i = 0; i < 100 && o.sent.filter(m => m.cmd === "answer").at(-1)?.say !== "Click Table."; i++) await Bun.sleep(10);
    expect(o.sent.filter(m => m.cmd === "answer").at(-1).say).toBe("Click Table.");
    const abort = new AbortController();
    app.running.set("t1", { task: {} as any, abort });
    await app.hotkey("stop", "voice");
    expect(abort.signal.aborted).toBe(true);
    expect(app.explainer.inLesson).toBe(false);
    expect(o.sent).toContainEqual({ cmd: "clear" });
  });

  test("explain mode hands a job it was given to the agents instead of saying it can only point", async () => {
    const o = overlay();
    const claude = {
      ...fakeClaude({ task: true, steps: [] }),
      plan: async () => ({ plan: { by: "claude" as const, question: "", subtasks: [{ surface: { kind: "answer" as const, reply: "Done that." }, goal: "answer", values: [] }] }, ms: 1 }),
      decide: async () => { throw new Error("no steps"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => ({ complete: true, answer: "", evidence: "", ms: 0 }),
    };
    const app = new App(desktop(), claude as any, null, "Mint-3", { send: o.send, voice: quietVoice(), capture: async () => cap() });
    await app.hotkey("what about my mic on discord", "voice");      // unclear wording that reads like a question
    await settle(app);
    expect(app.tasks.map(t => [t.instruction, t.status])).toEqual([["what about my mic on discord", "done"]]);
    expect(o.sent.filter(m => m.cmd === "answer").map(m => m.say)).toEqual(["On it.", "Done that."]);
  });

  test("the talk keys: listening, a tap opens the typing box, a cancel throws the picture away", async () => {
    const o = overlay();
    let captures = 0;
    const app = new App(desktop(), null, null, "Mint-3", { send: o.send, voice: quietVoice(), capture: async () => { captures++; return cap(); } });
    app.onVoice({ event: "down", t: 0 });
    await Bun.sleep(500);
    expect(o.sent.map(m => m.cmd)).toEqual(["listening"]);
    app.onVoice({ event: "cancel", reason: "tap" });
    expect(o.sent.at(-1)).toEqual({ cmd: "typebox" });
    expect(captures).toBe(1);
    app.onOverlay({ event: "ask", text: "what is this", cursor: { x: 700, y: 500 } });
    for (let i = 0; i < 100 && app.tasks[0]?.status !== "done"; i++) await Bun.sleep(10);
    expect(captures).toBe(1);                    // the question typed in the box uses the picture from key down
    expect(app.tasks[0].result?.evidence).toStartWith(`pointer at 700,500 in "Essay - Word"`);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("fast lane (UI Automation directly)", () => {
  // a stand-in for native/win/fastlane.ps1: the same protocol
  const helper = `
    process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
    let buf = "";
    process.stdin.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\\n")) >= 0) {
        const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const ok = r.op === "press" && r.role === "Button" && r.label === "Seven" && r.hwnd === 9 && r.w === 40;
        const reply = ok ? { id: r.id, ok: true, ms: 2.5, how: "hit-test invoke" }
          : { id: r.id, ok: false, ms: 1, error: r.op === "type" ? "inside a web page: needs key events " + r.text : "element not found where the agent saw it" };
        setTimeout(() => process.stdout.write(JSON.stringify(reply) + "\\n"), r.op === "type" ? 5 : 30);   // answers out of order
      }
    });`;

  test("presses and inserts go to the helper; what it can't do comes back not ok (then the driver uses Cua)", async () => {
    const lane = new FastLane({ spawn: () => Bun.spawn([process.execPath, "-e", helper], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) });
    expect(await lane.whenReady()).toBe(true);
    const seven = { pid: 42, hwnd: 9, frame: { x: 10, y: 20, w: 40, h: 30 }, role: "Button", label: "Seven" };
    const [press, type] = await Promise.all([lane.press(seven), lane.type({ ...seven, role: "Edit", label: "Search" }, "café")]);
    expect(press).toEqual({ ok: true, ms: 2.5, how: "hit-test invoke", error: undefined });
    expect(type).toMatchObject({ ok: false, error: "inside a web page: needs key events café" });
    expect((await lane.press({ ...seven, label: "Eight" })).error).toBe("element not found where the agent saw it");
    lane.stop();
  });

  test("an app whose packaged entry is broken is started from its shortcut", () => {
    const dir = mkdtempSync(join(tmpdir(), "startmenu-"));
    mkdirSync(join(dir, "Visual Studio Code"), { recursive: true });
    for (const f of ["Visual Studio Code/Visual Studio Code.lnk", "Visual Studio Code/Uninstall Visual Studio Code.lnk", "Discord.lnk", "Discord Updater.lnk"]) writeFileSync(join(dir, f), "");
    expect(findShortcut("Visual Studio Code", [dir])).toBe(join(dir, "Visual Studio Code", "Visual Studio Code.lnk"));
    expect(findShortcut("Discord", [dir])).toBe(join(dir, "Discord.lnk"));
    expect(findShortcut("Photoshop", [dir])).toBeUndefined();
  });

  test("off when the helper doesn't start, or with FAST_INPUT=off: nothing waits on it", async () => {
    const dead = new FastLane({ spawn: () => Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) });
    expect(await dead.whenReady()).toBe(false);
    expect((await dead.press({ pid: 1, frame: { x: 0, y: 0, w: 5, h: 5 }, role: "Button" })).ok).toBe(false);
    process.env.FAST_INPUT = "off";
    try { expect(await new FastLane().whenReady()).toBe(false); } finally { delete process.env.FAST_INPUT; }
  });
});

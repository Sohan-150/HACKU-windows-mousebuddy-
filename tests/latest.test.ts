// The Mac version's latest features (commits 5f250e6..7e72513), on Windows: one command split per app with context
// sentences left out, stocks and travel times opened straight to the answer, web answers found by their shape, short
// spoken results for many agents, and the general rules for messaging apps (which value goes in which field, search
// for who isn't on screen, never send unless asked). No network, no Cua.
import { describe, expect, test } from "bun:test";
import { newTask, runTask, type JevLike } from "../src/agent";
import type { AgentState, Decision, Driver, Element, HandName, Kind, Observation, Plan, WindowRef } from "../src/contracts";
import type { Classification, StepState, TaskType } from "../src/jev";
import { MemoryLogger } from "../src/logger";
import { joinFragments, NEEDS_NUMBER, relevantLines } from "../src/perceive";
import { assistantPart, gameLink, planWithJev, splitParts, stockQuote, weatherPlace } from "../src/planner";
import { brief, spokenSummary, tidyAnswer } from "../src/results";
import { goalValues, messageOf } from "../src/values";
import { cleanName } from "../src/driver/win";

process.env.SPEAK = "off";
process.env.OVERLAY = "off";

const S1 = "I am flying to Tokyo tomorrow. In Maps, how long does it take to drive from the University of Hong Kong to Hong Kong International Airport, in Weather check the weather in Tokyo, in Stocks check Sony stock price, in Safari find how much 10000 Japanese yen is in Hong Kong dollars, in Brave find the flight time from Hong Kong to Tokyo, and make a word doc with a 3 day Tokyo itinerary";

describe("one command, many agents (the Mac showcase prompts)", () => {
  test("splits into one part per app; the first sentence asks for nothing, so it is context", async () => {
    expect(splitParts(S1)).toEqual([
      "I am flying to Tokyo tomorrow",
      "In Maps, how long does it take to drive from the University of Hong Kong to Hong Kong International Airport",
      "in Weather check the weather in Tokyo", "in Stocks check Sony stock price",
      "in Safari find how much 10000 Japanese yen is in Hong Kong dollars", "in Brave find the flight time from Hong Kong to Tokyo",
      "make a word doc with a 3 day Tokyo itinerary",
    ]);
    const asked: string[] = [];
    const jev = { classify: async (part: string): Promise<Classification> => { asked.push(part); return { type: (/word doc/.test(part) ? "write_text" : "web_question") as TaskType, typeConf: 0.9, appConf: 0, fileOpConf: 0, inputTokens: 100, ms: 1 }; } } as any;
    const r = await planWithJev(S1, jev, ["Notepad", "Word"], { home: "C:\\Users\\t", defer: ["write_text"] });
    expect(asked[0]).toStartWith("In Maps");                       // the context sentence was never classified
    expect(asked).toContain("find how much 10000 Japanese yen is in Hong Kong dollars");   // "in Safari" -> the agent's browser
    expect(r.deferred).toBe(true);                                  // composing the itinerary is Claude's job
    const urls = asked.slice(0, 5).map(p => (assistantPart(p)?.surface as any)?.url ?? "web search");
    expect(urls[0]).toBe("https://www.google.com/maps/dir/?api=1&origin=University%20of%20Hong%20Kong&destination=Hong%20Kong%20International%20Airport&travelmode=driving&hl=en");
    expect(urls[1]).toStartWith("https://wttr.in/Tokyo?");
    expect(urls[2]).toBe("https://www.google.com/finance/quote/SONY:NYSE?hl=en");
    expect(urls[3]).toBe("web search");
    expect(assistantPart(asked[4])?.goal).toContain("How long the flight takes");
  });

  test("travel modes, weather places and stock symbols, read in code", () => {
    expect((assistantPart("In Maps how long does it take to get from the University of Hong Kong to Tsim Sha Tsui by public transport")?.surface as any).url).toContain("travelmode=transit");
    expect((assistantPart("how long does it take to walk from HKU to Kennedy Town")?.surface as any).url).toContain("travelmode=walking");
    expect(weatherPlace("in Weather check the weather in Hong Kong")).toBe("Hong Kong");
    expect(weatherPlace("what's the weather in Tokyo tonight")).toBe("Tokyo");
    expect(stockQuote("in Stocks check HSBC stock price")?.url).toBe("https://www.google.com/finance/quote/0005:HKG?hl=en");
    expect(stockQuote("check NVDA in Stocks")?.symbol).toBe("NVDA");
    expect(stockQuote("In Stocks look at my watchlist")).toBeNull();
    expect(stockQuote("what time does the shop open")).toBeNull();
  });
});

describe("answers", () => {
  test("web answers: a split sentence is joined, and answer-shaped lines make the shortlist", () => {
    expect(joinFragments(["A Symphony of Lights starts every night at", "8:00 p.m. sharp", "Tourism Commission"])).toEqual(["A Symphony of Lights starts every night at 8:00 p.m. sharp", "Tourism Commission"]);
    const filler = Array.from({ length: 40 }, (_, i) => `Symphony of Lights result ${i}`);
    expect(relevantLines([...filler, "8pm (20:00) sharp, every night"], "find what time the Symphony of Lights starts", 30, 8)).toContain("8pm (20:00) sharp, every night");
    expect(NEEDS_NUMBER.test("check the weather in Tokyo")).toBe(true);
  });

  test("tidied for the widgets; with three or more agents each spoken result is cut to its gist", () => {
    expect(tidyAnswer("window title: Tokyo Tokyo, 17 degrees Celsius")).toBe("Tokyo, 17 degrees Celsius");
    expect(tidyAnswer("AI Overview , 8:00 p.m. every night\uFFFC")).toBe("8:00 p.m. every night");
    expect(brief("Hong Kong International Airport 29 min, 12:06 ETA · 35 km, Fastest Tolls required")).toBe("Hong Kong International Airport 29 min, 35 km");
    const a = (name: string, app: string, goal: string, answer: string): AgentState => ({ id: name, taskId: "t", sub: 0, name, colour: "#fff", app, goal, status: "done", now: "", answer, steps: 1, seconds: 1 });
    expect(spokenSummary([
      a("Mint", "Google Maps", "drive", "Hong Kong International Airport 29 min, 12:06 ETA · 35 km, Fastest Tolls required"),
      a("Cyan", "wttr.in", "check the weather", "window title: Tokyo Tokyo, 17 degrees Celsius, Partly Cloudy, High: 23 degrees Celsius"),
      a("Amber", "Word", "make a word doc", "Saved C:\\Users\\sohan\\Documents\\Plan.docx and opened it in Microsoft Word"),
    ], "finished")).toBe("In Google Maps: Hong Kong International Airport 29 min, 35 km. In wttr.in: Tokyo, 17 degrees Celsius, Partly Cloudy. In Word: your Word document is ready.");
  });
});

describe("messaging apps: which value goes where, and nothing is sent unless asked", () => {
  test("who to reach and what to say are told apart; the app itself is never a contact", () => {
    expect(goalValues("Open WhatsApp, message Sohan \"hi\"", "WhatsApp")).toEqual({ quoted: ["hi"], names: ["Sohan"], targets: ["Sohan"] });
    expect(messageOf("go to WhatsApp and message Mohit hi", "WhatsApp")).toEqual({ to: "Mohit", text: "hi" });
    expect(messageOf("send a message to my most recent chat on Discord saying hi, this is the background agent typing", "Discord")).toEqual({ to: undefined, text: "hi, this is the background agent typing" });
    expect(messageOf("open the chat with Mum", "WhatsApp")).toEqual({ to: "Mum", text: undefined });
    expect(cleanName("\u200eWhatsApp")).toBe("WhatsApp");
  });

  // A chat app: a search field and a chat list; a contact's chat has a message field and a Send button.
  class ChatApp implements Driver {
    caps = { platform: "sim" as const, name: "chat app" };
    chat = ""; search = ""; message = ""; sent: string[] = []; actions: string[] = [];
    async ensureSession() {}
    async listApps() { return ["WhatsApp"]; }
    async endAll() {}
    async open(): Promise<WindowRef> { return { kind: "app", pid: 7, windowId: 70, app: "WhatsApp", title: "WhatsApp" }; }
    async observe(hand: HandName, w: WindowRef): Promise<Observation> {
      const el = (index: number, role: Element["role"], label: string, value?: string): Element => ({ index, token: `t${index}`, role, label, value, inView: true, enabled: true });
      const els: Element[] = [el(0, "text field", "Search or start a new chat", this.search), el(1, "list item", "Alice")];
      if (/mohit/i.test(this.search)) els.push(el(2, "list item", "Mohit"));
      if (this.chat) els.push(el(3, "text", this.chat), el(4, "text field", "Type a message", this.message), el(5, "button", "Send"));
      return { hand, t: "", window: w, title: this.chat ? `${this.chat} - WhatsApp` : "WhatsApp", elements: els, text: this.sent.map(m => `You: ${m}`), truncated: false, ms: 1 };
    }
    async act(_h: HandName, _w: WindowRef, a: any) {
      this.actions.push(a.tool === "type" ? `type ${a.token} "${a.text}"` : `${a.tool} ${a.token ?? a.key ?? ""}`.trim());
      if (a.tool === "type" && a.token === "t0") this.search = a.text;
      if (a.tool === "type" && a.token === "t4") this.message = a.text;
      if (a.tool === "click" && a.token === "t2") this.chat = "Mohit";
      if ((a.tool === "click" && a.token === "t5") || (a.tool === "key" && a.key === "enter" && a.token === "t4")) { if (this.message) this.sent.push(this.message); this.message = ""; }
      return { ok: true, ms: 1, cli: "" };
    }
  }

  const d = (kind: Kind, item?: number, extra: Partial<Decision> = {}): Decision => ({ kind, item, conf: { kind: 0.9, item: 0.9, value: 0.9 }, gate: 0.9, backend: "jev", model: "fake", inputTokens: 1, outputTokens: 0, ms: 1, ...extra });
  /** a jev that, like a hasty one, picks the WRONG value for the message field ("Mohit" instead of "hi") */
  const hastyJev = (app: ChatApp, wantDone: () => boolean): JevLike => ({
    async decide(s: StepState) {
      const find = (re: RegExp) => s.items.find(i => re.test(i.text));
      const row = find(/^Mohit$/), box = find(/Type a message/);
      if (box && !box.value && !app.sent.length) return d("type", box.i, { valueName: "who to reach", text: "Mohit" });
      if (box && box.value) return d("press_enter", box.i);
      if (row && !app.chat) return d("click", row.i);
      return wantDone() ? d("done") : d("click", find(/^Send$/)?.i);
    },
    extra: { classify: async () => ({ type: "open_app" as TaskType, typeConf: 0.9, app: "WhatsApp", appConf: 0.9, fileOpConf: 0, inputTokens: 1, ms: 1 }), checkDone: async () => ({ done: wantDone() ? 0.95 : 0.1, answerConf: 1, inputTokens: 1, ms: 1 }) },
  });
  const plan = (goal: string): Plan => ({ by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "WhatsApp" }, goal, values: [{ name: "who to reach", text: "Mohit" }, { name: "message", text: "hi" }] }] });
  const claudePlans = (p: Plan) => ({ usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, plan: async () => ({ plan: p, ms: 1 }) }) as any;
  const run = (app: ChatApp, goal: string, done: () => boolean) =>
    runTask(newTask(goal, "typed"), { driver: app, claude: { ...claudePlans(plan(goal)), decide: async () => ({ ...d("stuck"), backend: "claude", reason: "stopped" }), write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => ({ complete: done(), answer: done() ? "Sent." : "", evidence: "", ms: 0 }) }, jev: hastyJev(app, done), log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true, maxSteps: 12 });

  test("'message Mohit hi': searches for Mohit (not on screen), opens his chat, and sends 'hi', never his name", async () => {
    const app = new ChatApp();
    const t = await run(app, "go to WhatsApp and message Mohit hi", () => app.sent.length > 0);
    expect(app.actions[0]).toBe('type t0 "Mohit"');                  // searched first: Mohit was not in the chat list
    expect(app.sent).toEqual(["hi"]);                                // the hasty "Mohit" for the message field was replaced
    expect(t.status).toBe("done");
  });

  test("'open the chat with Mohit' sends nothing: the message field, Enter and Send are all blocked", async () => {
    const app = new ChatApp();
    await run(app, "open the chat with Mohit", () => false);
    expect(app.chat).toBe("Mohit");
    expect(app.sent).toEqual([]);
    expect(app.actions.some(a => a.startsWith("type t4") || a === "click t5")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// From the Windows run of 4 Oct: the cases that went wrong, replayed.
import { toggleGoal, toggleState } from "../src/agent";
import { uiaWindowState, appObservation } from "../src/driver/win";
import { perceive } from "../src/perceive";
import { FastLane } from "../src/fastlane";
import { App } from "../src/server";
import type { Item } from "../src/contracts";
import { runByPicture } from "../src/agent";
import { WinDriver } from "../src/driver/win";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("the 4 Oct run, replayed", () => {
  const item = (i: number, role: string, text: string, state?: string): Item => ({ i, id: `${role}:${text}`, role: role as any, text, token: `t${i}`, state });

  test("Discord: mute state read in code (another person's 'Muted' tile doesn't count)", () => {
    expect(toggleGoal("Unmute my mic on discord.")).toEqual({ what: "mute", on: false });
    expect(toggleGoal("The microphone is unmuted in Discord (the mute button shows the mic is on)")).toEqual({ what: "mute", on: false });
    expect(toggleGoal("The microphone is muted in Discord")).toEqual({ what: "mute", on: true });
    expect(toggleGoal("Deafen me on Discord")).toEqual({ what: "deafen", on: true });
    expect(toggleGoal("play Drake on Spotify")).toBeUndefined();
    const muted = [item(84, "button", "Mute"), item(94, "button", "Unmute"), item(101, "button", "dark_ravager, Muted")];
    expect(toggleState({ what: "mute" }, muted)).toMatchObject({ on: true, release: { text: "Unmute" } });
    const unmuted = [item(86, "button", "Mute"), item(102, "button", "dark_ravager, Muted")];
    expect(toggleState({ what: "mute" }, unmuted)).toMatchObject({ on: false, press: { text: "Mute" } });
    expect(toggleState({ what: "mute" }, [item(1, "button", "Mute", "on")]).on).toBe(true);     // a switch that keeps its label
    expect(toggleState({ what: "deafen" }, unmuted)).toEqual({});
  });

  // Discord in a call: muted, with the call's own "Unmute" button
  class Discord implements Driver {
    caps = { platform: "sim" as const, name: "discord" };
    muted = true; clicks: string[] = [];
    async ensureSession() {} async listApps() { return ["Discord"]; } async endAll() {}
    async open(): Promise<WindowRef> { return { kind: "app", pid: 9, windowId: 90, app: "Discord", title: "hi, dark_ravager - Discord" }; }
    async observe(hand: HandName, w: WindowRef): Promise<Observation> {
      const el = (index: number, label: string): Element => ({ index, token: `d${index}`, role: "button", label, inView: true, enabled: true });
      const els = [el(0, "Mute"), el(1, "dark_ravager, Muted"), ...(this.muted ? [el(2, "Unmute")] : [])];
      return { hand, t: "", window: w, title: w.title, elements: els, text: [], truncated: false, ms: 1 };
    }
    async act(_h: HandName, _w: WindowRef, a: any) { this.clicks.push(a.token); if (a.token === "d2") this.muted = false; return { ok: true, ms: 1, cli: "" }; }
  }

  test("'Unmute my mic on discord': one click on Unmute, done in code, no model call", async () => {
    const app = new Discord();
    let modelCalls = 0;
    const claude = { usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, plan: async () => { modelCalls++; return { plan: { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Discord" }, goal: "The microphone is unmuted in Discord.", values: [] }] } as Plan, ms: 1 }; },
      decide: async () => { modelCalls++; throw new Error("no"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => { modelCalls++; return { complete: false, answer: "", evidence: "", ms: 0 }; } };
    const jev = { decide: async () => { throw new Error("not needed"); }, extra: { classify: async () => ({ type: "open_app" as TaskType, typeConf: 0.9, app: "Discord", appConf: 0.9, fileOpConf: 0, inputTokens: 1, ms: 1 }), checkDone: async () => ({ done: 0, answerConf: 0, inputTokens: 0, ms: 0 }) } };
    const t = await runTask(newTask("Unmute my mic on discord.", "voice"), { driver: app, claude: claude as any, jev: jev as any, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
    expect(app.clicks).toEqual(["d2"]);
    expect(t.status).toBe("done");
    expect(t.result?.answer).toBe("You're unmuted in hi, dark_ravager.");
    expect(modelCalls).toBe(0);                                      // planned by jev + rules, pressed and checked in code
  });

  test("WhatsApp: Claude's goal wording ('The message '...' has been sent to Mohit') searches for Mohit, not the message", async () => {
    expect(goalValues("The message 'you are crazy man it works' has been sent to Mohit in WhatsApp.", "WhatsApp").targets).toEqual(["Mohit"]);
    expect(messageOf("Open whatsapp and message mohit you are crazy man it works", "WhatsApp")).toEqual({ to: "mohit", text: "you are crazy man it works" });
  });

  test("planning: 'play drake on spotify' is planned by jev + rules at once (Spotify's own search link); unsure goes to Claude", async () => {
    const jevSays = (typeConf: number) => ({ classify: async () => ({ type: "open_app" as TaskType, typeConf, app: "Spotify", appConf: 0.9, fileOpConf: 0, inputTokens: 1, ms: 1 }) }) as any;
    const sure = await planWithJev("play drake on spotify", jevSays(0.9), ["Spotify"], { home: "C:\\Users\\t", defer: ["web_task", "chat", "unclear"] });
    expect(sure.deferred).toBe(false);
    expect(sure.plan.subtasks[0]).toMatchObject({ surface: { kind: "app", app: "Spotify", uri: "spotify:search:drake" }, goal: "music for drake is playing in Spotify", check: { kind: "playing" } });
    const unsure = await planWithJev("play drake on spotify", jevSays(0.5), ["Spotify"], { home: "C:\\Users\\t", defer: ["web_task", "chat", "unclear"] });
    expect(unsure.deferred).toBe(true);
  });

  test("the fast read (one cached UI Automation call) becomes the same observation as Cua's read", () => {
    const d = uiaWindowState({ ok: true, ms: 40, seq: 3, title: "Calculator", elements: [
      { i: 0, role: "Text", name: "Display is 0", x: 10, y: 10, w: 200, h: 40 },
      { i: 1, role: "Button", name: "Five", x: 10, y: 60, w: 50, h: 40 },
      { i: 2, role: "Button", name: "Mute", toggle: "on", x: 70, y: 60, w: 50, h: 40 },
    ] }, 4242);
    const obs = appObservation(d, { kind: "app", pid: 1, windowId: 4242, app: "Calculator", title: "Calculator" }, "Purple-1", 40);
    expect(obs.elements.map(e => [e.token, e.role, e.label])).toEqual([["uia:4242:3:0", "text", "Display is 0"], ["uia:4242:3:1", "button", "Five"], ["uia:4242:3:2", "button", "Mute"]]);
    expect(obs.text).toEqual(["Display is 0"]);
    expect(perceive(obs, "mute", 120).items.find(i => i.text === "Mute")?.state).toBe("on");
  });

  test("the helper's read and act-by-reference speak the protocol", async () => {
    const helper = `
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
      let buf = "";
      process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        const reply = r.op === "read" ? { id: r.id, ok: true, ms: 35, seq: 1, title: "Calc", elements: [{ i: 0, role: "Button", name: "Five", x: 1, y: 2, w: 3, h: 4 }] }
          : r.ref === "7:1:0" ? { id: r.id, ok: true, ms: 2, how: "ref invoke" } : { id: r.id, ok: false, ms: 1, error: "stale: the window was read again since" };
        process.stdout.write(JSON.stringify(reply) + "\\n"); } });`;
    const lane = new FastLane({ spawn: () => Bun.spawn([process.execPath, "-e", helper], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) });
    expect(await lane.whenReady()).toBe(true);
    const r = await lane.read(7);
    expect([r.ok, r.seq, r.elements?.[0]?.name]).toEqual([true, 1, "Five"]);
    expect(await lane.pressRef("7:1:0")).toMatchObject({ ok: true, how: "ref invoke" });
    expect((await lane.pressRef("7:0:0")).error).toContain("stale");
    lane.stop();
  });

  test("'mute me on Discord and then show me how to calculate 5 times 79': the job runs, the 'show me how' is taught", async () => {
    const sent: any[] = [];
    const desktop = Object.assign(new (await import("../src/driver/sim")).SimDriver(), { caps: { platform: "win32" as const, name: "test" } });
    const explained: string[] = [];
    const app = new App(desktop, null, null, "Mint-3", { send: m => { sent.push(m); return true; }, voice: new (await import("../src/voice")).Voice({ key: "" }),
      capture: async () => ({ imgW: 0, imgH: 0, screen: { x: 0, y: 0, w: 0, h: 0 }, controls: [], ms: 0, error: "test" }) });
    const ask = app.explainer.ask.bind(app.explainer);
    app.explainer.ask = async (text: string, ...rest: any[]) => { explained.push(text); return ask(text, ...rest); };
    await app.hotkey("Mute my mic on discord and then show me how to calculate 5 times 79 on the calculator", "voice");
    expect(app.tasks.map(t => t.instruction)).toEqual(["Mute my mic on discord", "show me how to calculate 5 times 79 on the calculator"]);
    for (let i = 0; i < 50 && !explained.length; i++) await Bun.sleep(10);
    expect(explained).toEqual(["show me how to calculate 5 times 79 on the calculator"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// "Ensure it can work with any app": what a background action can't do (a web view's field in WhatsApp, a chat row
// that only opens on a click, Enter) is done with the window in front for a moment; an app that shows nothing is
// operated from pictures, typing included.
describe("any app: the foreground fallback and pictures", () => {
  const W: WindowRef = { kind: "app", pid: 77, windowId: 5150, app: "WhatsApp", title: "WhatsApp" };
  /** a stand-in for the helper: reads give a WhatsApp-like window, actions answer as the real one does for a web view */
  const fakeLane = (calls: any[], over: Record<string, any> = {}) => ({
    on: true, reason: "",
    read: async () => ({ ok: true, ms: 20, seq: 4, title: "WhatsApp", elements: [
      { i: 0, role: "ListItem", name: "Mohit", x: 100, y: 200, w: 300, h: 60 },
      { i: 1, role: "Edit", name: "Type a message", x: 500, y: 900, w: 800, h: 40 },
      { i: 2, role: "Button", name: "Send", x: 1310, y: 900, w: 40, h: 40, enabled: false },
      { i: 3, role: "Text", name: "Chats", x: 100, y: 100, w: 80, h: 30 },
    ] }),
    pressRef: async (ref: string) => { calls.push({ op: "press", ref }); return ref.endsWith(":2") ? { ok: false, ms: 1, error: "the control is disabled" } : { ok: false, ms: 1, error: "a list row needs a click" }; },
    typeRef: async (ref: string, text: string) => { calls.push({ op: "type", ref, text }); return { ok: false, ms: 1, error: "inside a web page: needs key events" }; },
    frontType: async (o: any) => { calls.push({ op: "front", ...o }); return { ok: true, ms: 180, how: "focus click typed in front" }; },
    windows: async () => ({ ok: true, ms: 2, windows: [{ window_id: 5150, pid: 77, title: "WhatsApp", app_name: "WhatsApp.Root.exe", bounds: { x: 0, y: 0, width: 1400, height: 1000 }, minimized: true }] }),
    restore: async (hwnd: number) => { calls.push({ op: "restore", hwnd }); return { ok: true, ms: 1 }; },
    stop() {},
    ...over,
  });
  const driverWith = (lane: any) => { const d = new WinDriver(); Object.defineProperty(d, "fast", { value: lane }); return d; };

  test("WhatsApp's message box (a web view): typed for real with the window in front, old text replaced; a chat row is clicked", async () => {
    const calls: any[] = [];
    const d = driverWith(fakeLane(calls));
    const obs = await d.observe("Purple-1", W);
    const tok = (label: string) => obs.elements.find(e => e.label === label)!.token!;
    const typed = await d.act("Purple-1", W, { tool: "type", token: tok("Type a message"), text: "hi" });
    expect(typed).toMatchObject({ ok: true, route: "foreground" });
    expect(calls.at(-1)).toEqual({ op: "front", hwnd: 5150, ref: "5150:4:1", target: undefined, text: "hi", key: undefined, replace: true, click: { x: 900, y: 920 }, soft: false });
    // Enter: on the field as it is (no click that would move the caret), with the window in front
    await d.act("Purple-1", W, { tool: "key", key: "enter", token: tok("Type a message") });
    expect(calls.at(-1)).toMatchObject({ op: "front", ref: "5150:4:1", key: "enter", soft: true, text: undefined });
    // a chat row has no Invoke: a real click on it
    expect(await d.act("Purple-1", W, { tool: "click", token: tok("Mohit") })).toMatchObject({ ok: true, route: "foreground" });
    expect(calls.at(-1)).toMatchObject({ op: "front", ref: "5150:4:0", click: { x: 250, y: 230 } });
    // a disabled button is never clicked some other way
    const n = calls.length;
    expect(await d.act("Purple-1", W, { tool: "click", token: tok("Send") })).toMatchObject({ ok: false, error: { code: "refused" } });
    expect(calls.length).toBe(n + 1);
  });

  test("a stale reference is read again (not a foreground click); a minimised app window is shown again, not lost", async () => {
    const calls: any[] = [];
    const d = driverWith(fakeLane(calls, { pressRef: async () => ({ ok: false, ms: 1, error: "stale: the window was read again since" }) }));
    const obs = await d.observe("Purple-1", W);
    expect(await d.act("Purple-1", W, { tool: "click", token: obs.elements[0]!.token! })).toMatchObject({ ok: false, error: { code: "stale" } });
    expect(calls.some(c => c.op === "front")).toBe(false);
    const back = await d.rebind!("Purple-1", { ...W, pid: -1, windowId: -1 });
    expect(back).toMatchObject({ windowId: 5150, pid: 77 });
    expect(calls).toContainEqual({ op: "restore", hwnd: 5150 });
  });

  test("the helper's front_type speaks the protocol: key codes, replace, soft focus, a screen point", async () => {
    const helper = `
      process.stdout.write(JSON.stringify({ ready: true }) + "\\n");
      let buf = "";
      process.stdin.on("data", d => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const r = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        process.stdout.write(JSON.stringify({ id: r.id, ok: true, ms: 3, how: JSON.stringify(r) }) + "\\n"); } });`;
    const lane = new FastLane({ spawn: () => Bun.spawn([process.execPath, "-e", helper], { stdin: "pipe", stdout: "pipe", stderr: "ignore" }) });
    expect(await lane.whenReady()).toBe(true);
    const sent = JSON.parse((await lane.frontType({ hwnd: 9, ref: "9:1:2", text: "héllo", key: "enter", replace: true, click: { x: 10.4, y: 20.6 } })).how!);
    expect(sent).toMatchObject({ op: "front_type", hwnd: 9, ref: "9:1:2", text: "héllo", vk: 13, replace: true, soft: false, cx: 10, cy: 21 });
    const esc = JSON.parse((await lane.frontType({ hwnd: 9, key: "escape", soft: true })).how!);
    expect([esc.vk, esc.soft, esc.cx, esc.text]).toEqual([27, true, undefined, ""]);
    const t = JSON.parse((await lane.frontType({ hwnd: 9, target: { pid: 3, hwnd: 9, frame: { x: 1, y: 2, w: 3, h: 4 }, role: "Edit", label: "Search" }, text: "x" })).how!);
    expect(t).toMatchObject({ pid: 3, x: 1, y: 2, w: 3, h: 4, role: "Edit", label: "Search", vk: 0 });
    lane.stop();
  });

  test("an app that shows nothing, from pictures: a click that changes nothing makes the next ones real; Enter in a message box only when asked to send", async () => {
    const png = join(tmpdir(), `pic-${Date.now()}.png`);
    const acts: any[] = [];
    const driver = {
      caps: { platform: "win32", name: "pic" },
      picture: async () => { writeFileSync(png, "same pixels"); return { path: png, imgW: 640, imgH: 400, k: 2 }; },
      clickAt: async (_h: any, _w: any, x: number, y: number, opts: any) => { acts.push(["click", x, y, !!opts?.front]); return { ok: true, ms: 1, cli: "" }; },
      typeAt: async (_h: any, _w: any, x: number, y: number, text: string, enter: boolean) => { acts.push(["type", x, y, text, enter]); return { ok: true, ms: 1, cli: "" }; },
      act: async (_h: any, _w: any, a: any) => { acts.push([a.tool, a.key ?? a.direction]); return { ok: true, ms: 1, cli: "" }; },
    } as any;
    const looks: any[] = [
      { kind: "click", x: 50, y: 60, label: "Chats", text: "", enter: false, last_worked: true },
      { kind: "click", x: 70, y: 80, label: "Mohit", text: "", enter: false, last_worked: false },
      { kind: "type", x: 300, y: 380, label: "Type a message", text: "hi there", enter: true, last_worked: true },
      { kind: "key", x: 0, y: 0, label: "", text: "escape", enter: false, last_worked: true },
      { kind: "done", x: 0, y: 0, label: "", text: "", enter: false, last_worked: true, answer: "The chat with Mohit is open." },
    ];
    const claude = { look: async () => ({ reason: "", answer: "", ms: 1, ...looks.shift() }) } as any;
    const task = newTask("open the chat with Mohit on WhatsApp and type hi there", "typed");
    const sub = { surface: { kind: "app" as const, app: "WhatsApp" }, goal: "the chat with Mohit is open with 'hi there' typed", values: [] };
    const r = await runByPicture(task, 0, sub, { driver, claude, jev: null, log: new MemoryLogger(), approve: async () => true, signal: new AbortController().signal }, "Purple-1", W, "WhatsApp", []);
    expect(r.answer).toBe("The chat with Mohit is open.");
    expect(acts).toEqual([
      ["click", 100, 120, false],
      ["click", 140, 160, true],                    // the same picture after the first click: real clicks from now on
      ["type", 600, 760, "hi there", false],        // a message box, and the goal doesn't ask to send: no Enter
      ["key", "escape"],
    ]);
    rmSync(png, { force: true });
  });

  test("pictures hand back to reading the window once its controls appear; no Enter into a field with no name", async () => {
    const png = join(tmpdir(), `pic2-${Date.now()}.png`);
    const acts: any[] = [];
    let reads = 0;
    const el = (index: number, label: string): Element => ({ index, token: `u${index}`, role: "button", label, inView: true, enabled: true });
    const driver = {
      caps: { platform: "win32", name: "pic" },
      picture: async () => { writeFileSync(png, `pixels ${acts.length}`); return { path: png, imgW: 640, imgH: 400, k: 1 }; },
      clickAt: async () => ({ ok: true, ms: 1, cli: "" }),
      typeAt: async (_h: any, _w: any, x: number, y: number, text: string, enter: boolean) => { acts.push(["type", text, enter]); return { ok: true, ms: 1, cli: "" }; },
      act: async () => ({ ok: true, ms: 1, cli: "" }),
      observe: async (hand: HandName, w: WindowRef): Promise<Observation> => {
        reads++;
        const els = reads < 2 ? [el(0, "Minimize"), el(1, "Close")] : ["Home", "Search", "Your Library", "Play", "Next"].map((l, i) => el(i, l));
        return { hand, t: "", window: w, title: "Spotify", elements: els, text: [], truncated: false, ms: 1 };
      },
    } as any;
    const claude = { look: async () => ({ kind: "type", x: 10, y: 10, label: "", text: "drake", enter: true, last_worked: true, reason: "", answer: "", ms: 1 }) } as any;
    const sub = { surface: { kind: "app" as const, app: "Spotify" }, goal: "music for drake is playing in Spotify", values: [] };
    const r = await runByPicture(newTask("play drake on spotify", "typed"), 0, sub, { driver, claude, jev: null, log: new MemoryLogger(), approve: async () => true, signal: new AbortController().signal }, "Purple-1", { ...W, app: "Spotify" }, "Spotify", [], { resumable: true });
    expect(acts).toEqual([["type", "drake", false], ["type", "drake", false]]);   // no name for the field, nothing to send: no Enter
    expect([r.resume, reads]).toEqual([true, 2]);         // step 2 read the title bar only; step 3 read 5 controls: back to reading
    rmSync(png, { force: true });
  });
});

describe("games and launchers", () => {
  test("a game starts by its launcher's own link; 'open Epic Games' before it is not a part of its own", async () => {
    const apps = ["Epic Games Launcher", "Steam", "Discord"];
    expect(gameLink("launch Fortnite", apps)).toEqual({ name: "Fortnite", app: "Epic Games Launcher", uri: "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true" });
    expect(gameLink("play CS2", apps)?.uri).toBe("steam://rungameid/730");
    expect(gameLink("what is Fortnite", apps)).toBeUndefined();          // not asked to start it
    expect(gameLink("launch Minesweeper", apps)).toBeUndefined();        // a game it doesn't know: the agent finds it
    const jev = { classify: async (part: string): Promise<Classification> => ({ type: "open_app" as TaskType, typeConf: 0.9, app: /fortnite/i.test(part) ? "Fortnite" : "Epic Games Launcher", appConf: 0.9, fileOpConf: 0, inputTokens: 1, ms: 1 }) } as any;
    const r = await planWithJev("Open Epic Games and launch Fortnite", jev, apps, { home: "C:\\Users\\t", defer: ["web_task", "chat", "unclear"] });
    expect(r.plan.subtasks).toHaveLength(1);
    expect(r.plan.subtasks[0]).toMatchObject({ surface: { kind: "app", app: "Epic Games Launcher", uri: "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true" } });
    expect(r.plan.subtasks[0]!.goal).toContain("report any update");
  });
});

// Point-and-ask (Claude, jev only, nothing under the pointer), spoken commands, conversation memory, and the
// everyday-request rules (flights, directions, weather, site searches). No network, no Cua.
import { describe, expect, test } from "bun:test";
import { askScreen, markTarget, whatIsThis } from "../src/ask";
import type { Classification, TaskType } from "../src/jev";
import { SimDriver } from "../src/driver/sim";
import { assistantPart, directions, flightQuery, planWithJev, siteSearchUrl, weatherPlace } from "../src/planner";
import { isPointerQuestion, wantsPointing, type PointedElement, type PointerContext } from "../src/pointer";
import { App } from "../src/server";

process.env.SPEAK = "off";
process.env.HIGHLIGHT = "off";            // nothing drawn on the screen during tests
process.env.BUBBLE = "off";
const at = { x: 500, y: 400, t: "2026-10-03T00:00:00Z" };
const el = (index: number, role: string, label: string, x: number, y: number, value?: string): PointedElement => ({ index, role, label, value, frame: { x, y, w: 60, h: 30 } });
const SAVE = el(3, "Button", "Save", 480, 390), OPEN = el(4, "Button", "Open", 600, 390), BODY = el(5, "Document", "", 0, 0, "Dear team, the meeting moved to Friday.");
const ctx = (over: Partial<PointerContext> = {}): PointerContext => ({
  ...at, window: { pid: 1, windowId: 2, title: "Untitled - Notepad", app: "Notepad", bounds: { x: 0, y: 0, width: 1000, height: 800 } },
  element: SAVE, nearby: [OPEN], all: [SAVE, OPEN], ...over,
});
const noLook = async () => { throw new Error("should use the given context"); };

describe("point-and-ask", () => {
  test("which utterances are about the pointer", () => {
    for (const q of ["what is this?", "What does this button do", "where is the save button", "how do I print this page", "can you explain that?", "read this to me"]) expect(isPointerQuestion(q)).toBe(true);
    for (const q of ["open Notepad and write this down", "search for cats on youtube", "find flights to Tokyo", "calculate 5 times 3", "what is the capital of France",
      "how do I get from Central to the airport", "where is Tokyo"]) expect(isPointerQuestion(q)).toBe(false);
    expect(wantsPointing("where is the save button")).toBe(true);
    expect(wantsPointing("what is this")).toBe(false);
  });

  test("Claude answers from the screenshot and controls, and its cursor goes to the control it names", async () => {
    const seen: any[] = [], pointed: PointedElement[] = [];
    const claude = { usage: { usd: 0 }, aboutScreen: async (q: string, p: PointerContext, conv: any[]) => { seen.push({ q, p, conv }); claude.usage.usd += 0.004; return { answer: "Click Open to load a file.", marks: [{ control: 1, shape: "ring", label: "Open" }], ms: 5 }; } };
    const r = await askScreen("how do I open a file here?", at, { hand: "Blue-9", claude: claude as any, jev: null, conversation: [{ instruction: "x", answer: "y" }], look: noLook as any, point: async (_h, e) => { pointed.push(e); return true; } }, ctx());
    expect(r.by).toBe("claude");
    expect(r.answer).toBe("Click Open to load a file.");
    expect(pointed).toEqual([OPEN]);
    expect(r.pointedAt).toContain("Open");
    expect(r.claudeUsd).toBeCloseTo(0.004);
    expect(seen[0].conv).toHaveLength(1);
  });

  test("Claude can mark several things, including regions of the image that are not controls (image px -> screen px)", async () => {
    const drawn: any[] = [], pointed: PointedElement[] = [];
    // window at (100,50), 1000 px wide, screenshot 700 px wide (scale 0.7): image box (350,140,70,35) -> screen (600,250,100,50)
    const c = ctx({ window: { pid: 1, windowId: 2, title: "Animals of the Okavango", app: "chrome", bounds: { x: 100, y: 50, width: 1000, height: 800 } },
      screenshot: { path: "none.png", width: 700, height: 560, px: 0, py: 0 } });
    expect(markTarget({ control: -1, box: { x: 350, y: 140, w: 70, h: 35 }, shape: "ring", label: "cheetah" }, c)!.frame).toEqual({ x: 600, y: 250, w: 100, h: 50 });
    const claude = { usage: { usd: 0 }, aboutScreen: async () => ({ answer: "The cheetah is top left and the hippo is bottom right; I've circled both.", ms: 1,
      marks: [{ control: -1, box: { x: 350, y: 140, w: 70, h: 35 }, shape: "ring", label: "cheetah" }, { control: 0, shape: "box", label: "Save" }] }) };
    const r = await askScreen("circle the cheetah and the save button", at, { hand: "Blue-9", claude: claude as any, jev: null, look: noLook as any,
      point: async (_h, e) => { pointed.push(e); return true; }, draw: (f, o) => { drawn.push({ f, o }); return true; } }, c);
    expect(drawn.map(d => [d.o.shape, d.o.label, d.o.color])).toEqual([["ring", "cheetah", 0], ["box", "Save", 1]]);
    expect(drawn[0].f).toEqual({ x: 600, y: 250, w: 100, h: 50 });
    expect(pointed[0].role).toBe("region");
    expect(r.marked).toEqual(["cheetah", "Save"]);
  });

  test("Claude failing falls back to describing the control (no crash)", async () => {
    const claude = { usage: { usd: 0 }, aboutScreen: async () => { throw new Error("overloaded"); } };
    const r = await askScreen("what is this?", at, { hand: "Blue-9", claude: claude as any, jev: null, look: noLook as any, point: async () => true }, ctx());
    expect(r.by).toBe("code");
    expect(r.answer).toContain('"Save"');
  });

  test("jev only: 'where is X' -> jev picks the control, cursor moves there", async () => {
    const pointed: PointedElement[] = [];
    const jev = { extra: { pickControl: async (_q: string, opts: string[]) => ({ index: opts.findIndex(o => o.includes("Open")), conf: 0.9, inputTokens: 120 }) } };
    const r = await askScreen("where is the open button", at, { hand: "Blue-9", claude: null, jev, look: noLook as any, point: async (_h, e) => { pointed.push(e); return true; } }, ctx());
    expect(r.by).toBe("jev");
    expect(pointed).toEqual([OPEN]);
    expect(r.answer).toContain("moved my cursor");
    expect(r.jevTokens).toBe(120);
  });

  test("jev only: unsure pick does not move the cursor", async () => {
    let moved = false;
    const jev = { extra: { pickControl: async () => ({ index: 0, conf: 0.2, inputTokens: 100 }) } };
    const r = await askScreen("where is the print button", at, { hand: "Blue-9", claude: null, jev, look: noLook as any, point: async () => (moved = true) }, ctx());
    expect(moved).toBe(false);
    expect(r.answer).toContain("couldn't find");
  });

  test("jev only: 'what is this' names the control; 'read this' reads its text", () => {
    expect(whatIsThis("what is this?", ctx())).toBe(`You're pointing at the button "Save" in "Untitled - Notepad".`);
    expect(whatIsThis("read this to me", ctx({ element: BODY }))).toBe("It says: Dear team, the meeting moved to Friday.");
    expect(whatIsThis("explain this", ctx())).toContain("need a Claude API key");
    expect(whatIsThis("what is this", ctx({ element: el(9, "Pane", "", 0, 0) }))).toContain("nearest thing I can read");
  });

  test("nothing under the pointer", async () => {
    const r = await askScreen("what is this", at, { hand: "Blue-9", claude: null, jev: null, look: async () => ({ ...at, nearby: [], all: [] }), point: async () => true });
    expect(r.answer).toContain("can't see a window");
  });
});

describe("spoken commands", () => {
  test("'stop' stops; 'yes'/'no' answers the one pending approval; anything else runs as a task", async () => {
    const app = new App(new SimDriver(), null, null);
    let answered: boolean | undefined;
    (app as any).approvals.set("a1", { req: { id: "a1", taskId: "t", action: "click Send", why: "" }, resolve: (ok: boolean) => { answered = ok; }, timer: setTimeout(() => {}, 1) });
    await app.onSpoken("No.");
    expect(answered).toBe(false);
    await app.onSpoken("stop");
    expect(app.tasks).toHaveLength(0);
    await app.onSpoken("open notepad");
    expect(app.tasks.map(t => [t.instruction, t.source])).toEqual([["open notepad", "voice"]]);
  });
});

describe("everyday-request rules (jev only)", () => {
  test("flights", () => {
    expect(flightQuery("Find flights from Hong Kong to Tokyo on 20 November")).toBe("Flights from Hong Kong to Tokyo on 20 November");
    expect(flightQuery("book a flight to London from Hong Kong next Friday")).toBe("Flights to London from Hong Kong next Friday");
    expect(flightQuery("I want to fly to Tokyo on December 3rd")).toBe("Flights to Tokyo on December 3rd");
    expect(flightQuery("what time does my flight leave")).toBeNull();
    const p = assistantPart("find me a cheap flight from HKG to SIN on 2026-11-12 one way")!;
    expect((p.surface as any).url).toStartWith("https://www.google.com/travel/flights?q=Flights%20from%20HKG%20to%20SIN%20on%202026-11-12%20one%20way&hl=en");   // + &gl, &curr from .env
    expect(p.question).toBe(true);
    expect(p.goal).toContain("Do not enter passenger or payment details");
  });
  test("directions and weather", () => {
    expect(directions("how do I get to the airport from Central by MTR")).toEqual({ from: "Central", to: "the airport" });
    expect(directions("Get directions from Central to the airport")).toEqual({ from: "Central", to: "the airport" });
    expect(() => assistantPart("directions to Mong Kok")).toThrow("Where are you starting from");
    expect(weatherPlace("is it raining in London?")).toBe("London");
    expect(weatherPlace("what's the weather")).toBe("");
    expect(assistantPart("what's the weather in Hong Kong today")!.surface).toMatchObject({ kind: "browser", url: expect.stringContaining("https://wttr.in/Hong%20Kong?format=") });
  });
  test("site searches open the results page directly", () => {
    expect(siteSearchUrl("play lofi beats on youtube", "lofi beats")).toBe("https://www.youtube.com/results?search_query=lofi%20beats");
    expect(siteSearchUrl("search the web for lofi", "lofi")).toBeUndefined();
  });
  test("planWithJev uses the rules whatever jev called it, and site search for web tasks", async () => {
    const jev = (type: TaskType) => ({ classify: async (): Promise<Classification> => ({ type, typeConf: 0.9, appConf: 0, fileOpConf: 0, inputTokens: 200, ms: 1 }) }) as any;
    const f = await planWithJev("book a flight from Hong Kong to Tokyo on 20 November", jev("web_task"), [], { home: "C:\\Users\\t" });
    expect((f.plan.subtasks[0].surface as any).url).toContain("travel/flights?q=Flights%20from%20Hong%20Kong");
    const y = await planWithJev("play lofi beats on YouTube", jev("web_task"), [], { home: "C:\\Users\\t" });
    expect((y.plan.subtasks[0].surface as any).url).toBe("https://www.youtube.com/results?search_query=lofi%20beats");
    const q = await planWithJev("directions to Mong Kok", jev("web_question"), [], { home: "C:\\Users\\t" });
    expect(q.plan.question).toContain("Where are you starting from");
    const two = await planWithJev("check the weather in Tokyo then write it in Notepad", { classify: async (p: string) => ({ type: /notepad/i.test(p) ? "write_text" : "web_question", typeConf: 0.9, appConf: 0, fileOpConf: 0, inputTokens: 1, ms: 1 }) } as any, ["Notepad"], { home: "C:\\Users\\t" });
    expect(two.plan.subtasks.map(s => s.surface.kind)).toEqual(["browser", "app"]);
    expect(two.plan.subtasks[1].usePreviousAnswer).toBe(true);
  });
});

describe("cookie walls", () => {
  const { consentReject } = require("../src/agent");
  const { clickNeedsApproval } = require("../src/safety");
  const item = (i: number, role: string, text: string) => ({ i, id: `${role}:${text}`, role, text, token: `t${i}` });
  const obs = (title: string, text: string[] = []) => ({ hand: "Mint-3", t: "", window: {} as any, title, elements: [], text, truncated: false, ms: 0 });
  test("'Reject all' is chosen in code, in English or the language the site picked", () => {
    const items = [item(0, "link", "Sign in"), item(1, "button", "Reject all"), item(2, "button", "Accept all")];
    expect(consentReject(obs("Before you continue to Google Maps"), items)?.text).toBe("Reject all");
    expect(consentReject(obs("Google Maps", ["Før du fortsetter til Google"]), [item(0, "button", "Godta alle"), item(1, "button", "Avvis alle")])?.text).toBe("Avvis alle");
    expect(consentReject(obs("Hong Kong to Tokyo | Google Flights"), items)).toBeUndefined();   // not a consent page
    const yt = [item(0, "button", "Accept the use of cookies and other data for the purposes described"), item(1, "button", "Reject the use of cookies and other data for the purposes described")];
    expect(consentReject(obs("lofi hip hop radio - YouTube"), yt)?.i).toBe(1);
  });
  test("accepting cookies needs approval in any language", () => {
    expect(clickNeedsApproval(item(0, "button", "Godta alle"))).toContain("accepts cookies");
    expect(clickNeedsApproval(item(0, "button", "Accept all"))).toContain("cannot be undone");
    expect(clickNeedsApproval(item(0, "button", "Avvis alle"))).toBeNull();
  });
});

test("Google pages: English, plus the user's region and currency when set", () => {
  const { googleParams } = require("../src/planner");
  expect(googleParams({})).toBe("hl=en");
  expect(googleParams({ REGION: "HK", CURRENCY: "hkd" }, { currency: true })).toBe("hl=en&gl=hk&curr=HKD");
  expect(googleParams({ REGION: "Hong Kong" })).toBe("hl=en");     // not a two-letter code: ignored
});

test("percentages become a multiplication Calculator can do", () => {
  const { calculation } = require("../src/planner");
  const c = calculation("what is 15% of 80");
  expect(c.expected).toBe(12);
  expect(c.buttons).toEqual(["Clear", "Eight", "Zero", "Multiply by", "Zero", "Decimal separator", "One", "Five", "Equals"]);
  expect(calculation("calculate 7.5 percent of 1,200").expected).toBe(90);
});

test("first matching result, in page order", () => {
  const { firstMatch } = require("../src/agent");
  const it = (i: number, role: string, text: string) => ({ i, id: `${role}:${text}`, role, text, token: `t${i}` });
  const items = [it(0, "link", "Home"), it(1, "button", "lofi hip hop radio filter"), it(2, "link", "Shorts"), it(3, "link", "lofi hip hop radio 📚 beats to relax/study to"), it(4, "link", "lofi hip hop radio 💤 beats to sleep to")];
  expect(firstMatch(items, "lofi hip hop radio")?.i).toBe(3);
  expect(firstMatch(items, "jazz piano")).toBeUndefined();
});

test("how-to questions use the screen (with Claude); travel and weather stay tasks", () => {
  const { isTeachQuestion } = require("../src/pointer");
  for (const q of ["How do I make a pivot table?", "teach me how to add a border", "what does the format painter do", "how can I undo that"]) expect(isTeachQuestion(q)).toBe(true);
  for (const q of ["how do I get to the airport from Central", "how do I find flights to Tokyo", "what's the weather", "open Notepad"]) expect(isTeachQuestion(q)).toBe(false);
});

test("personal details are typed only from the user's own words", () => {
  const { personalDetailsMissing } = require("../src/safety");
  const f = (text: string) => ({ i: 0, id: "", role: "text field", text, token: "t" });
  expect(personalDetailsMissing(f("First name"), "John", "book a flight to Tokyo")).toContain("personal details");
  expect(personalDetailsMissing(f("Email address"), "sam@example.com", "sign me up with sam@example.com")).toBeNull();
  expect(personalDetailsMissing(f("Where from?"), "Hong Kong", "flights from Hong Kong")).toBeNull();
});

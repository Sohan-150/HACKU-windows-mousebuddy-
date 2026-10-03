// Parts and tasks at the same time (the browser beside a desktop app), a failed part that does not stop the others,
// one more try before giving up on the web, apps that are busy updating, Spotify, and folder contents.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busyLine, codeCheck, newTask, runTask, spotifyPlaying, type ClaudeLike, type JevLike } from "../src/agent";
import { Claude } from "../src/claude";
import type { Decision, HandName, Kind, Observation, Plan, Subtask, WindowRef } from "../src/contracts";
import { SimDriver } from "../src/driver/sim";
import { contents, planFiles } from "../src/files";
import type { StepState } from "../src/jev";
import { Locks, Stopped } from "../src/lanes";
import { MemoryLogger } from "../src/logger";
import { onBubbleClosed, readEvents } from "../src/overlay";
import { perceive } from "../src/perceive";
import { findOp, splitParts } from "../src/planner";
import { App } from "../src/server";

process.env.SPEAK = "off";
process.env.HIGHLIGHT = "off";
process.env.BUBBLE = "off";

const decision = (kind: Kind, item?: number, extra: Partial<Decision> = {}): Decision =>
  ({ kind, item, conf: { kind: 0.9, item: 0.9, value: 0.9 }, gate: 0.9, backend: "jev", model: "fake", inputTokens: 1, outputTokens: 0, ms: 1, ...extra });

const webPart: Subtask = { surface: { kind: "browser", url: "https://search.test/" }, goal: "The founding year of HKU is visible on screen.", values: [{ name: "query", text: "hku" }] };
const notepadPart = (text = "eggs"): Subtask => ({ surface: { kind: "app", app: "Notepad" }, goal: "The text is written.", values: [{ name: "text", text }], check: { kind: "field_equals", role: "text area", expected: text } });

/** jev that browses the sim site and writes in the sim Notepad. */
const jev: JevLike = {
  async decide(s: StepState) {
    const idx = (re: RegExp) => s.items.find(i => re.test(i.text))?.i;
    if (s.surface === "app") return decision("type", s.items.find(i => i.role === "text area")!.i, { valueName: "text", text: s.sub.values[0].text });
    if (s.url === "https://search.test/") {
      const field = s.items.find(i => i.role === "text field")!;
      return field.value ? decision("press_enter", field.i) : decision("type", field.i, { valueName: "query", text: "hku" });
    }
    if (s.url?.startsWith("https://search.test/?q=")) return decision("click", idx(/Wikipedia/));
    if (s.screenText.some(t => /founded/.test(t))) return decision("done");
    return decision("scroll_down");
  },
};

function claudeFor(plan: (instruction: string) => Plan, over: Partial<ClaudeLike> = {}): ClaudeLike & { decided: string[] } {
  const decided: string[] = [];
  return {
    decided, usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    async plan(instruction: string) { return { plan: plan(instruction), ms: 1 }; },
    async decide(_s, why) { decided.push(why); return { ...decision("stuck"), backend: "claude", reason: "No results returned for those dates" }; },
    async write() { return { text: "x", ms: 1 }; },
    async url() { return { url: "https://search.test/", ms: 1 }; },
    async verify(s) {
      const hit = s.screenText.find(t => /1911/.test(t));
      return hit ? { complete: true, answer: "HKU was founded in 1911.", evidence: hit, ms: 1 } : { complete: false, answer: "", evidence: "no founding year", ms: 1 };
    },
    ...over,
  };
}

/** The sim, with each look taking a moment and a count of how many looks were in flight at once. */
class SlowSim extends SimDriver {
  inFlight = 0; maxInFlight = 0; hands = new Set<HandName>();
  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    this.hands.add(hand);
    this.inFlight++; this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await Bun.sleep(15);
    try { return await super.observe(hand, w); } finally { this.inFlight--; }
  }
}

const deps = (over: Record<string, unknown>) => ({ log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true, ...over }) as any;

describe("locks", () => {
  test("the first free of several (two browser windows), and the next one in line gets the one let go", async () => {
    const locks = new Locks(), signal = new AbortController().signal;
    const a = await locks.acquireAny(["hand:Mint-3", "hand:Gold-5"], "A", signal);
    const b = await locks.acquireAny(["hand:Mint-3", "hand:Gold-5"], "B", signal);
    expect([a.name, b.name]).toEqual(["hand:Mint-3", "hand:Gold-5"]);
    let waitedFor = "";
    const c = locks.acquireAny(["hand:Mint-3", "hand:Gold-5"], "C", signal, h => (waitedFor = h));
    expect(waitedFor).toBe("A");
    b.release();
    expect((await c).name).toBe("hand:Gold-5");
    expect(locks.holder("hand:Gold-5")).toBe("C");
  });

  test("one holder at a time, in the order asked, handed straight to the next", async () => {
    const locks = new Locks(), order: string[] = [], waited: string[] = [];
    const signal = new AbortController().signal;
    const a = await locks.acquire("browser", "A", signal);
    const pb = locks.acquire("browser", "B", signal, h => waited.push(`B waits for ${h}`)).then(r => { order.push("B"); return r; });
    const pc = locks.acquire("browser", "C", signal, h => waited.push(`C waits for ${h}`)).then(r => { order.push("C"); return r; });
    const app = await locks.acquire("app", "D", signal);                 // something else: no waiting
    expect(locks.holder("app")).toBe("D");
    expect(locks.waiting("browser")).toEqual(["B", "C"]);
    a(); a();                                                            // releasing twice is harmless
    expect(locks.holder("browser")).toBe("B");
    (await pb)();
    (await pc)();
    app();
    expect(order).toEqual(["B", "C"]);
    expect(waited).toEqual(["B waits for A", "C waits for A"]);
    expect(locks.holder("browser")).toBeUndefined();
  });

  test("a stop while waiting leaves the queue", async () => {
    const locks = new Locks(), stop = new AbortController();
    const held = await locks.acquire("word", "A", new AbortController().signal);
    const p = locks.acquire("word", "B", stop.signal);
    stop.abort();
    await expect(p).rejects.toBeInstanceOf(Stopped);
    expect(locks.waiting("word")).toEqual([]);
    held();
    expect(locks.holder("word")).toBeUndefined();
  });
});

describe("parts of one task", () => {
  test("the browser and a desktop app work at the same time, each with its own hand", async () => {
    const driver = new SlowSim();
    const plan: Plan = { by: "claude", question: "", subtasks: [webPart, notepadPart()] };
    const t = await runTask(newTask("find when HKU was founded and at the same time write eggs in Notepad", "typed"), deps({ driver, jev, claude: claudeFor(() => plan) }));
    expect(t.status).toBe("done");
    expect(t.result?.answer).toBe('HKU was founded in 1911. Wrote "eggs" in Untitled - Notepad.');
    expect(driver.maxInFlight).toBe(2);
    expect([...driver.hands].sort()).toEqual(["Mint-3", "Red-7"]);
  });

  test("a part that uses an earlier part's answer waits for it", async () => {
    const driver = new SlowSim();
    const plan: Plan = { by: "claude", question: "", subtasks: [webPart, { ...notepadPart("{previous answer}"), usePreviousAnswer: true }] };
    const t = await runTask(newTask("find when HKU was founded then write it in Notepad", "typed"), deps({ driver, jev, claude: claudeFor(() => plan) }));
    expect(t.status).toBe("done");
    expect(driver.maxInFlight).toBe(1);
    expect(driver.doc).toBe("HKU was founded in 1911.");
  });

  test("a part that fails does not stop the others; the answer says what happened to each", async () => {
    const plan: Plan = { by: "claude", question: "", subtasks: [
      { surface: { kind: "browser", url: "https://flights.test/" }, goal: "Flights to Gaborone are listed.", values: [] },
      notepadPart(),
      { ...notepadPart("later"), needsPrevious: true },
    ] };
    const claude = claudeFor(() => plan);
    const unsure: JevLike = { async decide(s) { return s.surface === "app" ? jev.decide(s) : { ...decision("click", 0), gate: 0.1 }; } };
    const t = await runTask(newTask("find flights to Botswana, at the same time write eggs in Notepad, then write later", "typed"), deps({ driver: new SimDriver(), jev: unsure, claude }));
    expect(t.status).toBe("partial");
    const lines = t.result!.answer.split("\n");
    expect(lines[0]).toBe("Part 1 (Flights to Gaborone are listed.) didn't work: No results returned for those dates");
    expect(lines[1]).toBe('Wrote "eggs" in Untitled - Notepad.');
    expect(lines[2]).toContain("skipped: it needs what part 1 was to find");
    expect(t.exception?.code).toBe("needs_info");
    // On the web Claude was asked once more, to try another way, before the part gave up.
    expect(claude.decided).toHaveLength(2);
    expect(claude.decided[1]).toContain("Try another way once before stopping");
  });

  test("one part that fails is the task failing, as before", async () => {
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Paint" }, goal: "Paint is open.", values: [] }] };
    const t = await runTask(newTask("open Paint", "typed"), deps({ driver: new SimDriver(), jev, claude: claudeFor(() => plan) }));
    expect(t.status).toBe("failed");
    expect(t.exception?.code).toBe("window_lost");
  });
});

describe("several desktop apps", () => {
  const spotifyPart: Subtask = { surface: { kind: "app", app: "Spotify" }, goal: "Drake is playing.", values: [{ name: "text", text: "drake" }], check: { kind: "field_equals", role: "text area", expected: "drake" } };

  test("two apps at the same time, each with its own hand; each part's progress line says how it ended", async () => {
    const driver = new SlowSim(), statuses: string[] = [];
    const plan: Plan = { by: "claude", question: "", subtasks: [notepadPart(), spotifyPart] };
    const t = await runTask(newTask("launch Fortnite at the same time play Drake on Spotify", "typed"), deps({ driver, jev, claude: claudeFor(() => plan), onStatus: (s: string) => statuses.push(s) }));
    expect(t.status).toBe("done");
    expect(driver.maxInFlight).toBe(2);
    expect([...driver.hands].sort()).toEqual(["Red-7", "Violet-1"]);
    expect(driver.doc).toBe("eggs");
    expect(driver.docs.Spotify).toBe("drake");
    expect(statuses).toContain('part 1 (Notepad): ✓ Wrote "eggs" in Untitled - Notepad.');
    expect(statuses).toContain('part 2 (Spotify): ✓ Wrote "drake" in Untitled - Spotify.');
    expect(statuses.some(s => s.startsWith("part 2 (Spotify): opening the app Spotify"))).toBe(true);
  });

  test("two parts in the same app take turns", async () => {
    const driver = new SlowSim(), statuses: string[] = [];
    const plan: Plan = { by: "claude", question: "", subtasks: [notepadPart("one"), notepadPart("two")] };
    const t = await runTask(newTask("write one in Notepad and also write two in Notepad", "typed"), deps({ driver, jev, claude: claudeFor(() => plan), onStatus: (s: string) => statuses.push(s) }));
    expect(t.status).toBe("done");
    expect(driver.maxInFlight).toBe(1);
    expect(statuses).toContain('part 2 (Notepad): waiting for notepad (in use by "write one in Notepad and also write two in Notepad")');
  });
});

describe("desktop apps", () => {
  /** The sim's app window, as an app that is updating something. */
  class Updating extends SimDriver {
    async observe(hand: HandName, w: WindowRef) {
      const o = await super.observe(hand, w);
      return w.kind === "app" ? { ...o, title: "Epic Games Launcher", text: ["Library", "Fortnite", "Updating 37%"] } : o;
    }
  }

  test("an app that keeps updating: after three waits the part stops and says what it is doing", async () => {
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad" }, goal: "Fortnite is running.", values: [] }] };
    const statuses: string[] = [];
    const waiting = claudeFor(() => plan, { async decide(_s, why) { return { ...decision("wait"), backend: "claude", why, reason: "the launcher is updating Fortnite" }; } });
    const t = await runTask(newTask("run Fortnite", "typed"), deps({ driver: new Updating(), jev: null, claude: waiting, onStatus: (s: string) => statuses.push(s) }));
    expect(t.status).toBe("failed");
    expect(t.exception).toEqual({ code: "needs_info", reason: 'Epic Games Launcher is still busy ("Updating 37%"). I\'ve stopped waiting so you can do other things; ask me again when it has finished.' });
    expect(statuses).toContain("step 1: waiting (the launcher is updating Fortnite)");
    expect(busyLine({ text: ["Play"], elements: [{ index: 0, role: "other", label: "Download progress", value: "52%" }] } as any)).toBe("Download progress 52%");
  });

  test("a search box reported as a combo box takes typing", async () => {
    class ComboSearch extends SimDriver {
      async observe(hand: HandName, w: WindowRef) {
        const o = await super.observe(hand, w);
        return { ...o, elements: o.elements.map(e => e.role === "text area" ? { ...e, role: "pop-up" as const, label: "What do you want to play?" } : e) };
      }
    }
    const driver = new ComboSearch();
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad" }, goal: "Search results for drake are shown.", values: [{ name: "search", text: "drake" }] }] };
    let n = 0;
    const typer: JevLike = { async decide(s) { return ++n === 1 ? decision("type", s.items.find(i => i.role === "pop-up")!.i, { valueName: "search", text: "drake" }) : decision("done"); } };
    const claude = claudeFor(() => plan, { async verify() { return { complete: true, answer: "Results shown.", evidence: "search holds drake", ms: 1 }; } });
    const t = await runTask(newTask("search drake in Spotify", "typed"), deps({ driver, jev: typer, claude }));
    expect(t.status).toBe("done");
    expect(driver.log).toContainEqual({ tool: "type", token: expect.any(String), text: "drake" });
  });

  test("Spotify: the window title says what is playing; something already playing before does not count", () => {
    const spotify = (title: string, pause = false): Observation => ({ hand: "Red-7", t: "", title, truncated: false, ms: 0, text: [],
      window: { kind: "app", pid: 1, windowId: 2, app: "Spotify", title },
      elements: pause ? [{ index: 0, role: "button", label: "Pause", token: "t" }] : [] });
    expect(spotifyPlaying(spotify("Drake - God's Plan"))).toBe(true);
    expect(spotifyPlaying(spotify("Spotify Premium"))).toBe(false);
    const playing = { kind: "playing" as const };
    expect(codeCheck(playing, spotify("Drake - God's Plan"), [], { title: "Spotify Premium", playing: false, query: "drake" })).toMatchObject({ complete: true, evidence: `Spotify's window title shows "Drake - God's Plan"` });
    // The song from before the task is still on: not done until what was asked starts.
    expect(codeCheck(playing, spotify("Adele - Hello", true), [], { title: "Adele - Hello", playing: true, query: "drake" })!.complete).toBe(false);
    expect(codeCheck(playing, spotify("Drake - Hotline Bling", true), [], { title: "Adele - Hello", playing: true, query: "drake" })!.complete).toBe(true);
  });

  test("an app's hidden web address bar is never offered, whatever it is called", () => {
    const o: Observation = { hand: "Red-7", t: "", title: "Spotify Premium", truncated: false, ms: 0, text: [], window: { kind: "app", pid: 1, windowId: 2, app: "Spotify", title: "" },
      elements: [
        { index: 0, token: "a", role: "text field", label: "Spotify – Search", value: "https://xpui.app.spotify.com/index.html" },
        { index: 1, token: "b", role: "pop-up", label: "What do you want to play?", value: "" },
        { index: 2, token: "c", role: "text field", label: "Playlist name", value: "Road trip" },
      ] };
    expect(perceive(o, "play drake").items.map(i => i.text)).toEqual(["What do you want to play?", "Playlist name"]);
  });
});

describe("loading and unreadable windows", () => {
  test("a player page still filling in is waited for without asking a model", async () => {
    let looks = 0, asked = 0;
    // YouTube: the header first, the results a moment later.
    class Filling extends SimDriver {
      async observe(hand: HandName, w: WindowRef) {
        const o = await super.observe(hand, w);
        return ++looks <= 3 ? { ...o, elements: o.elements.slice(0, 1), text: ["Skip navigation"] } : o;
      }
    }
    const plan: Plan = { by: "claude", question: "", subtasks: [{ ...webPart, check: { kind: "playing" } }] };
    const counting: JevLike = { async decide(s) { asked++; return jev.decide(s); } };
    await runTask(newTask("play a video about HKU", "typed"), deps({ driver: new Filling(), jev: counting, claude: claudeFor(() => plan), maxSteps: 2 }));
    expect(looks).toBeGreaterThan(3);
    expect(asked).toBeLessThanOrEqual(2);                        // only once the page had filled in
  });

  test("an app that shows nothing to accessibility tools is reported instead of waited on", async () => {
    class Blind extends SimDriver {
      async observe(hand: HandName, w: WindowRef) { const o = await super.observe(hand, w); return w.kind === "app" ? { ...o, title: "Epic Games Launcher", elements: [], text: [] } : o; }
    }
    const plan: Plan = { by: "claude", question: "", subtasks: [{ surface: { kind: "app", app: "Notepad", uri: "com.epicgames.launcher://apps/Fortnite?action=launch&silent=true" }, goal: "Fortnite is starting.", values: [] }] };
    const t = await runTask(newTask("launch Fortnite", "typed"), deps({ driver: new Blind(), jev, claude: claudeFor(() => plan) }));
    expect(t.exception).toEqual({ code: "needs_info", reason: "Epic Games Launcher doesn't show its buttons or text to accessibility tools, so I can't see or use it. I opened it with its own link (com.epicgames.launcher://apps/Fortnite?action=launch&silent=true), so it may already be doing what you asked." });
  }, 15_000);

  test("game launcher links are kept in plans; other links are not", async () => {
    const part = (uri: string) => ({ surface: "app", url: "", app: "Epic Games Launcher", uri, goal: "Fortnite is starting", values: [], needs_previous: false, reply: "", doc_title: "", doc_text: "", file_op: "", folder: "", dest: "", exts: [], file_name: "", to_format: "" });
    const reply = { question: "", about_screen: false, subtasks: [part("com.epicgames.launcher://apps/Fortnite?action=launch&silent=true"), part("steam://rungameid/730"), part("javascript:alert(1)")] };
    const fetch = (async () => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_details: null,
      content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as any;
    const r = await new Claude({ apiKey: "k", fetch }).plan("launch Fortnite", { today: "2026-10-03", platform: "Windows", apps: ["Epic Games Launcher"] });
    expect(r.plan.subtasks.map(s => (s.surface as any).uri)).toEqual(["com.epicgames.launcher://apps/Fortnite?action=launch&silent=true", "steam://rungameid/730", undefined]);
  });
});

describe("tasks at the same time", () => {
  test("two web tasks (two browser windows) and an app task run side by side; a third web task waits its turn and says so", async () => {
    const driver = new SlowSim();
    const plans: Record<string, Plan> = {
      web: { by: "claude", question: "", subtasks: [webPart] },
      notes: { by: "claude", question: "", subtasks: [notepadPart()] },
      web2: { by: "claude", question: "", subtasks: [webPart] },
      web3: { by: "claude", question: "", subtasks: [webPart] },
    };
    const app = new App(driver, claudeFor(i => plans[i]), jev);
    const progress: string[] = [];
    const seen = new Set<number>();
    app["emit"] = (e: any) => { if (e.type === "state") { seen.add(e.state.running.length); for (const p of Object.values(e.state.progress) as string[]) progress.push(p); } };
    for (const name of ["web", "notes", "web2", "web3"]) app.add(name, "typed");
    for (let i = 0; i < 400 && app.busy; i++) await Bun.sleep(10);
    expect(app.tasks.map(t => [t.instruction, t.status])).toEqual([["web", "done"], ["notes", "done"], ["web2", "done"], ["web3", "done"]]);
    expect(seen.has(4)).toBe(true);
    expect(progress).toContain(`waiting for a browser window (in use by "web")`);
    expect(driver.maxInFlight).toBe(3);
    expect([...driver.hands].sort()).toEqual(["Gold-5", "Mint-3", "Red-7"]);
  });

  test("stopping one task leaves the others running", async () => {
    const plans: Record<string, Plan> = { a: { by: "claude", question: "", subtasks: [webPart] }, b: { by: "claude", question: "", subtasks: [notepadPart()] } };
    const app = new App(new SlowSim(), claudeFor(i => plans[i]), jev);
    const a = app.add("a", "typed"), b = app.add("b", "typed");
    app.stop(a.id);
    for (let i = 0; i < 300 && app.busy; i++) await Bun.sleep(10);
    expect(app.tasks.find(t => t.id === a.id)!.status).toBe("stopped");
    expect(app.tasks.find(t => t.id === b.id)!.status).toBe("done");
  });
});

describe("planning", () => {
  test("new sentences, 'at the same time' and 'and also' split; lists stay whole", () => {
    expect(splitParts("Can you open my CCHU9053 folder? At the same time, open my coding folder and tell me what is inside.")).toEqual(["Can you open my CCHU9053 folder", "open my coding folder and tell me what is inside"]);
    expect(splitParts("find flights to Botswana and then at the same time play Drake on Spotify")).toEqual(["find flights to Botswana", "play Drake on Spotify"]);
    expect(splitParts("check the weather and also open Notepad")).toEqual(["check the weather", "open Notepad"]);
    expect(splitParts("Write eggs, milk and bread in Notepad")).toEqual(["Write eggs, milk and bread in Notepad"]);
  });

  test("Claude says which parts need the ones before them", async () => {
    const reply = { question: "", about_screen: false, subtasks: [
      { surface: "browser", url: "https://wttr.in/Tokyo", app: "", uri: "", goal: "weather visible", values: [], needs_previous: false, reply: "", doc_title: "", doc_text: "", file_op: "", folder: "", dest: "", exts: [], file_name: "", to_format: "" },
      { surface: "app", url: "", app: "Notepad", uri: "", goal: "weather written", values: [], needs_previous: true, reply: "", doc_title: "", doc_text: "", file_op: "", folder: "", dest: "", exts: [], file_name: "", to_format: "" },
    ] };
    const fetch = (async () => new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: "end_turn", stop_details: null,
      content: [{ type: "text", text: JSON.stringify(reply) }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })) as any;
    const r = await new Claude({ apiKey: "k", fetch }).plan("weather in Tokyo then write it in Notepad", { today: "2026-10-03", platform: "Windows", apps: ["Notepad"] });
    expect(r.plan.subtasks.map(s => !!s.needsPrevious)).toEqual([false, true]);
  });
});

describe("folders", () => {
  test("'open my coding folder and tell me what is inside': found, opened, and its contents said", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-list-"));
    const coding = join(home, "Desktop", "Coding");
    mkdirSync(join(coding, "web"), { recursive: true });
    mkdirSync(join(coding, "python"), { recursive: true });
    writeFileSync(join(coding, "notes.txt"), "x");
    writeFileSync(join(coding, "desktop.ini"), "system");
    mkdirSync(join(home, "Documents", "CCHU 9053"), { recursive: true });
    const op = findOp("open my coding folder and tell me what is inside", home);
    expect(op).toMatchObject({ op: "find", name: "my coding folder", open: true, list: true });
    const plan = planFiles({ ...op, folder: home } as any, home);
    expect(plan.answer).toBe(`Your folder "Coding" is in ${join(home, "Desktop")}. I've opened it in File Explorer. Inside it: 2 folders (python, web) and 1 file (notes.txt).`);
    expect(plan.actions).toEqual([{ kind: "open", path: coding }]);
    // "CCHU9053" finds "CCHU 9053".
    expect(planFiles(findOp("Can you open my CCHU9053 folder", home), home).answer).toStartWith(`Your folder "CCHU 9053" is in ${join(home, "Documents")}.`);
    expect(contents(join(home, "Documents", "CCHU 9053"))).toBe("It's empty.");
  });
});

test("the overlay reports a click on the bubble (Windows line endings, lines split across reads)", async () => {
  let closed = 0;
  onBubbleClosed(() => closed++);
  const enc = new TextEncoder();
  const chunks = ['{"event":"ready"}\r\nbubble-cl', "osed\r\n", "bubble-closed\r\n"];
  await readEvents(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }));
  expect(closed).toBe(2);
});

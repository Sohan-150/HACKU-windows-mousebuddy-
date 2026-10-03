// No Claude: planning (jev classification + rules), file operations, code checks, and jev's done check.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeCheck, newTask, runTask, type JevLike } from "../src/agent";
import type { Decision, Kind } from "../src/contracts";
import { SimDriver } from "../src/driver/sim";
import { planFiles, runFiles, undoMoves } from "../src/files";
import type { Classification, DoneCheck, StepState, TaskType } from "../src/jev";
import { MemoryLogger } from "../src/logger";
import { calculation, fileOp, folders, match, planWithJev, splitParts, textToWrite, webQuery } from "../src/planner";

const HOME = "C:\\Users\\tester";
const cls = (type: TaskType, extra: Partial<Classification> = {}): Classification => ({ type, typeConf: 0.9, appConf: 0, fileOpConf: 0, inputTokens: 300, ms: 1, ...extra });

describe("planner rules", () => {
  test("splits only on sequencing words", () => {
    expect(splitParts("Find when HKU was founded, then write it in Notepad")).toEqual(["Find when HKU was founded", "write it in Notepad"]);
    expect(splitParts("Write eggs, milk and bread in Notepad")).toEqual(["Write eggs, milk and bread in Notepad"]);
  });
  test("calculator buttons and expected result", () => {
    const c = calculation("Calculate 128.5 times 12")!;
    expect(c.buttons).toEqual(["Clear", "One", "Two", "Eight", "Decimal separator", "Five", "Multiply by", "One", "Two", "Equals"]);
    expect(c.expected).toBe(1542);
    expect(calculation("what is 1,200 divided by 8")!.expected).toBe(150);
    expect(calculation("write a list")).toBeNull();
  });
  test("text to write, quoted or after 'write'", () => {
    expect(textToWrite("Open Notepad and write a shopping list: eggs, milk, bread").text).toBe("Shopping list: eggs, milk, bread");
    expect(textToWrite('type "hello there" in Notepad').text).toBe("hello there");
    expect(textToWrite("write it in Notepad").fromPrevious).toBe(true);
  });
  test("web query drops the imperative", () => {
    expect(webQuery("Find out when the University of Hong Kong was founded")).toBe("when the University of Hong Kong was founded");
  });
  test("folders, sub-paths and file types", () => {
    expect(folders("organise my Downloads folder", HOME)).toEqual([join(HOME, "Downloads")]);
    expect(folders("move PDFs from Desktop\\scans to Documents", HOME)).toEqual([join(HOME, "Desktop", "scans"), join(HOME, "Documents")]);
    expect(match("convert all PNG files to jpg").exts?.sort()).toEqual(["jpg", "png"]);
    expect(match("convert report.txt to pdf").name).toBe("report.txt");
  });
  test("file operations from words", () => {
    expect(fileOp("organize", "tidy up my Downloads", HOME)).toEqual({ op: "organize", folder: join(HOME, "Downloads") });
    expect(fileOp("move", "move the PDFs in Downloads to Documents", HOME)).toEqual({ op: "move", folder: join(HOME, "Downloads"), match: { exts: ["pdf"], name: undefined }, dest: join(HOME, "Documents") });
    expect(fileOp("convert", "convert all PNG images on my Desktop to jpg", HOME)).toMatchObject({ op: "convert", folder: join(HOME, "Desktop"), to: "jpg" });
    expect(() => fileOp("move", "move my files", HOME)).toThrow("where the files are");
  });
  test("planWithJev: jev classifies, rules extract; unclear becomes a question", async () => {
    const jev = { classify: async (part: string) => /notepad/i.test(part) ? cls("write_text", { app: "Notepad", appConf: 0.9 }) : /founded/.test(part) ? cls("web_question") : cls("unclear", { typeConf: 0.9 }), checkDone: async () => ({}) as DoneCheck };
    const r = await planWithJev("Find when HKU was founded, then write it in Notepad", jev as any, ["Notepad", "Calculator"], HOME);
    expect(r.plan.subtasks.map(s => s.surface.kind)).toEqual(["browser", "app"]);
    expect(r.plan.subtasks[0].question).toBe(true);
    expect(r.plan.subtasks[1].usePreviousAnswer).toBe(true);
    const q = await planWithJev("do the thing", jev as any, [], HOME);
    expect(q.plan.question).toContain("not sure");
  });
  test("refuses folders outside the user's home", async () => {
    const jev = { classify: async () => cls("files", { fileOp: "organize", fileOpConf: 0.9 }) };
    const r = await planWithJev("organise C:\\Windows\\System32", jev as any, [], HOME);
    expect(r.plan.question).toContain("only work inside");
  });
});

describe("files on disk (a throwaway home folder)", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-home-"));
  const dl = join(home, "Downloads");
  mkdirSync(dl, { recursive: true });
  // a real 1x1 PNG
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201f7d6f6fb0000000049454e44ae426082", "hex");
  writeFileSync(join(dl, "photo.png"), PNG);
  writeFileSync(join(dl, "notes.txt"), "hello\nworld");
  writeFileSync(join(dl, "data.csv"), "name,qty\neggs,12\nmilk,1\n");
  writeFileSync(join(dl, "report.pdf"), "%PDF-1.4 fake");
  writeFileSync(join(dl, "desktop.ini"), "system file");

  test("convert: PNG -> JPG with Windows imaging, CSV -> JSON in code, originals kept", async () => {
    const plan = planFiles({ op: "convert", folder: dl, match: { exts: ["png", "csv"] }, to: "jpg" }, home);
    expect(plan.summary).toContain("can't convert data.csv");
    const res = await runFiles(plan.actions);
    expect(res.every(r => r.ok)).toBe(true);
    expect(readFileSync(join(dl, "photo.jpg")).subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(existsSync(join(dl, "photo.png"))).toBe(true);
    const j = await runFiles(planFiles({ op: "convert", folder: dl, match: { exts: ["csv"] }, to: "json" }, home).actions);
    expect(j[0].ok).toBe(true);
    expect(JSON.parse(readFileSync(join(dl, "data.json"), "utf8"))).toEqual([{ name: "eggs", qty: "12" }, { name: "milk", qty: "1" }]);
  }, 60_000);

  test("convert: text -> PDF by printing with the installed browser", async () => {
    const res = await runFiles(planFiles({ op: "convert", folder: dl, match: { name: "notes.txt" }, to: "pdf" }, home).actions);
    expect(res[0].ok).toBe(true);
    expect(readFileSync(join(dl, "notes.pdf")).subarray(0, 4).toString()).toBe("%PDF");
  }, 90_000);

  test("organise: sorted into type folders, system files left alone, nothing overwritten, undo moves back", async () => {
    writeFileSync(join(dl, "a.txt"), "first");
    mkdirSync(join(dl, "Documents"), { recursive: true });
    writeFileSync(join(dl, "Documents", "a.txt"), "already there");
    const plan = planFiles({ op: "organize", folder: dl }, home);
    expect(plan.needsApproval).toBe(true);
    const res = await runFiles(plan.actions);
    expect(res.every(r => r.ok)).toBe(true);
    expect(readdirSync(join(dl, "Images")).sort()).toEqual(["photo.jpg", "photo.png"]);
    expect(readFileSync(join(dl, "Documents", "a.txt"), "utf8")).toBe("already there");
    expect(readFileSync(join(dl, "Documents", "a (1).txt"), "utf8")).toBe("first");
    expect(existsSync(join(dl, "desktop.ini"))).toBe(true);
    const back = undoMoves(plan.actions);
    expect(back.every(r => r.ok)).toBe(true);
    expect(existsSync(join(dl, "a.txt"))).toBe(true);
    expect(existsSync(join(dl, "Images"))).toBe(false);                   // created by the move, empty again: removed
    expect(readFileSync(join(dl, "Documents", "a.txt"), "utf8")).toBe("already there");   // was there before: kept
  });

  test("list answers without touching anything; outside home is refused", () => {
    const p = planFiles({ op: "list", folder: dl, match: { exts: ["pdf"] } }, home);
    expect(p.actions).toEqual([]);
    expect(p.answer).toMatch(/^\d+ PDF files in /);
    expect(() => planFiles({ op: "organize", folder: "C:\\Windows" }, home)).toThrow("only work inside");
  });
});

describe("checks in code", () => {
  const obs = (text: string[]) => ({ hand: "Mint-3", t: "", window: { kind: "app", pid: 1, windowId: 1, app: "Calculator", title: "Calculator" }, title: "Calculator", elements: [], text, truncated: false, ms: 0 }) as any;
  test("Calculator display (with thousands separators)", () => {
    expect(codeCheck({ kind: "display_equals", label: /^Display is /, expected: 1542 }, obs(["Display is 1,542"]), [])!.complete).toBe(true);
    expect(codeCheck({ kind: "display_equals", label: /^Display is /, expected: 1542 }, obs(["Display is 1,541"]), [])!.complete).toBe(false);
  });
  test("text read back from the editor", () => {
    const items = [{ i: 0, id: "text area:text editor", role: "text area" as const, text: "Text editor", value: "eggs\r\nmilk", token: "t" }];
    expect(codeCheck({ kind: "field_equals", role: "text area", expected: "eggs\nmilk" }, obs([]), items)!.complete).toBe(true);
  });
});

describe("runTask with jev only", () => {
  const dec = (kind: Kind, item?: number, extra: Partial<Decision> = {}): Decision =>
    ({ kind, item, conf: { kind: 0.9, item: 0.9, value: 0.9 }, gate: 0.9, backend: "jev", model: "fake", inputTokens: 400, outputTokens: 0, ms: 1, ...extra });

  test("web question answered from the screen line jev picks", async () => {
    const jev: JevLike = {
      extra: {
        classify: async () => cls("web_question"),
        checkDone: async (s: StepState) => ({ done: 0.9, answer: s.screenText.find(t => /1911/.test(t)), answerConf: 0.8, inputTokens: 300, ms: 1 }),
      },
      async decide(s: StepState) {
        if (s.url?.includes("duckduckgo")) return dec("go_to_url");    // not offered without Claude: rejected below
        return dec("done");
      },
    };
    // The sim site stands in for the web: point the planner's search URL at it.
    const d = new SimDriver();
    const open = d.open.bind(d);
    d.open = async (h, s) => open(h, s.kind === "browser" ? { kind: "browser", url: "https://wiki.test/HKU" } : s);
    d.act = d.act.bind(d);
    const scrolled = async (h: any, w: any) => { d.scrolled = true; return SimDriver.prototype.observe.call(d, h, w); };
    d.observe = scrolled as any;
    const t = await runTask(newTask("When was HKU founded?", "typed"), { driver: d, jev, claude: null, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
    expect(t.status).toBe("done");
    expect(t.result?.answer).toBe("It was founded in 1911.");
    expect(t.counts.claude).toBe(0);
  });

  test("unsure jev is re-asked with its top controls; still unsure after letting the page settle twice -> stops instead of guessing", async () => {
    let calls = 0;
    const jev: JevLike = {
      extra: { classify: async () => cls("web_question"), checkDone: async () => ({ done: 0, answerConf: 0, inputTokens: 0, ms: 0 }) },
      async decide(_s: StepState, only?: number[]) { calls++; return dec("click", only ? only[0] : 0, { gate: 0.2, conf: { kind: 0.5, item: 0.2 }, probs: { item: { "0": 0.3, "1": 0.25 } } }); },
    };
    const t = await runTask(newTask("When was HKU founded?", "typed"), { driver: new SimDriver(), jev, claude: null, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
    expect(calls).toBe(6);                        // 3 looks (first + 2 settle waits) x (ask + narrower re-ask)
    expect(t.exception?.code).toBe("low_confidence");
    expect(t.exception?.reason).toContain("Stopping rather than guessing");
  });
});

describe("reading a whole page instead of scrolling for an answer", () => {
  const dec = (kind: Kind): Decision => ({ kind, conf: { kind: 0.95, item: 0.95, value: 0.95 }, gate: 0.95, backend: "jev", model: "fake", inputTokens: 400, outputTokens: 0, ms: 1 });
  const setup = (page: string[]) => {
    const d = new SimDriver();
    const open = d.open.bind(d);
    d.open = async (h, s) => open(h, s.kind === "browser" ? { kind: "browser", url: "https://wiki.test/HKU" } : s);
    let reads = 0;
    (d as any).readMore = async () => { reads++; return page; };
    const jev: JevLike = {
      extra: {
        classify: async () => cls("web_question"),
        checkDone: async (s: StepState) => { const a = s.screenText.find(t => /harbour is 12 m deep/.test(t)); return { done: a ? 0.9 : 0.1, answer: a, answerConf: a ? 0.9 : 0, inputTokens: 300, ms: 1 }; },
      },
      async decide() { return dec("scroll_down"); },                 // jev would scroll forever
    };
    return { d, jev, reads: () => reads };
  };
  test("the answer further down the page is found in one read, without scrolling", async () => {
    const { d, jev, reads } = setup(["Victoria Harbour", "Geography", "On average the harbour is 12 m deep."]);
    const t = await runTask(newTask("How deep is Victoria Harbour?", "typed"), { driver: d, jev, claude: null, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
    expect(t.status).toBe("done");
    expect(t.result?.answer).toBe("On average the harbour is 12 m deep.");
    expect(t.counts.gui).toBe(0);
    expect(reads()).toBeGreaterThan(0);
  });
  test("not on the page: stops and says so (no scrolling loop)", async () => {
    const { d, jev } = setup(["Victoria Harbour", "The harbour has deep, sheltered waters."]);
    const t = await runTask(newTask("How deep is Victoria Harbour?", "typed"), { driver: d, jev, claude: null, log: new MemoryLogger(), signal: new AbortController().signal, approve: async () => true });
    expect(t.exception?.code).toBe("needs_info");
    expect(t.exception?.reason).toContain("read the whole page");
    expect(t.counts.gui).toBe(0);
  });
});

test("a long text is checked against the window's full value, not the shortened copy the deciders see", () => {
  const long = "Dear Teacher,\n\n" + "Thank you for everything. ".repeat(12) + "\n\nWith appreciation";
  const o = { hand: "Mint-3", t: "", window: {} as any, title: "Notepad", text: [], truncated: false, ms: 0,
    elements: [{ index: 0, token: "t1", role: "text area", label: "Text editor", value: long.replace(/\n/g, "\r") }] } as any;
  const items = [{ i: 0, id: "text area:text editor", role: "text area" as const, text: "Text editor", value: long.slice(0, 200), token: "t1" }];
  expect(codeCheck({ kind: "field_equals", role: "text area", expected: long }, o, items)!.complete).toBe(true);
});

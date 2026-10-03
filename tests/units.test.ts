import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Claude, ModelError } from "../src/claude";
import type { Item, Subtask } from "../src/contracts";
import { replayLine } from "../src/driver/cli";
import { appObservation, browserObservation } from "../src/driver/win";
import { buildRequest, gateOf, Jev, type StepState } from "../src/jev";
import { perceive } from "../src/perceive";
import { clickNeedsApproval, typingForbidden } from "../src/safety";

const fx = (p: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", p), "utf8"));
const W = { kind: "browser" as const, pid: 1, windowId: 1, app: "chrome", title: "" };
const sub: Subtask = { surface: { kind: "browser", url: "x" }, goal: "g", values: [{ name: "query", text: "hku" }] };
const state = (items: Item[], surface = "browser"): StepState => ({ instruction: "i", sub, notes: [], surface, windowTitle: "t", screenText: [], items, previousActions: [], alreadyTriedHere: [] });

describe("observations from real Windows snapshots", () => {
  test("browser (recorded Chrome page): controls in page order, roles mapped", () => {
    const obs = browserObservation(fx("win-browser/01-empty-form.json"), W, "Mint-3", 0);
    const { items } = perceive(obs, "fill the form");
    expect(items.slice(0, 4).map(i => `${i.role}:${i.text}`)).toEqual([
      "text field:Payee name", "text field:Amount (HKD)", "text field:Date of expense (DD/MM/YYYY)", "pop-up:Category",
    ]);
    expect(obs.text).toContain("Society reimbursement claim");
  });
  test("desktop app (recorded Calculator): buttons kept, window chrome dropped, display text read", () => {
    const obs = appObservation(fx("win-app/calculator.json"), { ...W, kind: "app" }, "Mint-3", 0);
    const { items } = perceive(obs, "6 times 7");
    const labels = items.map(i => i.text);
    expect(labels).toContain("Six");
    expect(labels).toContain("Equals");
    expect(labels).not.toContain("Close Calculator");
    expect(labels).not.toContain("Minimize Calculator");
    expect(obs.text.some(t => /^Display is/.test(t))).toBe(true);
  });
  test("long pages are capped with inputs and goal words first, then numbered in page order", () => {
    const els = Array.from({ length: 200 }, (_, i) => ({ index: i, token: `t${i}`, role: "link" as const, label: `link ${i}`, inView: true }));
    els.push({ index: 200, token: "t200", role: "text field" as any, label: "Search", inView: true });
    els.push({ index: 201, token: "t201", role: "link" as const, label: "Founding history", inView: true });
    const { items, dropped } = perceive({ hand: "Mint-3", t: "", window: W, title: "", elements: els, text: [], truncated: false, ms: 0 }, "founding year", 20);
    expect(items).toHaveLength(20);
    expect(dropped).toBe(182);
    expect(items.map(i => i.text)).toContain("Search");
    expect(items.map(i => i.text)).toContain("Founding history");
    expect(items.map(i => i.i)).toEqual([...Array(20).keys()]);
  });
});

describe("jev request", () => {
  const items: Item[] = [{ i: 0, id: "text field:search", role: "text field", text: "Search", token: "a", state: "empty" }];
  test("three choices; values and 'none'; go_to_url only in the browser", () => {
    const r = buildRequest({ ...state(items), canGoToUrl: true });
    expect(Object.keys(r.questions)).toEqual(["kind", "item", "value"]);
    expect(r.questions.kind.criteria).toHaveProperty("go_to_url");
    expect(buildRequest(state(items)).questions.kind.criteria).not.toHaveProperty("go_to_url");   // nothing could supply an address
    expect(r.questions.item.criteria).toEqual({ "0": "text field 'Search' (empty)", none: "no control: the action does not need one" });
    expect(Object.keys(r.questions.value.criteria)).toEqual(["query", "none"]);
    expect(buildRequest(state(items, "app")).questions.kind.criteria).not.toHaveProperty("go_to_url");
  });
  test("gate", () => {
    expect(gateOf("click", { kind: 0.9, item: 0.3 })).toBe(0.3);
    expect(gateOf("scroll_down", { kind: 0.6, item: 0.1 })).toBe(0.6);
  });
  test("Jev maps a TypeSafe answer to a decision, and rejects an answer outside the options", async () => {
    const answer = (item: string) => async () => new Response(JSON.stringify({ model: "jev-1.13.0", usage: { input_tokens: 700, output_tokens: 0 }, answers: {
      kind: { type: "choice", choice: "type", confidence: 0.8, probabilities: { type: 0.85 } },
      item: { type: "choice", choice: item, confidence: 0.9, probabilities: { [item]: 0.9 } },
      value: { type: "choice", choice: "query", confidence: 0.95, probabilities: { query: 0.97 } },
    } }), { status: 200, headers: { "content-type": "application/json" } });
    const d = await new Jev({ apiKey: "k", fetch: answer("0") as any }).decide(state(items));
    expect(d).toMatchObject({ kind: "type", item: 0, valueName: "query", text: "hku", gate: 0.8, backend: "jev", inputTokens: 700 });
    expect(new Jev({ apiKey: "k", fetch: answer("7") as any }).decide(state(items))).rejects.toThrow("not one of the options");
  });
});

describe("Claude calls", () => {
  const reply = (body: object, capture?: (req: any) => void) => (async (_u: any, init: any) => {
    capture?.({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  const msg = (text: string, stop = "end_turn") => ({ id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", stop_reason: stop, stop_details: null,
    content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

  test("verify: JSON output, server-side fallback on, effort set, cost counted", async () => {
    let req: any;
    const c = new Claude({ apiKey: "k", fetch: reply(msg(JSON.stringify({ complete: true, answer: "1911", evidence: "founded in 1911" })), r => (req = r)) });
    const v = await c.verify(state([]));
    expect(v).toMatchObject({ complete: true, answer: "1911" });
    expect(req.body.model).toBe("claude-sonnet-5-5");
    expect(req.body.fallbacks).toBe("default");
    expect(req.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.effort).toBe("medium");
    expect(c.usage.usd).toBeCloseTo(1000 * 2e-6 + 200 * 10e-6, 8);
  });
  test("plan: browser and app parts, duplicate value names made unique", async () => {
    const plan = { question: "", subtasks: [
      { surface: "browser", url: "https://en.wikipedia.org/wiki/HKU", app: "", goal: "year visible", values: [] },
      { surface: "app", url: "", app: "Notepad", goal: "note written", values: [{ name: "note", text: "a" }, { name: "note", text: "b" }] },
    ] };
    const c = new Claude({ apiKey: "k", fetch: reply(msg(JSON.stringify(plan))) });
    const r = await c.plan("x", { today: "2026-10-03", platform: "Windows", apps: ["Notepad"] });
    expect(r.plan.subtasks[0].surface).toEqual({ kind: "browser", url: "https://en.wikipedia.org/wiki/HKU" });
    expect(r.plan.subtasks[1].surface).toEqual({ kind: "app", app: "Notepad" });
    expect(r.plan.subtasks[1].values.map(v => v.name)).toEqual(["note", "note 2"]);
  });
  test("spending cap: once reached, no further request is sent", async () => {
    let sent = 0;
    const c = new Claude({ apiKey: "k", budgetUsd: 0.003, fetch: reply(msg(JSON.stringify({ complete: true, answer: "1911", evidence: "e" })), () => sent++) });
    await c.verify(state([]));                                  // costs $0.004: over the cap afterwards
    expect(sent).toBe(1);
    await expect(c.verify(state([]))).rejects.toThrow("spending cap");
    expect(sent).toBe(1);
  });
  test("a refusal becomes a clear error, not a crash", async () => {
    const c = new Claude({ apiKey: "k", fetch: reply({ ...msg(""), content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "" } }) });
    expect(c.verify(state([]))).rejects.toBeInstanceOf(ModelError);
  });
});

describe("guardrails", () => {
  const it = (text: string): Item => ({ i: 0, id: "", role: "button", text, token: "t" });
  test("irreversible clicks need approval; ordinary ones do not", () => {
    for (const t of ["Send", "Place order", "Delete file", "Submit claim", "Pay now", "Confirm purchase", "Save", "Replace"]) expect(clickNeedsApproval(it(t))).not.toBeNull();
    for (const t of ["Search", "Next", "Six", "Wikipedia", "Open Navigation"]) expect(clickNeedsApproval(it(t))).toBeNull();
  });
  test("secret fields are never typed into", () => {
    for (const t of ["Password", "Card number", "CVV", "One-time code"]) expect(typingForbidden(it(t))).not.toBeNull();
    for (const t of ["Search", "Email subject", "Notes"]) expect(typingForbidden(it(t))).toBeNull();
  });
});

test("Windows replay lines survive PowerShell + exe argument parsing", () => {
  expect(replayLine("browser_type", { ref: "p1:0", text: 'a "b"' }, "win32"))
    .toBe('cua-driver call browser_type --% "{\\"ref\\":\\"p1:0\\",\\"text\\":\\"a \\\\\\"b\\\\\\"\\"}"');
});

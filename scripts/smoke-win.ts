// Real Windows driver, no models: browser (live web page) + Calculator + Notepad, with another window in front.
// Checks each primitive the agent uses and that the agent's windows never become the foreground window.
// Run: bun scripts/smoke-win.ts        (needs the Cua daemon; opens Calculator and a Notepad tab)
import { dlopen, FFIType } from "bun:ffi";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Observation, WindowRef } from "../src/contracts";
import { cuaCall } from "../src/driver/cli";
import { WinDriver } from "../src/driver/win";
import { perceive } from "../src/perceive";

const u = dlopen("user32.dll", {
  GetForegroundWindow: { args: [], returns: FFIType.u64 },
  GetWindowThreadProcessId: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.u32 },
});
const fgPid = () => { const b = new Uint32Array(1); u.symbols.GetWindowThreadProcessId(u.symbols.GetForegroundWindow(), b); return b[0]; };
const agentPids = new Set<number>();
let agentFront = 0, polls = 0, phase = "start";
const fgHits: string[] = [];
const timer = setInterval(() => { polls++; if (agentPids.has(fgPid())) { agentFront++; if (!fgHits.includes(phase)) fgHits.push(phase); } }, 5);

const d = new WinDriver(), H = "Mint-3" as const;
const lines: string[] = [];
const say = (ok: boolean, s: string) => { const l = `${ok ? "PASS" : "FAIL"}  ${s}`; console.log(l); lines.push(l); };
const find = (o: Observation, q: string | RegExp) => perceive(o, "").items.find(i => typeof q === "string" ? i.text === q : q.test(i.text));

await d.ensureSession(H);

// ---- 1. open every window first (launching an app may take the foreground once; that is recorded, not failed)
phase = "open";
let t0 = performance.now();
const b: WindowRef = await d.open(H, { kind: "browser", url: "https://en.wikipedia.org/wiki/Special:Search?search=" });
const tBrowser = Math.round(performance.now() - t0);
t0 = performance.now();
const c = await d.open(H, { kind: "app", app: "Calculator" });
const tCalc = Math.round(performance.now() - t0);
const n = await d.open(H, { kind: "app", app: "Notepad" });
for (const w of [b, c, n]) agentPids.add(w.pid);
const openedFront = agentFront > 0;

// ---- 2. put another app in front (a window this script owns), then every action must leave it there
const front = Bun.spawn(["powershell", "-NoProfile", "-Command",
  "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object Windows.Forms.Form; $f.Text = 'Smoke front window (user app)'; $f.Width = 640; $f.Height = 420; $f.Add_Shown({ $f.Activate() }); [void]$f.ShowDialog()"],
  { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
await Bun.sleep(2000);
// Windows' focus lock can stop a background process from raising its own window; ask Cua to raise it (test only).
const fw = ((await cuaCall("list_windows", { session: H })).data?.windows ?? []).find((w: any) => w.title === "Smoke front window (user app)");
if (fw) await cuaCall("bring_to_front", { session: H, pid: fw.pid, window_id: fw.window_id });
await Bun.sleep(700);
agentFront = 0; polls = 0; fgHits.length = 0;
const frontPid = fgPid();
say(!agentPids.has(frontPid), `setup: windows opened (browser ${tBrowser} ms, Calculator ${tCalc} ms)${openedFront ? "; a launch took the foreground once (expected for new windows)" : ""}; another app is now in front`);

// ---- browser on a real site
phase = "browser observe";
let o = await d.observe(H, b);
say(perceive(o, "").items.some(i => i.role === "text field"), `browser: Wikipedia search page; ${perceive(o, "").items.length} controls, observe ${o.ms} ms`);
const fields = perceive(o, "").items.filter(i => i.role === "text field");
const field = fields.find(i => /search/i.test(i.text)) ?? fields[0];
phase = "browser type";
let r = await d.act(H, b, { tool: "type", token: field!.token, text: "University of Hong Kong" });
o = await d.observe(H, b);
const typed = perceive(o, "").items.find(i => i.id === field!.id);
say(r.ok && typed?.value === "University of Hong Kong", `browser: typed into '${field!.text}' (${r.ms} ms), read back '${typed?.value}'`);
phase = "browser enter";
r = await d.act(H, b, { tool: "key", key: "enter", token: typed!.token });
await Bun.sleep(1500);
o = await d.observe(H, b);
say(r.ok && /Hong Kong/i.test(o.title), `browser: Enter ran the search (${r.ms} ms); page now '${o.title}', ${o.text.length} text lines`);
phase = "browser scroll";
const before = o.text.join(" ").length;
r = await d.act(H, b, { tool: "scroll", direction: "down" });
await Bun.sleep(500);
o = await d.observe(H, b);
say(r.ok, `browser: scroll (${r.ms} ms); visible text ${before} -> ${o.text.join(" ").length} chars; mentions 1911: ${/1911/.test(o.text.join(" "))}`);
phase = "browser navigate";
r = await d.act(H, b, { tool: "navigate", url: "https://en.wikipedia.org/wiki/University_of_Hong_Kong" });
o = await d.observe(H, b);
say(r.ok && /University of Hong Kong/.test(o.title), `browser: navigate (${r.ms} ms) -> '${o.title}'; founding year in text: ${o.text.some(t => /1911/.test(t))}`);

// ---- Calculator
phase = "calculator clicks";
for (const label of ["Clear", "Six", "Multiply by", "Seven", "Equals"]) {
  o = await d.observe(H, c);
  const it = find(o, label);
  if (!it) { say(false, `app: no '${label}' button`); break; }
  r = await d.act(H, c, { tool: "click", token: it.token });
  if (!r.ok) say(false, `app: click ${label} refused ${r.error?.code}`);
}
o = await d.observe(H, c);
say(o.text.some(t => t === "Display is 42"), `app: Calculator 6 x 7 = shows '${o.text.find(t => /^Display is/.test(t))}'`);

// ---- Notepad: a new tab, text replaced through UI Automation
phase = "notepad observe";
o = await d.observe(H, n);
const doc = perceive(o, "").items.find(i => i.role === "text area");
say(!!doc && !doc.value, `app: Notepad '${o.title}', document ${doc ? (doc.value ? "NOT empty" : "empty (new tab)") : "missing"}`);
if (doc && !doc.value) {
  phase = "notepad type";
  r = await d.act(H, n, { tool: "type", token: doc.token, text: "Shopping list: eggs, milk, bread" });
  o = await d.observe(H, n);
  const after = perceive(o, "").items.find(i => i.role === "text area");
  say(r.ok && after?.value === "Shopping list: eggs, milk, bread", `app: typed into Notepad (${r.ms} ms), read back '${after?.value}'`);
}

clearInterval(timer);
front.kill();
say(agentFront === 0, `focus: during all actions the agent's windows were the foreground window in ${agentFront} of ${polls} polls (5 ms)${fgHits.length ? `, during: ${fgHits.join(", ")}` : ""}`);
mkdirSync(join(import.meta.dir, "..", "evidence"), { recursive: true });
appendFileSync(join(import.meta.dir, "..", "evidence", "smoke-windows.md"), `\n## ${new Date().toISOString()} (bun scripts/smoke-win.ts)\n\n${lines.map(l => `- ${l}`).join("\n")}\n`);
process.exit(0);

// bun run preflight: checks everything the agent needs, with the fix for each problem.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MODEL } from "./claude";
import { cuaPath } from "./driver/cli";
import { makeDriver } from "./driver";

const PIN = "0.32.0";
const ROOT = join(import.meta.dir, "..");
let failed = 0;
const line = (status: "PASS" | "FAIL" | "WARN", what: string, fix = "") => {
  if (status === "FAIL") failed++;
  console.log(`${status.padEnd(4)}  ${what}${fix && status !== "PASS" ? `\n      -> ${fix}` : ""}`);
};
const run = async (args: string[]) => {
  try {
    const p = Bun.spawn([cuaPath(), ...args], { stdout: "pipe", stderr: "pipe" });
    const [o, e] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
    return { code: await p.exited, out: (o + e).trim() };
  } catch (e) { return { code: -1, out: String(e) }; }
};

if (process.env.DRIVER !== "sim") {
  const ver = await run(["--version"]);
  if (ver.code !== 0) line("FAIL", "cua-driver not found", "install it: README, step 2");
  else line(ver.out.includes(PIN) ? "PASS" : "WARN", ver.out, `tested with ${PIN}; other versions may behave differently`);
  const st = await run(["status"]);
  line(/is running/i.test(st.out) ? "PASS" : "FAIL", "Cua daemon running", process.platform === "win32" ? "powershell -ExecutionPolicy Bypass -File scripts\\daemon.ps1" : "sh scripts/daemon.sh");
  if (process.platform === "win32") {
    const admin = Bun.spawnSync(["net", "session"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    line(admin ? "FAIL" : "PASS", admin ? "running as administrator" : "not elevated", "run from a normal (non-admin) terminal");
    const tools = await run(["list-tools"]);
    const missing = ["get_browser_state", "browser_prepare", "browser_click", "browser_type", "get_window_state", "set_value", "launch_app"].filter(t => !tools.out.includes(t));
    line(missing.length ? "FAIL" : "PASS", "Cua tools present", `missing ${missing.join(", ")}`);
  }
}

if (process.env.ANTHROPIC_API_KEY) {
  try {
    const m = await new Anthropic({ timeout: 8000, maxRetries: 0 }).models.retrieve(CLAUDE_MODEL);
    line("PASS", `Claude reachable (${m.id})`);
  } catch (e) { line("FAIL", `Claude: ${(e as Error).message.slice(0, 160)}`, "check ANTHROPIC_API_KEY in .env and the network"); }
} else line("WARN", "no ANTHROPIC_API_KEY: jev + rules only; steps jev is unsure about stop and ask you", "optional: put the key in .env");

if (process.env.TYPESAFE_API_KEY) {
  try {
    const r = await fetch("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}` }, signal: AbortSignal.timeout(6000) });
    line(r.ok ? "PASS" : "FAIL", `TypeSafe reachable (HTTP ${r.status})`, "check TYPESAFE_API_KEY in .env");
  } catch (e) { line("FAIL", `TypeSafe unreachable: ${(e as Error).message}`, "check the network; without it Claude decides every step"); }
} else line(process.env.ANTHROPIC_API_KEY ? "WARN" : "FAIL", "no TYPESAFE_API_KEY: Claude would decide every step (slower, costlier)", "put the key in .env");

if (process.env.ELEVENLABS_API_KEY) {
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY.trim() }, signal: AbortSignal.timeout(6000) });
    const body = await r.text();
    if (r.ok) { const j = JSON.parse(body); line("PASS", `ElevenLabs reachable (${j.tier}: ${j.character_limit - j.character_count} of ${j.character_limit} credits left this month)`); }
    else if (r.status === 401 && /missing_permission/i.test(body)) line("PASS", "ElevenLabs key set (it can't read the quota, which is fine)");
    else line("WARN", `ElevenLabs: HTTP ${r.status}; answers will use the Windows voice`, "check ELEVENLABS_API_KEY in .env (https://elevenlabs.io/app/settings/api-keys)");
  } catch (e) { line("WARN", `ElevenLabs unreachable: ${(e as Error).message}; answers will use the Windows voice`, "check the network"); }
} else line("WARN", "no ELEVENLABS_API_KEY: answers use the Windows voice", "optional: a free key (10,000 credits a month) at https://elevenlabs.io/app/settings/api-keys");

if (process.platform === "win32" && process.env.VOICE !== "off") {
  const py = join(ROOT, "native", "win", ".venv", "Scripts", "python.exe");
  const model = process.env.WHISPER_MODEL ?? "small";
  const hub = join(homedir(), ".cache", "huggingface", "hub");
  const cached = existsSync(hub) && readdirSync(hub).some(d => d.toLowerCase().includes(`whisper-${model}`.toLowerCase()));
  line(existsSync(py) ? "PASS" : "WARN", existsSync(py) ? "voice helper installed" : "voice helper not installed (typing still works)", "README, Voice");
  if (existsSync(py)) line(cached ? "PASS" : "WARN", `speech model '${model}' ${cached ? "downloaded" : "not downloaded yet"}`, "the first start downloads it");
}

if (failed === 0 && process.env.DRIVER !== "sim") {
  try {
    const d = makeDriver();
    await d.ensureSession("Mint-3");
    const w = await d.open("Mint-3", { kind: "browser", url: "" });
    line("PASS", `agent browser ready: '${w.title}'`);
  } catch (e) { line("FAIL", `agent browser: ${(e as Error).message}`); }
}

console.log(failed ? `\n${failed} problem(s) to fix first.` : "\nReady: bun start, then open http://127.0.0.1:3000/");
process.exit(failed ? 1 : 0);

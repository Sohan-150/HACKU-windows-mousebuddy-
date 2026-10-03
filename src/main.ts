// bun start: the agent + live panel (+ push-to-talk dictation). Windows today; macOS driver included, untested.
import { Claude, CLAUDE_MODEL } from "./claude";
import { makeDriver } from "./driver";
import { startVoice } from "./intake";
import { Jev, JEV_MODEL } from "./jev";
import { App } from "./server";
import { stopOverlay, warmOverlay } from "./overlay";

const PANEL_PORT = Number(process.env.PANEL_PORT ?? 3000);
const driver = makeDriver();
const claude = process.env.ANTHROPIC_API_KEY ? new Claude() : null;
const jev = process.env.TYPESAFE_API_KEY ? new Jev() : null;

const app = new App(driver, claude, jev);
if (!jev && !claude) app.notice("error", "No TYPESAFE_API_KEY or ANTHROPIC_API_KEY in .env: nothing can make decisions. Add a key and restart.");
else if (!claude) app.notice("info", "Running on TypeSafe jev only: jev and rules plan and decide; a step jev is unsure about stops and asks you. An ANTHROPIC_API_KEY would let Claude take over those steps.");
else if (!jev) app.notice("warn", "No TYPESAFE_API_KEY in .env: Claude decides every step (slower and more expensive than jev).");
const server = app.serve(PANEL_PORT);
console.log(`panel: http://127.0.0.1:${server.port}/`);
// The start scripts set OPEN_PANEL=1: the panel opens in the default browser once the server is listening.
if (process.env.OPEN_PANEL === "1") {
  const url = `http://127.0.0.1:${server.port}/`;
  try { Bun.spawn(process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["open", url], { stdout: "ignore", stderr: "ignore" }); } catch { /* open it by hand */ }
}
console.log(`driver: ${driver.caps.name}`);
console.log(`deciders: ${jev ? `TypeSafe ${JEV_MODEL} first` : "no jev"}${claude ? `, Claude ${CLAUDE_MODEL} as fallback` : ", no Claude (jev + rules only)"}`);

const voice = startVoice(e => app.onVoice(e));
warmOverlay();                                    // the overlay helper takes ~1 s to start
app.voiceInfo = voice?.description ?? "voice off (type instead)";
app.pushState();

if (driver.caps.platform !== "sim") {
  try {
    await driver.ensureSession(app.hand);
    // Open the agent's own browser now: launching it takes the foreground once (measured), so it happens at start-up.
    const w = await driver.open(app.hand, { kind: "browser", url: "" });
    console.log(`agent browser ready: ${w.title}`);
  } catch (e) {
    app.notice("error", `agent browser not ready: ${(e as Error).message}. Is the Cua daemon running (scripts\\daemon.ps1)?`);
  }
  // Cua ends a session after 5 idle minutes, and on Windows its browser closes with it.
  setInterval(() => { if (!app.running) driver.keepAlive?.(app.hand).catch(() => {}); }, 60_000);
}

const shutdown = async () => {
  app.stop();
  voice?.stop();
  stopOverlay();
  if (process.env.CLOSE_BROWSER_ON_EXIT === "1") await driver.endAll();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

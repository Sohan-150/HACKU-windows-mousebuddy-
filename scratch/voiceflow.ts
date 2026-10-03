// The hold-Ctrl flow without a microphone: the same events voice.py sends, against the real cursor and Cua.
process.env.SPEAK = "off";
import { WinDriver } from "../src/driver/win";
import { Jev } from "../src/jev";
import { App } from "../src/server";
const app = new App(new WinDriver(), null, new Jev());
const t0 = performance.now();
app.onVoice({ event: "down", t: Date.now() });
await Bun.sleep(800);
app.onVoice({ event: "up", t: Date.now(), ms: 800 });
await Bun.sleep(1500);                                   // ~ transcription time; the window is looked at meanwhile
app.onVoice({ event: "transcript", lang: "en", text: process.argv[2] ?? "what is this?", ms: 1500 });
for (let i = 0; i < 60 && !app.tasks.some(t => t.status === "done" || t.status === "failed"); i++) await Bun.sleep(250);
const t = app.tasks[0];
const redact = (s?: string) => s?.replace(/"[^"]*"/g, '"…"');
console.log(`${t?.status} in ${Math.round(performance.now() - t0)} ms from key-down; source ${t?.source}`);
console.log("answer:", redact(t?.result?.answer ?? t?.exception?.reason));
console.log("evidence:", redact(t?.result?.evidence));
console.log("turns remembered:", app.turns.length);
process.exit(0);

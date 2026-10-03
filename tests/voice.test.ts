// Windows dictation without a microphone: a recorded English clip -> voice.py (faster-whisper) -> the instruction box.
// Skipped where the Windows voice helper is not installed (e.g. on a Mac).
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SimDriver } from "../src/driver/sim";
import { App } from "../src/server";

const ROOT = join(import.meta.dir, "..");
const PY = join(ROOT, "native", "win", ".venv", "Scripts", "python.exe");
const CLIP = join(ROOT, "fixtures", "audio", "en-claim.wav");   // Windows TTS: "Chan Tai Man, food, 128 dollars 50, 30 September, paid by FPS"

test.skipIf(!existsSync(PY) || !existsSync(CLIP))("dictation (VOICE_MODE=draft) lands in the instruction box, and nothing runs until the user sends it", async () => {
  const p = Bun.spawn([PY, join(ROOT, "native", "win", "voice.py"), "--file", CLIP, "--model", "small", "--lang", "en"],
    { stdout: "pipe", stderr: "ignore", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const lines = (await new Response(p.stdout).text()).trim().split("\n").map(l => JSON.parse(l));
  const tr = lines.find(l => l.event === "transcript");
  expect(tr.lang).toBe("en");
  expect(tr.text.toLowerCase()).toContain("food");
  const app = new App(new SimDriver(), null, null);
  app.voiceMode = "draft";
  await app.onSpoken(tr.text);
  expect(app.draft).toBe(tr.text);
  expect(app.tasks).toEqual([]);
}, 60_000);

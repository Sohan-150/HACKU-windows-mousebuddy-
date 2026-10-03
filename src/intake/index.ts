// Push-to-talk voice intake, one event stream for both platforms. Audio stays on the device.
//   Windows: native/win/voice.py (Ctrl+Win by default, faster-whisper on the CPU)
//   macOS:   native/mac/bin/ptt-helper (Right-Option) + native/mac/bin/stt (SpeechTranscriber, en-US by default)
import { existsSync } from "node:fs";
import { join } from "node:path";

export type VoiceEvent =
  | { event: "status"; [k: string]: unknown }
  | { event: "ready"; key?: string }
  | { event: "down"; t: number }
  | { event: "up"; t: number; ms: number }
  | { event: "cancel"; reason: string }                                  // Ctrl was part of a shortcut, or only tapped
  | { event: "transcript"; lang: string; text: string; ms: number; audio_ms?: number }
  | { event: "error"; msg: string };

const ROOT = join(import.meta.dir, "..", "..");

async function readLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
  const dec = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  }
}

function parseLine(l: string): VoiceEvent | null {
  try { return JSON.parse(l); } catch { return null; }
}

export interface VoiceHandle { stop(): void; description: string }

export function startVoice(onEvent: (e: VoiceEvent) => void): VoiceHandle | null {
  if (process.env.VOICE === "off") return null;
  if (process.platform === "win32") return startWindows(onEvent);
  if (process.platform === "darwin") return startMac(onEvent);
  return null;
}

function startWindows(onEvent: (e: VoiceEvent) => void): VoiceHandle | null {
  const py = join(ROOT, "native", "win", ".venv", "Scripts", "python.exe");
  if (!existsSync(py)) { onEvent({ event: "error", msg: "voice not installed: see README (native/win setup); typed box still works" }); return null; }
  const model = process.env.WHISPER_MODEL ?? "small", key = process.env.PTT_KEY ?? "ctrl_win", lang = process.env.VOICE_LANG ?? "en";
  const proc = Bun.spawn([py, join(ROOT, "native", "win", "voice.py"), "--model", model, "--key", key, "--lang", lang],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  readLines(proc.stdout, l => { const e = parseLine(l); if (e) onEvent(e); });
  proc.exited.then(code => onEvent({ event: "error", msg: `voice helper exited (${code}); typed box still works` }));
  return { stop: () => proc.kill(), description: `hold ${keyLabel(key)} and talk; point the mouse at something to ask about it (on-device speech, ${lang === "auto" ? "any language" : lang})` };
}

function startMac(onEvent: (e: VoiceEvent) => void): VoiceHandle | null {
  const ptt = join(ROOT, "native", "mac", "bin", "ptt-helper"), stt = join(ROOT, "native", "mac", "bin", "stt");
  if (!existsSync(ptt) || !existsSync(stt)) { onEvent({ event: "error", msg: "voice helpers not built: see native/mac/README.md; typed box still works" }); return null; }
  const proc = Bun.spawn([ptt], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const transcribe = async (wav: string, locale: string) => {
    const p = Bun.spawn([stt, "analyzer", wav, locale], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    try {
      const j = JSON.parse(out.trim().split("\n").at(-1) ?? "{}");
      if (j.text) onEvent({ event: "transcript", lang: locale === "zh-HK" ? "yue" : "en", text: j.text, ms: Math.round(j.ms ?? 0) });
    } catch { /* no transcript for this locale */ }
  };
  readLines(proc.stdout, l => {
    const e = parseLine(l) as any;
    if (!e) return;
    if (e.event === "up") {
      onEvent({ event: "up", t: e.t, ms: e.ms });
      if (e.wav) transcribe(e.wav, process.env.VOICE_LOCALE ?? "en-US");
    } else if (e.event === "fatal") onEvent({ event: "error", msg: e.msg });
    else onEvent(e);
  });
  proc.exited.then(code => onEvent({ event: "error", msg: `ptt-helper exited (${code}); typed box still works` }));
  return { stop: () => proc.kill(), description: "macOS: hold Right-Option to dictate (on-device SpeechTranscriber)" };
}

/** "ctrl_win" -> "Ctrl+Win", "right_ctrl" -> "Right-Ctrl". */
export function keyLabel(key: string): string {
  const names: Record<string, string> = { ctrl: "Ctrl", win: "Win", alt: "Alt", shift: "Shift", right: "Right", left: "Left", scroll: "Scroll", lock: "Lock" };
  const parts = key.split("_").map(p => names[p] ?? p.toUpperCase());
  return /^(right|left|scroll)_/.test(key) ? parts.join("-") : parts.join("+");
}

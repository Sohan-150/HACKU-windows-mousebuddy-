// Speaks answers aloud with the system voice (Windows: System.Speech; macOS: say). SPEAK=off turns it off.
import type { Subprocess } from "bun";

let current: Subprocess | null = null;

export function speak(text: string): void {
  if (process.env.SPEAK === "off" || !text.trim()) return;
  current?.kill();
  const said = text.replace(/\s+/g, " ").slice(0, 600);
  try {
    if (process.platform === "win32") {
      current = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
        "& { Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1; $s.Speak($args[0]) }", said],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      current = Bun.spawn(["say", said], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    }
  } catch { /* no voice output available: the answer is still on the panel */ }
}

export function stopSpeaking(): void { current?.kill(); current = null; }

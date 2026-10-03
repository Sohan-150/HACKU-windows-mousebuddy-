import { dlopen, FFIType } from "bun:ffi";
const u32 = dlopen("user32.dll", { GetForegroundWindow: { returns: FFIType.ptr, args: [] } });
const fg = () => String(u32.symbols.GetForegroundWindow());
const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "native/win/highlight.ps1"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
await p.stdout.getReader().read();
for (let round = 0; round < 3; round++) {
  const seen: { t: number; w: string }[] = [];
  const t0 = performance.now();
  p.stdin.write(JSON.stringify({ x: 900, y: 500, w: 120, h: 60, ms: 800 }) + "\n"); p.stdin.flush();
  while (performance.now() - t0 < 1800) { const w = fg(); if (!seen.length || seen.at(-1)!.w !== w) seen.push({ t: Math.round(performance.now() - t0), w }); await Bun.sleep(20); }
  console.log(`round ${round + 1}: foreground changes during show+fade+close: ${seen.length - 1}`, seen.length > 1 ? JSON.stringify(seen) : "");
}
p.stdin.end();

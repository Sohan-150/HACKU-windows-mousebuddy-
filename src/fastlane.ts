// The fast lane (ported from the Mac version): presses and text inserts sent straight through UI Automation by a small
// warm helper (native/win/fastlane.ps1), instead of through Cua Driver's single input lane. A few milliseconds per
// action instead of ~0.6 s, and agents in different apps really act at the same time.
// Anything the fast lane can't do safely comes back as not ok, and the driver uses Cua for it. FAST_INPUT=off turns
// it off.
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "native", "win", "fastlane.ps1");

export interface FastTarget { pid: number; hwnd?: number; frame: { x: number; y: number; w: number; h: number }; role: string; label?: string }
export interface FastResult { ok: boolean; ms: number; how?: string; error?: string }

export class FastLane {
  private proc?: Subprocess<"pipe", "pipe", "ignore">;
  private next = 1;
  private waiting = new Map<number, (r: FastResult) => void>();
  private state: "starting" | "on" | "off" = "starting";
  private ready: Promise<void>;
  reason = "";

  constructor(opts: { script?: string; spawn?: () => Subprocess<"pipe", "pipe", "ignore"> } = {}) {
    this.ready = this.start(opts).catch(e => this.off(String(e?.message ?? e)));
  }

  /** usable right now (it never makes a caller wait for start-up: until then Cua does the work) */
  get on() { return this.state === "on"; }

  async whenReady() { await this.ready; return this.on; }

  private off(why: string) {
    this.state = "off";
    this.reason = why;
    for (const r of this.waiting.values()) r({ ok: false, ms: 0, error: "fast lane stopped" });
    this.waiting.clear();
    if (why !== "not Windows") console.log(`[fast lane] off: ${why} (clicks and typing go through Cua)`);
  }

  private async start(opts: { script?: string; spawn?: () => Subprocess<"pipe", "pipe", "ignore"> }) {
    if (process.env.FAST_INPUT === "off") return this.off("FAST_INPUT=off");
    if (!opts.spawn && process.platform !== "win32") return this.off("not Windows");
    const script = opts.script ?? SCRIPT;
    if (!opts.spawn && !existsSync(script)) return this.off(`${script} is missing`);
    const proc = opts.spawn?.() ?? Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.proc = proc;
    const first = new Promise<any>(resolve => void this.readLines(proc, resolve));
    // PowerShell compiles the helper on start: a couple of seconds
    const hello = await Promise.race([first, Bun.sleep(15_000).then(() => undefined)]);
    if (!hello?.ready) { try { proc.kill(); } catch { /* gone */ } return this.off("the helper didn't start"); }
    this.state = "on";
    proc.exited.then(() => { if (this.state === "on") this.off("the helper exited"); });
    console.log("[fast lane] on: presses and native text fields go straight through UI Automation; Cua for the rest");
  }

  private async readLines(proc: Subprocess<"pipe", "pipe", "ignore">, hello: (j: any) => void) {
    const dec = new TextDecoder(), reader = proc.stdout.getReader();
    let buf = "", first = true;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          let j: any;
          try { j = JSON.parse(line); } catch { continue; }
          if (first) { first = false; hello(j); continue; }
          const done = this.waiting.get(j.id);
          if (done) { this.waiting.delete(j.id); done({ ok: !!j.ok, ms: j.ms ?? 0, how: j.how, error: j.error }); }
        }
      }
    } catch { /* the helper exited */ }
    if (first) hello(undefined);
  }

  private request(op: "press" | "type" | "restore", t: FastTarget, text?: string): Promise<FastResult> {
    if (!this.on || !this.proc) return Promise.resolve({ ok: false, ms: 0, error: "fast lane off" });
    const id = this.next++;
    const msg = { id, op, pid: t.pid, hwnd: t.hwnd ?? 0, x: t.frame.x, y: t.frame.y, w: t.frame.w, h: t.frame.h, role: t.role, label: t.label ?? "", text };
    return new Promise<FastResult>(resolve => {
      // the helper never acts after 3 s of looking and answers a blocking press within 1.5 s: no answer in 6 s means
      // nothing was done, so Cua can do it
      const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, ms: 6000, error: "no answer in 6 s" }); }, 6000);
      this.waiting.set(id, r => { clearTimeout(timer); resolve(r); });
      try {
        // non-ASCII escaped: safe whatever code page PowerShell reads with
        this.proc!.stdin.write(JSON.stringify(msg).replace(/[\u007f-￿]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n");
        this.proc!.stdin.flush();
      } catch { clearTimeout(timer); this.waiting.delete(id); resolve({ ok: false, ms: 0, error: "fast lane stopped" }); }
    });
  }

  press(t: FastTarget) { return this.request("press", t); }
  /** shows a minimised window again without taking the foreground */
  restore(hwnd: number) { return this.request("restore", { pid: 0, hwnd, frame: { x: 0, y: 0, w: 0, h: 0 }, role: "" }); }
  type(t: FastTarget, text: string) { return this.request("type", t, text); }
  stop() { try { this.proc?.stdin.end(); } catch { /* gone */ } }
}

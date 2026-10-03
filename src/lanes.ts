// What a part of a task needs to itself while it runs: the agent's browser window, the hand that drives desktop apps,
// Word, the file system. Parts (of one task or of several tasks) that need different things run at the same time;
// parts that need the same thing take turns, first come first served. A part holds one thing at a time and never
// waits for another while holding it, so nothing can deadlock.
import type { HandName, Surface } from "./contracts";

export type Resource = "browser" | "app" | "word" | "files";

export const RESOURCE_NAMES: Record<Resource, string> = {
  browser: "the agent's browser", app: "the desktop-app hand", word: "Word", files: "your files",
};

/** The Cua session (and so the cursor colour) each resource is driven with. Blue-9 is point-and-ask's own. */
export const RESOURCE_HANDS: Partial<Record<Resource, HandName>> = { browser: "Mint-3", app: "Red-7" };

export function resourceFor(s: Surface): Resource | undefined {
  return s.kind === "browser" ? "browser" : s.kind === "app" ? "app" : s.kind === "document" ? "word" : s.kind === "files" ? "files" : undefined;
}

export class Stopped extends Error { constructor() { super("stopped by you"); } }

export class Locks {
  private held = new Map<Resource, string>();                                  // resource -> who has it
  private queue = new Map<Resource, { who: string; go: () => void }[]>();

  /** Who has `r` now, if anyone. */
  holder(r: Resource): string | undefined { return this.held.get(r); }

  /** Who is waiting for `r`, in order. */
  waiting(r: Resource): string[] { return (this.queue.get(r) ?? []).map(e => e.who); }

  /**
   * Waits until `r` is free, then holds it for `who`; returns the function that lets it go. `onWait` is told who has
   * it when this has to wait. Rejects with Stopped if `signal` aborts while waiting.
   */
  async acquire(r: Resource, who: string, signal: AbortSignal, onWait?: (holder: string) => void): Promise<() => void> {
    if (signal.aborted) throw new Stopped();
    const q = this.queue.get(r) ?? [];
    this.queue.set(r, q);
    if (this.held.has(r) || q.length) {
      onWait?.(this.held.get(r) ?? q[q.length - 1].who);
      await new Promise<void>((resolve, reject) => {
        const entry = { who, go: () => { signal.removeEventListener("abort", onAbort); resolve(); } };
        const onAbort = () => { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); reject(new Stopped()); };
        signal.addEventListener("abort", onAbort, { once: true });
        q.push(entry);
      });
    }
    this.held.set(r, who);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Hand it straight to the next in line, so nobody can slip in between.
      const next = q.shift();
      if (next) { this.held.set(r, next.who); next.go(); } else this.held.delete(r);
    };
  }
}

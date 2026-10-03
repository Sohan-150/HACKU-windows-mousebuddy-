// What a part of a task needs to itself while it runs. Parts (of one task or of several tasks) that need different
// things run at the same time; parts that need the same thing take turns, first come first served.
//   web part      -> one of the agent's browser windows (each is its own hand: Mint-3, then Gold-5)
//   app part      -> that app (two parts never drive one app at once), then one of the app hands (Red-7, Violet-1)
//   Word document -> Word;  files -> the files
// Locks are always taken in that order (an app before a hand), and hands are never waited for by someone holding one,
// so nothing can deadlock.
import type { HandName, Surface } from "./contracts";

/** The agent's browser windows: Mint-3's opens at start-up, Gold-5's the first time two web parts run at once. */
export const BROWSER_HANDS: HandName[] = ["Mint-3", "Gold-5"];
/** The hands that drive desktop apps, each with its own cursor colour. Blue-9 is point-and-ask's own. */
export const APP_HANDS: HandName[] = ["Red-7", "Violet-1"];

export class Stopped extends Error { constructor() { super("stopped by you"); } }

/** What a part has to wait for, in plain words (for "waiting for ..."). */
export function lockName(lock: string): string {
  if (lock.startsWith("hand:")) return BROWSER_HANDS.includes(lock.slice(5) as HandName) ? "a browser window" : "a free hand for apps";
  if (lock.startsWith("app:")) return lock.slice(4);
  return lock === "word" ? "Word" : lock === "files" ? "your files" : lock;
}

/** The locks a part takes before its hand: its app, Word or the files. Web parts only need a hand. */
export function locksFor(s: Surface): string[] {
  return s.kind === "app" ? [`app:${s.app.trim().toLowerCase()}`] : s.kind === "document" ? ["word"] : s.kind === "files" ? ["files"] : [];
}

/** Which hands can do a part (it takes the first that is free), or none for parts without a window. */
export function handsFor(s: Surface, browser = BROWSER_HANDS, apps = APP_HANDS): HandName[] {
  return s.kind === "browser" ? browser : s.kind === "app" ? apps : [];
}

type Waiter = { names: string[]; who: string; take: (name: string) => void };

export class Locks {
  private held = new Map<string, string>();                                     // lock -> who has it
  private queue: Waiter[] = [];                                                  // first come, first served

  /** Who has `name` now, if anyone. */
  holder(name: string): string | undefined { return this.held.get(name); }

  /** Who is waiting for `name`, in order. */
  waiting(name: string): string[] { return this.queue.filter(w => w.names.includes(name)).map(w => w.who); }

  /** Waits until `name` is free, then holds it for `who`; returns the function that lets it go. */
  async acquire(name: string, who: string, signal: AbortSignal, onWait?: (holder: string) => void): Promise<() => void> {
    return (await this.acquireAny([name], who, signal, onWait)).release;
  }

  /**
   * Waits until one of `names` is free (the first free one, in order), then holds it for `who`. `onWait` is told who
   * has them when this has to wait. Rejects with Stopped if `signal` aborts while waiting.
   */
  async acquireAny(names: string[], who: string, signal: AbortSignal, onWait?: (holder: string) => void): Promise<{ name: string; release: () => void }> {
    if (signal.aborted) throw new Stopped();
    // Free, and nobody who came earlier is waiting for it.
    let name = names.find(n => !this.held.has(n) && !this.queue.some(w => w.names.includes(n)));
    if (name === undefined) {
      onWait?.(names.map(n => this.held.get(n)).find(Boolean) ?? this.queue.find(w => w.names.some(n => names.includes(n)))?.who ?? "another task");
      name = await new Promise<string>((resolve, reject) => {
        const waiter: Waiter = { names, who, take: n => { signal.removeEventListener("abort", onAbort); resolve(n); } };
        const onAbort = () => { const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); reject(new Stopped()); };
        signal.addEventListener("abort", onAbort, { once: true });
        this.queue.push(waiter);
      });
    }
    this.held.set(name, who);
    const taken = name;
    let released = false;
    return {
      name: taken,
      release: () => {
        if (released) return;
        released = true;
        // Hand it straight to the first in line who can use it, so nobody can slip in between.
        const i = this.queue.findIndex(w => w.names.includes(taken));
        if (i >= 0) { const [next] = this.queue.splice(i, 1); this.held.set(taken, next.who); next.take(taken); }
        else this.held.delete(taken);
      },
    };
  }
}

// runs/<runId>/steps.jsonl: one JSON object per line. The viewer, replay and evidence read only this.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogLine, Logger } from "./contracts";

export const RUNS_DIR = join(import.meta.dir, "..", "runs");

export function newRunId(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `r-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

export class JsonlLogger implements Logger {
  readonly file: string;
  constructor(public runId: string, private listeners: Set<(l: LogLine) => void> = new Set(), dir = RUNS_DIR) {
    mkdirSync(join(dir, runId), { recursive: true });
    this.file = join(dir, runId, "steps.jsonl");
  }
  write(l: LogLine): void {
    appendFileSync(this.file, JSON.stringify(l) + "\n");
    for (const f of this.listeners) { try { f(l); } catch { /* a broken viewer never stops a run */ } }
  }
}

/** For tests: keeps lines in memory. */
export class MemoryLogger implements Logger {
  lines: LogLine[] = [];
  constructor(public runId = "test") {}
  write(l: LogLine): void { this.lines.push(l); }
}

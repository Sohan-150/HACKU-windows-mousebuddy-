// What was heard: speech-to-text makes mistakes on exactly the words that matter most (names of people, artists and
// apps, and short commands such as "deafen"), and a misheard command does the wrong thing. Three defences:
//  - a vocabulary of the names this user actually says (apps, people and artists from tasks that finished), kept in
//    runs/voice-words.json; voice.py puts it in the speech model's hint, so names come out spelled right;
//  - a word the model was unsure of that sounds like a known name or command is corrected ("defin" -> "deafen",
//    "Mohid" -> "Mohit", "Whatsup" -> "WhatsApp");
//  - a job heard with words the model was still unsure of is not done on a guess: it is shown and said back first
//    ("Did you say ...? Say yes, or say it again"), and put in the panel's box to fix by typing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "./contracts";
import { RUNS_DIR } from "./logger";

export type HeardWord = [string, number];   // a word as the model wrote it (with its leading space), and its probability
export interface Heard { logprob?: number; noSpeech?: number; words?: HeardWord[] }
export interface Corrected { text: string; fixed: [string, string][]; unsure: string[] }

/** words the model is often unsure of and that sound alike: commands and the apps people name */
const BASE = ["mute", "unmute", "deafen", "undeafen", "Spotify", "Discord", "WhatsApp", "YouTube", "Chrome", "Calculator", "Notepad",
  "Excel", "PowerPoint", "Outlook", "Teams", "Steam", "Fortnite", "Minecraft", "Roblox", "Telegram", "Instagram", "Netflix", "Epic Games", "VS Code"];
/** a word below this probability may be corrected; one below UNSURE_P that is not corrected makes a job wait for a yes */
const FIX_P = 0.6, UNSURE_P = 0.35;
const STOP = new Set(("a an the and or but to of in on at for with from by is are was be it this that my me you your i we us " +
  "please can could would will just then so up out off now some any all hi hey okay ok yes no").split(" "));

export class Vocabulary {
  private used = new Map<string, number>();     // name -> when it was last used
  constructor(readonly file = join(RUNS_DIR, "voice-words.json")) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      for (const [w, t] of Object.entries(j.used ?? {})) if (typeof t === "number") this.used.set(w, t);
    } catch { /* none yet */ }
  }

  /** the names to hint, most recently used first (voice.py reads `words`) */
  get words(): string[] { return [...this.used].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 40); }
  /** every name a misheard word may be corrected to */
  terms(): string[] {
    const own = (process.env.VOICE_WORDS ?? "").split(",").map(w => w.trim()).filter(Boolean);
    return [...new Set([...own, ...this.words, ...BASE])];
  }

  learn(names: string[], at = Date.now()) {
    let changed = false;
    // strictly later than anything learnt before, so "most recent first" holds within one millisecond too
    let now = Math.max(at, ...[...this.used.values()].map(t => t + 1));
    for (const raw of names) {
      const n = raw.replace(/[^\p{L}\p{N}' .&-]/gu, "").replace(/\s+/g, " ").trim();
      // a name, not a sentence: 1 to 3 words, letters in it
      if (n.length < 2 || n.length > 32 || n.split(" ").length > 3 || !/\p{L}/u.test(n) || STOP.has(n.toLowerCase())) continue;
      const known = [...this.used.keys()].find(k => k.toLowerCase() === n.toLowerCase());
      this.used.delete(known ?? n);
      this.used.set(n, now++);
      changed = true;
    }
    if (!changed) return;
    while (this.used.size > 200) this.used.delete([...this.used].sort((a, b) => a[1] - b[1])[0]![0]);
    this.save();
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ words: this.words, used: Object.fromEntries(this.used) }, null, 1));
    } catch { /* the vocabulary is optional */ }
  }

  /** the apps, people and artists of a task that finished well (only then: a misheard name is never learnt) */
  learnFrom(t: Task) {
    if (t.status !== "done" || !t.plan) return;
    const names: string[] = [];
    for (const s of t.plan.subtasks) {
      if (s.surface.kind === "app") names.push(s.surface.app);
      for (const v of s.values) if (/who to reach|search terms|contact|artist|recipient/i.test(v.name) && v.text.split(/\s+/).length <= 3) names.push(cap(v.text));
    }
    this.learn(names);
  }
}

const cap = (s: string) => s.replace(/\b\p{L}/gu, c => c.toUpperCase());

/** Jaro-Winkler similarity of two lowercase words (1 = the same) */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true; m++; break;
    }
  }
  if (!m) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const j = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

/** how a word sounds, roughly: its consonants after spelling-to-sound rules ("deafen" and "defin" are both "dfn") */
export function soundKey(w: string): string {
  let s = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  s = s.replace(/^kn|^gn|^wr/, m => m[1]!).replace(/ph/g, "f").replace(/ck/g, "k").replace(/q/g, "k").replace(/x/g, "ks")
    .replace(/c(?=[eiy])/g, "s").replace(/c/g, "k").replace(/z/g, "s").replace(/dg/g, "j").replace(/gh/g, "g").replace(/th/g, "0")
    .replace(/sh/g, "x").replace(/v/g, "f");
  const first = s[0]!;
  const rest = s.slice(1).replace(/[aeiouhwy]/g, "");
  return (/[aeiou]/.test(first) ? "a" : first) + rest.replace(/(.)\1+/g, "$1");
}

/** a heard word that sounds like a known name: that name (or undefined) */
export function soundsLike(word: string, terms: string[]): string | undefined {
  const w = word.toLowerCase();
  if (w.length < 3) return undefined;
  let best: { term: string; score: number } | undefined;
  for (const term of terms) {
    const t = term.toLowerCase();
    if (t === w) return undefined;                      // already right
    if (t === `${w}s` || w === `${t}s` || t === `${w}es` || w === `${t}es`) continue;   // "team" is not "Teams"
    if (Math.abs(t.length - w.length) > Math.max(2, Math.round(t.length * 0.4))) continue;
    const jw = jaroWinkler(w, t);
    const same = t.length >= 4 && soundKey(w) === soundKey(t) && soundKey(t).length >= 2;
    const score = same ? Math.max(jw, 0.9) : jw;
    if (score >= (t.length <= 4 ? 0.92 : 0.88) && (!best || score > best.score)) best = { term, score };
  }
  return best?.term;
}

/**
 * The transcript with words the model was unsure of corrected to known names that sound like them, and the words it
 * was still unsure of. Without word probabilities (the Mac's recogniser) the text is kept as it is.
 */
export function correctHeard(text: string, words: HeardWord[] | undefined, terms: string[]): Corrected {
  if (!words?.length) return { text, fixed: [], unsure: [] };
  const out = words.map(([w, p]) => ({ w, p }));
  const fixed: [string, string][] = [];
  const known = new Set(terms.map(t => t.toLowerCase()));
  const parts = (w: string) => /^(\s*)([^\p{L}\p{N}]*)([\p{L}\p{N}'-]*)(.*)$/u.exec(w)!;   // space, before, the word, after
  for (let i = 0; i < out.length; i++) {
    const [, sp, pre, core, post] = parts(out[i]!.w);
    if (!core || out[i]!.p >= FIX_P) continue;
    // two words heard for a two-word name ("Dua Leepa" -> "Dua Lipa")
    const next = out[i + 1] ? parts(out[i + 1]!.w) : undefined;
    if (next?.[3]) {
      const two = soundsLike(`${core} ${next[3]}`, terms.filter(t => t.includes(" ")));
      if (two) {
        fixed.push([`${core} ${next[3]}`, two]);
        out[i] = { w: `${sp}${pre}${two}${next[4]}`, p: 1 };
        out.splice(i + 1, 1);
        continue;
      }
    }
    const one = soundsLike(core, terms.filter(t => !t.includes(" ")));
    if (one) { fixed.push([core, one]); out[i] = { w: `${sp}${pre}${one}${post}`, p: 1 }; }
  }
  const unsure = out.filter(x => x.p < UNSURE_P).map(x => parts(x.w)[3]!)
    .filter(c => (c.length >= 3 || /\d/.test(c)) && !STOP.has(c.toLowerCase()) && !known.has(c.toLowerCase()));
  return { text: out.map(x => x.w).join("").trim() || text, fixed, unsure };
}

/** a job heard this unsurely waits for a yes (VOICE_CONFIRM=always / off changes that) */
export function needsConfirm(c: Corrected, h: Heard, mode = process.env.VOICE_CONFIRM ?? "auto"): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  if (c.unsure.length) return true;
  if (h.logprob !== undefined && h.logprob < -0.9) return true;              // the whole sentence was a struggle
  return h.noSpeech !== undefined && h.logprob !== undefined && h.noSpeech > 0.6 && h.logprob < -0.5;
}

/** the vocabulary file voice.py reads (VOICE_VOCAB), created if missing so the path is always valid */
export function vocabFile(v: Vocabulary): string {
  if (!existsSync(v.file)) v.save();
  return v.file;
}

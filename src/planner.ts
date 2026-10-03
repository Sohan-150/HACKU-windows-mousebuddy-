// Planning without Claude: jev classifies each part of the instruction (task type, app, file operation), and code
// pulls out the details (search terms, text to type, numbers, folders, file types). Used when no Claude key is set.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Check, FileMatch, FileOp, Plan, Subtask } from "./contracts";
import type { Classification, FileOpKind, JevExtra, TaskType } from "./jev";

export class PlanError extends Error {}

/** "find X then write it in Notepad" -> two parts. Only explicit sequencing words split, so "eggs, milk and bread" stays whole. */
export function splitParts(instruction: string): string[] {
  return instruction.split(/\s*(?:,?\s*\band then\b|,?\s*\bthen\b|;\s*|\.\s+(?=[A-Z]))\s*/i).map(s => s.trim().replace(/[.!]+$/, "")).filter(Boolean);
}

const IMPERATIVE = /^(please\s+|can you\s+|could you\s+)*(find out|look up|search( the web| online)? for|google|tell me|find|check|i want to know|let me know)\s+/i;

export function webQuery(part: string): string {
  return part.replace(IMPERATIVE, "").replace(/\s+(on|using) (the )?(web|internet|google)$/i, "").replace(/\?+$/, "").trim();
}

const SITES: Record<string, string> = {
  youtube: "https://www.youtube.com/", github: "https://github.com/", wikipedia: "https://en.wikipedia.org/",
  "google maps": "https://www.google.com/maps", gmail: "https://mail.google.com/", reddit: "https://www.reddit.com/",
  amazon: "https://www.amazon.com/", bbc: "https://www.bbc.com/news", "hacker news": "https://news.ycombinator.com/",
};

export function siteUrl(part: string): string | undefined {
  const m = part.match(/\bhttps?:\/\/\S+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|edu|gov|hk|co|ai|dev|app|uk|info)(?:\/\S*)?/i);
  if (m) return m[0].startsWith("http") ? m[0].replace(/[.,)]+$/, "") : `https://${m[0].replace(/[.,)]+$/, "")}`;
  const lower = part.toLowerCase();
  const site = Object.keys(SITES).find(k => lower.includes(k));
  return site ? SITES[site] : undefined;
}

const enc = encodeURIComponent;

/** google.com/search answers an automated browser with a "sorry" block page (measured), so web searches go to
 *  DuckDuckGo's HTML results instead. Other Google pages (maps, flights) work and are left alone. */
export function searchUrl(url: string): string {
  const m = url.match(/^https?:\/\/(?:www\.)?google\.[a-z.]+\/search\?(.*)$/i);
  if (!m) return url;
  const q = new URLSearchParams(m[1]).get("q");
  return q ? `https://html.duckduckgo.com/html/?q=${enc(q)}` : url;
}
/** Google pages in English, biased to the user's country (REGION, e.g. HK) and currency (CURRENCY, e.g. HKD) when set:
 *  otherwise Google guesses from the IP address, and "Central" may be looked up in the wrong country. */
export function googleParams(env: Record<string, string | undefined> = process.env, opts: { currency?: boolean } = {}): string {
  const region = env.REGION?.trim().toLowerCase(), cur = env.CURRENCY?.trim().toUpperCase();
  return `hl=en${region && /^[a-z]{2}$/.test(region) ? `&gl=${region}` : ""}${opts.currency && cur && /^[A-Z]{3}$/.test(cur) ? `&curr=${cur}` : ""}`;
}
/** A site's own search results page: one step instead of finding and filling its search box. */
const SITE_SEARCH: Record<string, (q: string) => string> = {
  youtube: q => `https://www.youtube.com/results?search_query=${enc(q)}`, amazon: q => `https://www.amazon.com/s?k=${enc(q)}`,
  wikipedia: q => `https://en.wikipedia.org/w/index.php?search=${enc(q)}`, github: q => `https://github.com/search?q=${enc(q)}`,
  reddit: q => `https://www.reddit.com/search/?q=${enc(q)}`, "google maps": q => `https://www.google.com/maps/search/${enc(q)}?${googleParams()}`,
  "hacker news": q => `https://hn.algolia.com/?q=${enc(q)}`,
};

export function siteSearchUrl(part: string, query: string): string | undefined {
  const lower = part.toLowerCase();
  const site = Object.keys(SITE_SEARCH).find(k => lower.includes(k));
  return site && query ? SITE_SEARCH[site](query) : undefined;
}

// ---------- everyday assistant requests with a direct results page ----------
const ASK_PREFIX = /^(please\s+|can you\s+|could you\s+|i want to\s+|i'd like to\s+|i need to\s+|help me\s+|let's\s+)*(find( me)?|search( for)?|look up|show( me)?|get( me)?|check|book( me)?|compare|what are)?\s*/i;

/** "book a flight from Hong Kong to Tokyo on 20 November" -> Google Flights with that query (it parses the words). */
export function flightQuery(part: string): string | null {
  if (!/\b(flights?|fly|flying|plane tickets?|air ?fares?|airline tickets?)\b/i.test(part)) return null;
  if (!/\bto\s+\w/i.test(part.replace(/\b(want|like|need|have|going) to\b/gi, ""))) return null;
  const q = part.replace(/[?.!]+$/, "").replace(ASK_PREFIX, "")
    .replace(/^(a |an |some |the )?(cheap(est)?|good|direct)?\s*(flights?|fly|flying|plane tickets?|air ?fares?|airline tickets?)\b/i, "")
    .replace(/\s*\b(and|then)\b.*$/i, "").trim();
  return q ? `Flights ${q}` : null;
}

/** "directions from Central to the airport" / "how do I get from A to B" -> Google Maps directions. */
export function directions(part: string): { from: string; to: string } | null {
  if (!/\b(directions?|route|how (do|can|should) i get|how to get|get from|navigate|travel time|commute)\b/i.test(part)) return null;
  const s = part.replace(/[?.!]+$/, "");
  const tail = String.raw`(?:\s+(?:by|via|using|on foot|today|tomorrow|now)\b.*)?$`;
  const a = s.match(new RegExp(String.raw`\bfrom\s+(.+?)\s+to\s+(.+?)${tail}`, "i"));
  if (a) return { from: a[1].trim(), to: a[2].trim() };
  const b = s.match(new RegExp(String.raw`\bto\s+(.+?)\s+from\s+(.+?)${tail}`, "i"));
  if (b) return { from: b[2].trim(), to: b[1].trim() };
  const c = s.match(new RegExp(String.raw`\b(?:to|for)\s+(.+?)${tail}`, "i"));
  return c ? { from: "", to: c[1].trim() } : null;            // the caller asks where they start from
}

/** "what's the weather in Hong Kong" -> wttr.in's one-line report (plain text, no ads, no JavaScript). */
export function weatherPlace(part: string): string | null {
  if (!/\b(weather|temperature|forecast|raining|rain today|how (hot|cold|warm) is it)\b/i.test(part)) return null;
  const place = part.replace(/[?.!]+$/, "").match(/\b(?:in|at|for)\s+([A-Za-z][\w .'-]+?)(?:\s+(?:today|tomorrow|now|right now|this week))?$/i)?.[1];
  return place?.trim() ?? "";
}

/** A ready browser part for the requests above, or null. */
export function assistantPart(part: string): Subtask | null {
  const f = flightQuery(part);
  if (f) {
    return {
      surface: { kind: "browser", url: `https://www.google.com/travel/flights?q=${enc(f)}&${googleParams(process.env, { currency: true })}` },
      goal: `Flight options for "${f}" are listed on screen (airline, times and price). Do not enter passenger or payment details.`,
      values: [{ name: "flight search", text: f }], question: true,
    };
  }
  const d = directions(part);
  if (d && !d.from) throw new PlanError(`Where are you starting from? Say for example "directions from Central to ${d.to}".`);
  if (d) {
    return {
      surface: { kind: "browser", url: `https://www.google.com/maps/dir/${enc(d.from)}/${enc(d.to)}/?${googleParams()}` },
      goal: `Directions from ${d.from} to ${d.to} are shown, with the travel time of the suggested route.`,
      values: [{ name: "start", text: d.from }, { name: "destination", text: d.to }], question: true,
    };
  }
  const w = weatherPlace(part);
  if (w !== null) {
    return {
      surface: { kind: "browser", url: `https://wttr.in/${enc(w)}?format=${enc("%l: %C, %t (feels like %f), wind %w, humidity %h")}` },
      goal: `The current weather${w ? ` in ${w}` : ""} is visible on screen.`, values: [], question: true,
    };
  }
  return null;
}

// ---------- calculator ----------
const NUM_WORDS = /(-?\d[\d,]*(?:\.\d+)?)/;
const OPS: [RegExp, string, string][] = [
  [/^(\*|x|×|times|multiplied by)$/i, "*", "Multiply by"], [/^(\/|÷|divided by|over)$/i, "/", "Divide by"],
  [/^(\+|plus|add)$/i, "+", "Plus"], [/^(-|−|minus|less)$/i, "-", "Minus"],
];
const DIGIT_BUTTON = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "128.5 times 12" -> button names for Windows Calculator and the expected result. */
export function calculation(part: string): { buttons: string[]; expected: number; expression: string } | null {
  const s = part.toLowerCase().replace(/multiplied by/g, "times").replace(/divided by/g, "over").replace(/,(?=\d{3})/g, "")
    // "15% of 80" / "15 percent of 80" -> "80 times 0.15"
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(-?\d+(?:\.\d+)?)/g, (_m, p, n) => `${n} times ${Number((Number(p) / 100).toPrecision(12))}`);
  const tokens = s.match(/-?\d+(?:\.\d+)?|times|over|plus|minus|less|add|[x×*/÷+\-−]/g);
  if (!tokens) return null;
  const nums: number[] = [], ops: string[] = [], buttons: string[] = ["Clear"];
  let expectNum = true;
  for (const t of tokens) {
    if (expectNum && /\d/.test(t)) {
      nums.push(Number(t));
      for (const ch of t.replace(/^-/, "")) buttons.push(ch === "." ? "Decimal separator" : DIGIT_BUTTON[Number(ch)]);
      if (t.startsWith("-")) buttons.push("Positive negative");
      expectNum = false;
    } else if (!expectNum) {
      const op = OPS.find(([re]) => re.test(t));
      if (!op) continue;
      ops.push(op[1]); buttons.push(op[2]); expectNum = true;
    }
  }
  if (nums.length < 2 || ops.length !== nums.length - 1) return null;
  // Evaluate left to right (Windows Calculator's standard mode) and with precedence; they agree for one operator.
  const expression = nums.map((n, i) => (i ? `${ops[i - 1]} ${n}` : `${n}`)).join(" ");
  let expected = nums[0];
  ops.forEach((op, i) => { const b = nums[i + 1]; expected = op === "+" ? expected + b : op === "-" ? expected - b : op === "*" ? expected * b : expected / b; });
  return { buttons: [...buttons, "Equals"], expected: Math.round(expected * 1e10) / 1e10, expression };
}

// ---------- text to write ----------
/** "write a short thank-you note to my teacher": the text has to be composed, it is not given. */
export function needsComposing(part: string): boolean {
  if (/["“”]|:/.test(part)) return false;                     // quoted text or "list: a, b, c" is given verbatim
  return /\b(write|compose|draft|create|make)\b.*\b(note|letter|e-?mail|poem|message|story|summary|paragraph|essay|haiku|speech|toast|reply|apology|invitation|bio|description|review|joke|caption|thank[- ]you)\b/i.test(part);
}

export function textToWrite(part: string): { text: string; fromPrevious: boolean } {
  const quoted = part.match(/["“']([^"”']{2,})["”']/);
  if (quoted) return { text: quoted[1], fromPrevious: false };
  if (/\b(write|type|paste|put|note)\b.*\b(it|that|the answer|the result|this)\b/i.test(part) && !/:/.test(part)) return { text: "", fromPrevious: true };
  const m = part.match(/\b(?:write(?: down)?|type|note down|jot down|saying|that says)\s+(.+)$/i);
  let text = (m ? m[1] : part).replace(/\s+(in|into|on) (notepad|the notepad|a (new )?note|a text file)\b.*$/i, "").replace(/^(a|an|the)\s+/i, "").trim();
  text = text.charAt(0).toUpperCase() + text.slice(1);
  return { text, fromPrevious: false };
}

// ---------- files ----------
const KNOWN_FOLDERS: Record<string, string> = {
  desktop: "Desktop", downloads: "Downloads", download: "Downloads", documents: "Documents", "my documents": "Documents",
  pictures: "Pictures", photos: "Pictures", music: "Music", videos: "Videos",
};
const KIND_EXTS: Record<string, string[]> = {
  pdf: ["pdf"], pdfs: ["pdf"], images: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic"],
  photos: ["png", "jpg", "jpeg", "heic", "webp"], pictures: ["png", "jpg", "jpeg", "gif", "bmp", "webp"],
  screenshots: ["png", "jpg"], documents: ["pdf", "doc", "docx", "txt", "rtf", "odt", "md"], spreadsheets: ["xls", "xlsx", "csv", "ods"],
  videos: ["mp4", "mov", "avi", "mkv", "webm"], music: ["mp3", "wav", "flac", "m4a", "aac"], zips: ["zip", "rar", "7z"],
  "text files": ["txt"], "word documents": ["doc", "docx"],
};

/** "Downloads", "Desktop\scans", "C:\Users\me\x" -> a full path (known names are inside the user folder). */
export function resolveFolder(name: string, home = homedir()): string {
  const n = name.trim().replace(/^["“]|["”]$/g, "");
  if (/^[A-Za-z]:[\\/]/.test(n) || n.startsWith("/")) return n;
  const [first, ...rest] = n.split(/[\\/]/).filter(Boolean);
  const known = KNOWN_FOLDERS[(first ?? "").toLowerCase()];
  return known ? join(home, known, ...rest) : join(home, "Desktop", ...[first, ...rest].filter(Boolean));
}

/** All folder mentions, in order: explicit paths (C:\..., quoted) and known names, with sub-paths ("Desktop\pics"). */
export function folders(part: string, home = homedir()): string[] {
  const out: string[] = [];
  for (const m of part.matchAll(/["“]([A-Za-z]:\\[^"”]+)["”]|\b([A-Za-z]:\\[^\s,;"]+)/g)) out.push((m[1] ?? m[2]).replace(/[.\\]+$/, ""));
  // Sub-paths stop at a space ("Desktop\scans to Documents" is two folders); quote a name that has spaces.
  for (const m of part.matchAll(/\b(my documents|desktop|downloads?|documents|pictures|photos|music|videos)((?:[\\/][\w.-]+)*)/gi)) {
    const base = join(home, KNOWN_FOLDERS[m[1].toLowerCase()]);
    out.push(m[2] ? join(base, ...m[2].split(/[\\/]/).filter(Boolean)) : base);
  }
  for (const m of part.matchAll(/\b(?:folder|into|to)\s+(?:a\s+|the\s+)?(?:folder\s+)?(?:called|named)\s+["“]?([\w .-]+?)["”]?(?=$|[,.]|\s+(?:in|on|inside)\b)/gi)) out.push(`@sub:${m[1].trim()}`);
  return out;
}

export function match(part: string): FileMatch {
  const exts = new Set<string>();
  for (const m of part.matchAll(/\.([a-z0-9]{2,5})\b|\b(pdf|png|jpe?g|gif|bmp|webp|tiff?|docx?|xlsx?|csv|txt|md|mp3|mp4|zip|json|html?)s?\b/gi)) {
    const e = (m[1] ?? m[2]).toLowerCase();
    if (!/^(com|org|net|exe)$/.test(e)) exts.add(e === "jpeg" ? "jpg" : e);
  }
  const lower = part.toLowerCase();
  for (const [k, v] of Object.entries(KIND_EXTS)) if (new RegExp(`\\b${k}\\b`).test(lower) && !/^(documents|pictures|music|videos)$/.test(k)) v.forEach(e => exts.add(e));
  const named = part.match(/["“]([^"”\\/:]+\.[a-z0-9]{2,5})["”]|\b([\w-]+\.[a-z0-9]{2,5})\b/i);
  return { exts: exts.size ? [...exts] : undefined, name: named ? (named[1] ?? named[2]) : undefined };
}

export function fileOp(kind: FileOpKind, part: string, home = homedir()): FileOp {
  const fs = folders(part, home).filter(f => !f.startsWith("@sub:"));
  const sub = folders(part, home).find(f => f.startsWith("@sub:"))?.slice(5);
  const m = match(part);
  const folder = fs[0];
  if (kind === "organize") {
    if (!folder) throw new PlanError("Which folder should I organise? Say for example 'organise my Downloads folder'.");
    return { op: "organize", folder };
  }
  if (kind === "list") {
    if (!folder) throw new PlanError("Which folder should I look in?");
    return { op: "list", folder, match: m };
  }
  if (kind === "convert") {
    const to = part.match(/\b(?:to|into|as)\s+(?:a\s+|an\s+)?\.?(pdf|png|jpe?g|gif|bmp|tiff?|json|csv)\b/i)?.[1]?.toLowerCase().replace("jpeg", "jpg");
    if (!to) throw new PlanError("Convert to which format? For example 'convert photo.png to jpg'.");
    const from = { ...m, exts: m.exts?.filter(e => e !== to) };
    if (!from.exts?.length && !from.name) throw new PlanError("Which files should I convert? Name a file or a type, like 'all PNG files'.");
    return { op: "convert", folder: folder ?? join(home, "Desktop"), match: from, to };
  }
  // move / copy: source is the first folder, destination the second (or a named sub-folder of the source)
  const dest = fs[1] ?? (sub && folder ? join(folder, sub) : undefined);
  if (!folder || !dest) throw new PlanError("I need both where the files are and where they should go, for example 'move the PDFs in Downloads to Documents'.");
  if (!m.exts?.length && !m.name && !/\ball (the )?files\b|\beverything\b/i.test(part)) throw new PlanError("Which files? Name a type (like PDFs) or a file name, or say 'all files'.");
  return { op: kind, folder, match: m, dest };
}

const pathOk = (p: string, home: string) => isAbsolute(p) && p.toLowerCase().startsWith(home.toLowerCase());

export interface PlanOptions {
  home?: string;
  /** Task types to hand to Claude instead (when Claude is available): the open-ended ones rules plan poorly. */
  defer?: TaskType[];
  /** The answer of the previous task, for "write that in Notepad" as a follow-up. */
  previousAnswer?: string;
}

/**
 * Plans one instruction with jev's classification plus code extraction. `deferred` = some part is of a type in
 * `opts.defer`, so the caller should let Claude plan the whole instruction.
 */
export async function planWithJev(instruction: string, jev: JevExtra, apps: string[], opts: PlanOptions | string = {}): Promise<{ plan: Plan; tokens: number; ms: number; deferred: boolean }> {
  const o: PlanOptions = typeof opts === "string" ? { home: opts } : opts;
  const home = o.home ?? homedir();
  const t0 = performance.now();
  let tokens = 0;
  const subtasks: Subtask[] = [];
  const parts = splitParts(instruction);
  const done = (plan: Plan, deferred = false) => ({ plan, tokens, ms: Math.round(performance.now() - t0), deferred });
  for (const part of parts.slice(0, 5)) {
    const c: Classification = await jev.classify(part, apps);
    tokens += c.inputTokens;
    let type: TaskType = c.typeConf >= 0.3 ? c.type : "unclear";
    // A recognisable arithmetic expression is a calculation whatever the classifier said about the wording.
    const calc = calculation(part);
    if (type !== "calculate" && calc && /\b(calculat|comput|work out|what is|what's|calculator)/i.test(part)) type = "calculate";
    // Text to compose (a note, a poem) is Claude's job; without Claude, ask for the exact words.
    if (type === "write_text" && needsComposing(part)) {
      if (o.defer?.length) return done({ by: "jev+rules", subtasks: [], question: "" }, true);
      return done({ by: "jev+rules", subtasks: [], question: `What should it say? Put the exact text in quotes, for example: write "Thank you for a great term!" in Notepad.` });
    }
    if (o.defer?.includes(type)) return done({ by: "jev+rules", subtasks: [], question: "" }, true);
    // Without Claude: a general question is looked up on the web; a "what is this" needs the pointer.
    if (type === "chat") type = "web_question";
    if (type === "screen_question") {
      return done({ by: "jev+rules", subtasks: [], question: "To ask about something on the screen, point at it with the mouse, hold Ctrl and ask out loud (or type the question and press 'Point & ask' on the panel)." });
    }
    // Everyday requests with a direct results page (flights, directions, weather), however they were classified.
    let ready: Subtask | null = null;
    try { ready = ["web_question", "web_task", "open_app", "unclear"].includes(type) ? assistantPart(part) : null; }
    catch (e) { if (e instanceof PlanError) return done({ by: "jev+rules", subtasks: [], question: e.message }); throw e; }
    if (ready) { subtasks.push(ready); continue; }
    if (type === "unclear") {
      return done({ by: "jev+rules", subtasks: [], question: `I am not sure what to do with "${part}". Could you say it more specifically (which website, app, file or folder)?` });
    }
    try {
      const sub = partPlan(type, part, c, apps, home, subtasks.length > 0 || !!o.previousAnswer);
      if (sub.usePreviousAnswer && !subtasks.length && o.previousAnswer) {
        // "write that in Notepad" right after another task: the text is that task's answer.
        sub.values = sub.values.map(v => ({ ...v, text: v.text.replace("{previous answer}", o.previousAnswer!) }));
        if (sub.check?.kind === "field_equals") sub.check = { ...sub.check, expected: sub.check.expected.replace("{previous answer}", o.previousAnswer) };
        sub.usePreviousAnswer = false;
      }
      subtasks.push(sub);
    } catch (e) {
      if (e instanceof PlanError) return done({ by: "jev+rules", subtasks: [], question: e.message });
      throw e;
    }
  }
  return done({ by: "jev+rules", subtasks, question: "" });
}

function partPlan(type: TaskType, part: string, c: Classification, apps: string[], home: string, hasPrevious: boolean): Subtask {
  switch (type) {
    case "web_question": {
      const q = webQuery(part);
      return { surface: { kind: "browser", url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` }, goal: `The answer to "${q}" is visible on screen.`, values: [{ name: "search terms", text: q }], question: true };
    }
    case "web_task": {
      const url = siteUrl(part);
      const quoted = [...part.matchAll(/["“]([^"”]+)["”]/g)].map((m, i) => ({ name: `text ${i + 1}`, text: m[1] }));
      const forWhat = part.match(/\b(?:search(?: for)?|look (?:for|up)|find|play|watch|shop for)\s+(.+?)(?:\s+(?:on|in|at|using)\s+(?:the\s+)?(?:youtube|amazon|wikipedia|github|reddit|google maps|hacker news)\b.*)?$/i)?.[1];
      const values = quoted.length ? quoted : forWhat ? [{ name: "search terms", text: forWhat.replace(/^["“]|["”]$/g, "") }] : [];
      const search = values[0] ? siteSearchUrl(part, values[0].text) : undefined;
      if (search) {
        // The goal is the state to reach, not the instruction: "results are shown" is done on arrival.
        const site = new URL(search).hostname.replace(/^www\./, "");
        const goal = /\b(play|watch|listen to)\b/i.test(part) ? `A video or track for "${values[0].text}" is playing on ${site} (open the first matching result).`
          : /\b(open|click|go to|read)\b.*\b(first|top|best)\b/i.test(part) ? `${part} (the results for "${values[0].text}" are already open on ${site}).`
          : `Search results for "${values[0].text}" are shown on ${site}.`;
        return { surface: { kind: "browser", url: search }, goal, values };
      }
      if (!url) {
        const q = webQuery(part);
        return { surface: { kind: "browser", url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` }, goal: part, values: [{ name: "search terms", text: q }, ...values] };
      }
      return { surface: { kind: "browser", url }, goal: part, values };
    }
    case "calculate": {
      const calc = calculation(part);
      if (!calc) throw new PlanError("I could not read the numbers. Say it like 'calculate 128.5 times 12'.");
      const app = apps.find(a => /^calculator$/i.test(a)) ?? "Calculator";
      const check: Check = { kind: "display_equals", label: /^Display is /, expected: calc.expected };
      return { surface: { kind: "app", app }, goal: `Work out ${calc.expression} by pressing these Calculator buttons in this order: ${calc.buttons.join(", ")}. The display then shows the result.`, values: [], check };
    }
    case "write_text": {
      const app = c.app && c.appConf >= 0.4 && !/calculator/i.test(c.app) ? c.app : apps.find(a => /^notepad$/i.test(a)) ?? "Notepad";
      const { text, fromPrevious } = textToWrite(part);
      if (!text && !(fromPrevious && hasPrevious)) throw new PlanError("What text should I write? Put it in quotes, for example: write \"eggs, milk\" in Notepad.");
      return {
        surface: { kind: "app", app }, goal: `The text is written in ${app}.`, values: [{ name: "text to write", text: text || "{previous answer}" }],
        usePreviousAnswer: fromPrevious && hasPrevious, check: { kind: "field_equals", role: "text area", expected: text || "{previous answer}" },
      };
    }
    case "open_app": {
      if (!c.app || c.appConf < 0.4) throw new PlanError("Which app should I open? Use its name as it appears in the Start menu.");
      const quoted = [...part.matchAll(/["“]([^"”]+)["”]/g)].map((m, i) => ({ name: `text ${i + 1}`, text: m[1] }));
      return { surface: { kind: "app", app: c.app }, goal: part, values: quoted };
    }
    case "files": {
      const op = fileOp(c.fileOp ?? "list", part, home);
      for (const p of [("folder" in op ? op.folder : op.path), "dest" in op ? op.dest : undefined].filter(Boolean) as string[]) {
        if (!pathOk(p, home)) throw new PlanError(`For safety I only work inside your user folder (${home}); "${p}" is outside it.`);
      }
      return { surface: { kind: "files", op }, goal: part, values: [], question: op.op === "list" };
    }
    default:
      throw new PlanError(`I am not sure what to do with "${part}".`);
  }
}

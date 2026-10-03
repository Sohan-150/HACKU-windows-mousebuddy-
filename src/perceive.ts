// Observation -> numbered items the deciders choose from, plus the readable text on screen.
import type { Element, Item, Observation, Role } from "./contracts";

const ACTIONABLE: Role[] = ["text field", "text area", "pop-up", "option", "radio", "checkbox", "button", "link",
  "menu item", "tab", "list item", "tree item", "slider"];
const INPUTS: Role[] = ["text field", "text area", "pop-up", "radio", "checkbox", "slider"];
// The agent never minimises, maximises or closes the window it works in.
const WINDOW_CHROME = /^(minimi[sz]e|maximi[sz]e|restore|close|system)( .*)?$/i;

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const URL_VALUE = /^(?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?::\d+)?\/\S*$/i;
const words = (s: string) => new Set(norm(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2));

function stateOf(e: Element): string | undefined {
  if (e.role === "radio" || e.role === "checkbox") return e.checked ? "checked" : "not checked";
  if (e.role === "pop-up") return e.expanded ? "open" : undefined;
  if (e.role === "tab" || e.role === "option" || e.role === "list item") return e.selected ? "selected" : undefined;
  if (e.role === "text field" || e.role === "text area") return e.value ? "has text" : "empty";
  return undefined;
}

/**
 * Keeps labelled, actionable, on-screen controls (deduplicated by role+label), at most `cap`.
 * When there are too many (a long web page), inputs and buttons come first, then items sharing words with the goal,
 * then the rest in page order. Items are numbered in page order either way.
 */
export function perceive(obs: Observation, goal: string, cap = 80): { items: Item[]; dropped: number } {
  const seen = new Set<string>();
  const unlabelled: Record<string, number> = {};
  const cands: { e: Element; id: string; label: string; order: number }[] = [];
  for (const e of obs.elements) {
    if (!e.token || !ACTIONABLE.includes(e.role) || e.inView === false || e.enabled === false) continue;
    const label = norm(e.label ?? "");
    if (!label && !INPUTS.includes(e.role)) continue;
    if (WINDOW_CHROME.test(label) && (e.role === "button" || e.role === "menu item")) continue;
    // Apps built on an embedded browser (Spotify, Teams) expose its hidden address bar; typing there would navigate
    // the app away. The agent's own browser is driven through the page, so it never needs one either.
    if (obs.window.kind === "app" && /^(address and search bar|address bar|search or enter (web )?address)$/i.test(label)) continue;
    // The same bar under another name (Spotify calls it after the page, "Spotify – Search"): a field in an app whose
    // text is a web address.
    if (obs.window.kind === "app" && (e.role === "text field" || e.role === "text area") && URL_VALUE.test(String(e.value ?? "").trim())) continue;
    // Unlabelled inputs are told apart by their position among unlabelled inputs of the same role (stable across
    // snapshots, unlike element indexes, which move with focus).
    const id = label ? `${e.role}:${label.toLowerCase()}` : `${e.role}:#${(unlabelled[e.role] = (unlabelled[e.role] ?? 0) + 1)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    cands.push({ e, id, label: label || `(unlabelled ${e.role})`, order: cands.length });
  }
  let keep = cands;
  if (cands.length > cap) {
    const g = words(goal);
    const score = (c: typeof cands[number]) =>
      (INPUTS.includes(c.e.role) ? 4 : c.e.role === "button" ? 2 : 0) + [...words(c.label)].filter(w => g.has(w)).length * 3;
    keep = [...cands].sort((a, b) => score(b) - score(a) || a.order - b.order).slice(0, cap).sort((a, b) => a.order - b.order);
  }
  const items = keep.map((c, i) => ({
    i, id: c.id, role: c.e.role, text: c.label.slice(0, 120),
    value: c.e.value !== undefined && c.e.value !== "" ? String(c.e.value).slice(0, 200) : undefined,
    state: stateOf(c.e), token: c.e.token!,
  }));
  return { items, dropped: cands.length - keep.length };
}

/** Screen text, trimmed to a character budget (for the classifier a small one, for Claude a larger one). */
export function screenText(obs: Observation, maxChars: number): string[] {
  const out: string[] = [];
  let n = 0;
  for (const line of obs.text) {
    const l = line.slice(0, 300);
    if (n + l.length > maxChars) break;
    out.push(l); n += l.length;
  }
  return out;
}

/** Signature for stall detection: which controls exist, what they hold, and the visible text. */
export function signature(obs: Observation, items: Item[]): string {
  return JSON.stringify([obs.url ?? obs.title, items.map(i => [i.id, i.value ?? "", i.state ?? ""]), obs.text.slice(0, 40)]);
}

// ---------- finding the line that answers a question (ported from the Mac version) ----------

/** what an answer to the question LOOKS like ("what time" -> 8:00 p.m.), for lines that share no words with it */
const ANSWER_SHAPES: [RegExp, RegExp][] = [
  [/\bwhat time\b|\bwhen does\b|\bopening hours\b|\bopen until\b|\bstarts?\b|\bcloses?\b/i, /\b\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)|\b\d{1,2}:\d{2}\b|\bo'clock\b|\(\d{2}:\d{2}\)/i],
  [/\bhow much\b|\bprice\b|\bcost\b|\bfee\b|\bin (hong kong |us |hk )?dollars\b|\bexchange\b|\bstock\b/i, /[$¥€£]|\bHK\$|\b(HKD|USD|JPY|EUR|GBP|dollars?|yen)\b/i],
  [/\bhow (long|far)\b|\bduration\b|\bflight time\b|\bdistance\b|\btravel time\b/i, /\b\d+(\.\d+)?\s*(h|hr|hrs|hours?|min|mins|minutes?|km|kilomet(re|er)s?|miles?)\b/i],
  [/\bhow (tall|high)\b|\bheight\b|\belevation\b/i, /\b\d[\d,.]*\s*(m|metres?|meters?|ft|feet)\b/i],
  [/\bwhen\b|\byear\b|\bfounded\b|\bborn\b|\bbuilt\b/i, /\b(1[5-9]|20)\d{2}\b/],
  [/\bpopulation\b|\bhow many\b/i, /\b\d[\d,.]*\s*(million|billion|thousand|people|residents)?\b/i],
  [/\bweather\b|\btemperature\b/i, /°|\bdegrees?\b/i],
];

/** a question whose answer must contain a number ("how much", "what year", "the weather") */
export const NEEDS_NUMBER = /\b(how (many|much|tall|long|old|far)|population|year|when|price|cost|number|percent|temperature|weather|forecast)\b/i;

/** web pages split sentences across text runs: "… starts every night at" + "8:00 p.m. sharp" -> one line */
export function joinFragments(screen: string[]): string[] {
  const out: string[] = [];
  for (const line of screen) {
    const prev = out[out.length - 1];
    if (prev && /\b(at|is|are|was|from|of|by|to|around|about|approximately|until|costs?|takes?)$|[:–-]$/i.test(prev) && /^[\d$¥€£(]|^(HK\$|US\$)/.test(line) && line.length < 120) {
      out[out.length - 1] = `${prev} ${line}`;
    } else out.push(line);
  }
  return out;
}

const wordList = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** the n lines most useful for a goal, in page order: the first few (titles, displays) plus the ones sharing the most
 *  words with it, or shaped like its answer */
export function relevantLines(screen: string[], goal: string, n = 40, head = 12): string[] {
  if (screen.length <= n) return screen;
  const g = new Set(wordList(goal).filter(w => w.length > 2));
  const shapes = ANSWER_SHAPES.filter(([q]) => q.test(goal)).map(([, a]) => a);
  const scored = screen.map((line, i) => ({
    line, i,
    s: wordList(line).filter(w => g.has(w)).length + (/\d{3,4}/.test(line) ? 0.5 : 0) + (shapes.some(a => a.test(line)) ? 3 : 0),
  }));
  const pick = new Set<number>(scored.slice(0, head).map(x => x.i));
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (pick.size >= n) break;
    pick.add(x.i);
  }
  return scored.filter(x => pick.has(x.i)).map(x => x.line);
}

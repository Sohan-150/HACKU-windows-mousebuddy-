// A simulated desktop for `bun test`: a tiny web site (search -> results -> article) and Notepad-like apps.
// Same Driver interface as the real drivers; tokens go stale after each observation, like Cua's. Each hand has its own
// browser window and each app its own window, so parts can run in several at the same time.
import { HANDS, type ActSpec, type ActionResult, type Driver, type DriverCaps, type Element, type HandName, type Observation, type Role, type WindowSurface, type WindowRef } from "../contracts";
import { DriverError } from "./cli";

export interface SimControl { role: Role; label: string; value?: string; go?: string; submit?: (v: string) => string; risky?: boolean }
export interface SimPage { title: string; text: string[]; controls: SimControl[]; more?: string[] }

export const SITE: Record<string, SimPage> = {
  "https://search.test/": {
    title: "Search", text: ["Search the web"],
    controls: [{ role: "text field", label: "Search" }, { role: "button", label: "Search" }],
  },
  "https://search.test/?q=hku": {
    title: "hku - Search results", text: ["Results for hku"],
    controls: [{ role: "link", label: "The University of Hong Kong - Wikipedia", go: "https://wiki.test/HKU" }, { role: "link", label: "HKU official site", go: "https://hku.test/" }],
  },
  "https://wiki.test/HKU": {
    title: "The University of Hong Kong - Wikipedia", text: ["The University of Hong Kong", "HKU is a public research university in Hong Kong."],
    more: ["It was founded in 1911."], controls: [{ role: "link", label: "History" }],
  },
};

const APPS = ["Notepad", "Calculator", "Spotify"];      // each a plain text window here

export class SimDriver implements Driver {
  caps: DriverCaps = { platform: "sim", name: "simulated desktop" };
  doc = "";                          // the simulated Notepad document
  docs: Record<string, string> = {}; // the other apps' text
  snap = 0;
  log: ActSpec[] = [];
  private tabs = new Map<number, { url: string; values: Record<string, string>; scrolled: boolean }>();   // browser window -> page
  // Like Cua, a newer snapshot makes the older tokens of that window stale.
  private current = new Map<string, { snap: number; controls: SimControl[] }>();

  constructor(private site: Record<string, SimPage> = SITE, private faults: { dropTyping?: boolean } = {}) {}

  async ensureSession(): Promise<void> {}
  async keepAlive(): Promise<void> {}
  async endAll(): Promise<void> {}
  async listApps(): Promise<string[]> { return ["Calculator", "Notepad"]; }

  /** The first browser window's page, what was typed on it and whether it was scrolled (what most tests look at). */
  get url(): string { return this.tab(1).url; }
  get values(): Record<string, string> { return this.tab(1).values; }
  get scrolled(): boolean { return this.tab(1).scrolled; }
  set scrolled(v: boolean) { this.tab(1).scrolled = v; }

  async open(h: HandName, s: WindowSurface): Promise<WindowRef> {
    if (s.kind === "browser") {
      const id = HANDS.indexOf(h) + 1;           // one browser window per hand, like the agent's isolated browsers
      if (s.url) this.go(id, s.url);
      return { kind: "browser", pid: id, windowId: id, app: "SimBrowser", title: this.page(id).title };
    }
    const i = APPS.indexOf(s.app);
    if (i < 0) throw new DriverError("window_lost", `no app ${s.app}`);
    this.setDoc(s.app, "");
    return { kind: "app", pid: 100 + i, windowId: 100 + i, app: s.app, title: `Untitled - ${s.app}` };
  }

  private tab(id: number) {
    let t = this.tabs.get(id);
    if (!t) { t = { url: "", values: {}, scrolled: false }; this.tabs.set(id, t); }
    return t;
  }
  private go(id: number, url: string) { this.tabs.set(id, { url, values: {}, scrolled: false }); }
  private page(id: number): SimPage { const url = this.tab(id).url; return this.site[url] ?? { title: "Not found", text: [`404: ${url}`], controls: [] }; }
  private getDoc(app: string) { return app === "Notepad" ? this.doc : this.docs[app] ?? ""; }
  private setDoc(app: string, text: string) { if (app === "Notepad") this.doc = text; else this.docs[app] = text; }

  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    this.snap++;
    const doc = w.kind === "app" ? this.getDoc(w.app) : "", tab = this.tab(w.windowId);
    const controls = w.kind === "app" ? [{ role: "text area", label: "Text editor", value: doc }, { role: "button", label: "Save", risky: true }] as SimControl[] : this.page(w.windowId).controls;
    const key = `${w.kind}${w.windowId}`;
    this.current.set(key, { snap: this.snap, controls });
    const elements: Element[] = controls.map((c, i) => ({
      index: i, token: `${key}-${this.snap}:${i}`, role: c.role, label: c.label,
      value: c.role === "text field" || c.role === "text area" ? (w.kind === "app" ? doc : tab.values[c.label] ?? "") : undefined, inView: true,
    }));
    const p = this.page(w.windowId);
    const text = w.kind === "app" ? [`${doc.length} characters`] : [...p.text, ...(tab.scrolled ? p.more ?? [] : [])];
    return { hand, t: new Date().toISOString(), window: w, title: w.kind === "app" ? `Untitled - ${w.app}` : p.title, url: w.kind === "browser" ? tab.url : undefined, elements, text, truncated: false, ms: 1 };
  }

  async act(_h: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    this.log.push(a);
    const ok: ActionResult = { ok: true, effect: "unverifiable", ms: 1, cli: `sim ${a.tool}` };
    const id = w.windowId, tab = this.tab(id);
    if (a.tool === "navigate") { this.go(id, a.url); return ok; }
    if (a.tool === "scroll") { tab.scrolled = true; return ok; }
    const c = "token" in a && a.token ? this.control(w, a.token) : undefined;
    if ("token" in a && a.token && !c) return { ...ok, ok: false, error: { code: "stale", hint: "token from an older snapshot" } };
    if (a.tool === "type") {
      if (this.faults.dropTyping) return ok;
      if (w.kind === "app") this.setDoc(w.app, a.text); else tab.values[c!.label] = a.text;
      return ok;
    }
    if (a.tool === "key") {
      if (a.key === "enter" && c?.role === "text field" && tab.url === "https://search.test/") { this.go(id, `https://search.test/?q=${encodeURIComponent(tab.values[c.label] ?? "")}`); }
      return ok;
    }
    if (a.tool === "click") {
      if (c!.go) this.go(id, c!.go);
      else if (c!.label === "Search" && c!.role === "button") this.go(id, `https://search.test/?q=${encodeURIComponent(tab.values.Search ?? "")}`);
      return ok;
    }
    return ok;
  }

  private control(w: WindowRef, token: string): SimControl | undefined {
    const key = `${w.kind}${w.windowId}`, [snap, i] = token.split(":"), cur = this.current.get(key);
    return cur && snap === `${key}-${cur.snap}` ? cur.controls[Number(i)] : undefined;
  }
}

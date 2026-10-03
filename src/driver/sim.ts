// A simulated desktop for `bun test`: a tiny web site (search -> results -> article) and a Notepad-like app.
// Same Driver interface as the real drivers; tokens go stale after each observation, like Cua's.
import type { ActSpec, ActionResult, Driver, DriverCaps, Element, HandName, Observation, Role, WindowSurface, WindowRef } from "../contracts";
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

export class SimDriver implements Driver {
  caps: DriverCaps = { platform: "sim", name: "simulated desktop" };
  url = "";
  values: Record<string, string> = {};
  scrolled = false;
  doc = "";                          // the simulated Notepad document
  snap = 0;
  log: ActSpec[] = [];
  private current: SimControl[] = [];

  constructor(private site: Record<string, SimPage> = SITE, private faults: { dropTyping?: boolean } = {}) {}

  async ensureSession(): Promise<void> {}
  async keepAlive(): Promise<void> {}
  async endAll(): Promise<void> {}
  async listApps(): Promise<string[]> { return ["Calculator", "Notepad"]; }

  async open(_h: HandName, s: WindowSurface): Promise<WindowRef> {
    if (s.kind === "browser") {
      if (s.url) this.go(s.url);
      return { kind: "browser", pid: 1, windowId: 1, app: "SimBrowser", title: this.page().title };
    }
    if (s.app !== "Notepad") throw new DriverError("window_lost", `no app ${s.app}`);
    this.doc = "";
    return { kind: "app", pid: 2, windowId: 2, app: "Notepad", title: "Untitled - Notepad" };
  }

  private go(url: string) { this.url = url; this.values = {}; this.scrolled = false; }
  private page(): SimPage { return this.site[this.url] ?? { title: "Not found", text: [`404: ${this.url}`], controls: [] }; }

  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    this.snap++;
    if (w.kind === "app") {
      this.current = [{ role: "text area", label: "Text editor", value: this.doc }, { role: "button", label: "Save", risky: true }];
    } else {
      this.current = this.page().controls;
    }
    const elements: Element[] = this.current.map((c, i) => ({
      index: i, token: `s${this.snap}:${i}`, role: c.role, label: c.label,
      value: c.role === "text field" || c.role === "text area" ? (w.kind === "app" ? this.doc : this.values[c.label] ?? "") : undefined, inView: true,
    }));
    const p = this.page();
    const text = w.kind === "app" ? [`${this.doc.length} characters`] : [...p.text, ...(this.scrolled ? p.more ?? [] : [])];
    return { hand, t: new Date().toISOString(), window: w, title: w.kind === "app" ? "Untitled - Notepad" : p.title, url: w.kind === "browser" ? this.url : undefined, elements, text, truncated: false, ms: 1 };
  }

  async act(_h: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    this.log.push(a);
    const ok: ActionResult = { ok: true, effect: "unverifiable", ms: 1, cli: `sim ${a.tool}` };
    if (a.tool === "navigate") { this.go(a.url); return ok; }
    if (a.tool === "scroll") { this.scrolled = true; return ok; }
    const c = "token" in a && a.token ? this.control(a.token) : undefined;
    if ("token" in a && a.token && !c) return { ...ok, ok: false, error: { code: "stale", hint: "token from an older snapshot" } };
    if (a.tool === "type") {
      if (this.faults.dropTyping) return ok;
      if (w.kind === "app") this.doc = a.text; else this.values[c!.label] = a.text;
      return ok;
    }
    if (a.tool === "key") {
      if (a.key === "enter" && c?.role === "text field" && this.url === "https://search.test/") { this.go(`https://search.test/?q=${encodeURIComponent(this.values[c.label] ?? "")}`); }
      return ok;
    }
    if (a.tool === "click") {
      if (c!.go) this.go(c!.go);
      else if (c!.label === "Search" && c!.role === "button") this.go(`https://search.test/?q=${encodeURIComponent(this.values.Search ?? "")}`);
      return ok;
    }
    return ok;
  }

  private control(token: string): SimControl | undefined {
    const [snap, i] = token.split(":");
    return snap === `s${this.snap}` ? this.current[Number(i)] : undefined;
  }
}

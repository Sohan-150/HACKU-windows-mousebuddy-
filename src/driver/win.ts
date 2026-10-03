// Windows driver (Cua Driver 0.32.0). Two surfaces, both driven in the background:
//  - browser: the agent's own Chrome/Edge with a throwaway profile (browser route: get_browser_state / browser_type / browser_click)
//  - app:     any desktop app through UI Automation (get_window_state / click / set_value / type_text / press_key)
// Measured on this laptop (evidence/): another app stayed in front during every action on both surfaces.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HANDS, type ActionNote, type ActSpec, type ActionResult, type Driver, type DriverCaps, type Element, type HandName, type Observation, type WindowSurface, type WindowRef } from "../contracts";
import { FastLane, type FastRead } from "../fastlane";
import { cuaCall, cuaText, DriverError, errorOf, merge, toResult } from "./cli";
import { browserRole, uiaRole } from "./roles";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** app and window names can carry invisible direction marks ("\u200eWhatsApp"): the name the user types has none */
export const cleanName = (s: unknown) => String(s ?? "").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
/** an app's windows the agent can use, biggest first (an app's small helper windows are not its window) */
const byArea = (a: any, b: any) => (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) - (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0) || (b.z_index ?? 0) - (a.z_index ?? 0);
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const STATE = join(import.meta.dir, "..", "..", "runs", "agent-browser.json");

/** semantic_v2 snapshot -> Observation. Exported so tests run it on recorded snapshots. */
export function browserObservation(d: any, w: WindowRef, hand: HandName, ms: number): Observation {
  // refs come in Cua's ranking order, which moves with focus; the outline is in page order.
  const outline: string = d.outline ?? "";
  const pos = (r: any) => { const i = outline.indexOf(`${r.role} "${r.name ?? ""}"`); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const elements: Element[] = [...(d.refs ?? [])].sort((a, b) => pos(a) - pos(b)).map((r: any, index: number) => {
    // Search boxes are often ARIA comboboxes (Google, Wikipedia): one that takes typing is a text field to us.
    const typeable = (r.actions ?? []).includes("type") && ["combobox", "searchbox", "textbox"].includes(lc(r.role));
    const role = typeable ? "text field" : browserRole(r.role), st = r.states ?? {};
    return {
      index, token: r.ref, role, rawRole: r.role, label: r.name ?? undefined,
      value: r.value ?? (role === "text field" || role === "text area" ? "" : undefined),
      actions: r.actions, checked: st.checked === true || st.checked === "true", selected: st.selected === true,
      expanded: st.expanded === true, enabled: st.disabled !== true,
      inView: r.visibility === "in_viewport" || r.visibility === "near_viewport",
    };
  });
  return {
    hand, t: new Date().toISOString(), window: { ...w, title: d.page?.title ?? w.title }, title: d.page?.title ?? w.title,
    url: d.page?.url, elements, text: pageText(d), truncated: d.snapshot ? !d.snapshot.complete : false, ms,
  };
}

/**
 * Readable text in page order: headings, paragraphs and other text, plus long link texts. Search result pages put
 * their snippets inside links ("Established in 1911, the University of Hong Kong..."), so links with sentence-length
 * text count as text too.
 */
export function pageText(d: any): string[] {
  const outline: string = d.outline ?? "";
  const pos = (r: any) => { const i = outline.indexOf(`${r.role} "${r.name ?? ""}"`); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  const texts = [...(d.content_refs ?? [])].filter((c: any) => c.name && ["heading", "statictext", "paragraph", "cell", "listitem", "blockquote", "caption"].includes(lc(c.role)));
  const longLinks = [...(d.refs ?? [])].filter((r: any) => lc(r.role) === "link" && String(r.name ?? "").length >= 30);
  return dedupe([...texts, ...longLinks].sort((a, b) => pos(a) - pos(b)).map((c: any) => String(c.name).trim()));
}

/** A fast read (UI Automation, one cached call in the warm helper) in the shape of Cua's get_window_state; its tokens
 *  ("uia:<window>:<read>:<index>") are acted on by reference. Exported for tests. */
export function uiaWindowState(r: FastRead, hwnd: number): any {
  return {
    window_title: r.title,
    truncated: (r.elements?.length ?? 0) >= 1500,
    elements: (r.elements ?? []).map(e => ({
      element_index: e.i, element_token: `uia:${hwnd}:${r.seq}:${e.i}`, role: e.role, label: e.name || undefined, value: e.value,
      toggle_state: e.toggle, selected: e.selected === true, enabled: e.enabled !== false, frame: { x: e.x, y: e.y, w: e.w, h: e.h },
    })),
  };
}

/** get_window_state (UI Automation) -> Observation. */
export function appObservation(d: any, w: WindowRef, hand: HandName, ms: number): Observation {
  const elements: Element[] = (d.elements ?? []).map((e: any) => ({
    index: e.element_index, token: e.element_token, role: uiaRole(e.role), rawRole: e.role,
    label: e.label ?? undefined, value: e.value ?? undefined, actions: e.actions,
    checked: e.toggle_state === "on" || e.checked === true, selected: e.selected === true, enabled: e.enabled !== false, inView: true,
  }));
  const text = elements.filter(e => (e.role === "text" || e.role === "heading") && e.label).map(e => e.label!.trim());
  return {
    hand, t: new Date().toISOString(), window: { ...w, title: d.window_title ?? w.title }, title: d.window_title ?? w.title,
    elements, text: dedupe(text), truncated: d.truncated === true, ms,
  };
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  return lines.filter(l => l && !seen.has(l) && (seen.add(l), true));
}

export class WinDriver implements Driver {
  caps: DriverCaps = { platform: "win32", name: "Windows (Cua 0.32.0: browser route + UI Automation)" };
  /** presses and native text inserts straight through UI Automation; Cua for everything else and as the fallback */
  readonly fast = new FastLane();
  readonly counts = { fast: 0, cua: 0, fellBack: 0 };
  /** apps where the fast lane missed twice in a row: Cua does their actions directly, without paying for a failed try */
  private fastMisses = new Map<string, number>();
  /** windows to read with Cua next time (a fast action could not be done: Cua's tokens are needed), and fast reads that failed */
  private cuaNext = new Set<number>();
  private readMisses = new Map<number, number>();
  /** what each app element token pointed at when it was read: lets the fast lane find the same element */
  private seen = new Map<string, { pid: number; hwnd: number; role: string; label?: string; frame?: { x: number; y: number; w: number; h: number } }>();
  onAction?: (n: ActionNote) => void;
  private apps?: string[];
  private launchInfo = new Map<string, { aumid?: string; path?: string }>();
  // The agent's browser pid, remembered across restarts so a restart reuses it instead of opening another.
  private browserPid = new Map<HandName, number>(
    existsSync(STATE) ? Object.entries(JSON.parse(readFileSync(STATE, "utf8"))) as [HandName, number][] : []);

  /** every window, with invisible direction marks taken out of titles and app names */
  private async windows(hand: HandName, args: object = {}): Promise<any[]> {
    const ws: any[] = (await cuaCall("list_windows", { session: hand, ...args })).data?.windows ?? [];
    for (const w of ws) { w.title = cleanName(w.title); w.app_name = cleanName(w.app_name); }
    return ws;
  }

  async ensureSession(hand: HandName): Promise<void> {
    const r = await cuaCall("start_session", { session: hand });
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    // Cursor tuning was the Mac's biggest speed win (2.4 s -> 0.6 s per click). Shown again if it was hidden when idle.
    await Promise.all([
      cuaCall("set_agent_cursor_motion", { session: hand, glide_duration_ms: 150, dwell_after_click_ms: 0 }),
      cuaCall("set_agent_cursor_enabled", { session: hand, enabled: true }, 5_000),
    ]);
  }

  /** Measured on 0.32.0: get_session does NOT reset the 5-minute idle timer; start_session does (idempotent). */
  async keepAlive(hand: HandName): Promise<void> {
    await cuaCall("start_session", { session: hand }, 5_000);
  }

  async open(hand: HandName, s: WindowSurface): Promise<WindowRef> {
    return s.kind === "browser" ? this.openBrowser(hand, s.url) : this.openApp(hand, s.app, s.uri);
  }

  // ---------------- browser ----------------
  private async browserWindows(hand: HandName, pid: number): Promise<any[]> {
    const all = (await this.windows(hand, { pid })).filter((w: any) => w.pid === pid && w.title && w.bounds?.height > 100);
    // Bubbles such as "Restore pages?" are separate small windows: keep the real browser windows.
    const main = all.filter((w: any) => /(Google Chrome|Microsoft​? ?Edge|Chromium)$/.test(w.title));
    return main.length ? main : all.filter((w: any) => w.bounds.height > 300);
  }

  private async openBrowser(hand: HandName, url: string): Promise<WindowRef> {
    let pid = this.browserPid.get(hand);
    let wins = pid ? await this.browserWindows(hand, pid) : [];
    if (!wins.length) {
      // isolated_new launches a NEW browser on every call (measured), hence the remembered pid above.
      const prep = await cuaCall("browser_prepare", { session: hand, allow_launch: true, profile: { mode: "isolated_new" } }, 30_000);
      const perr = errorOf(prep.data);
      if (perr || !prep.data?.prepared_pid) throw new DriverError(perr?.code ?? "other", perr?.hint ?? "browser_prepare returned no pid");
      pid = prep.data.prepared_pid as number;
      this.browserPid.set(hand, pid);
      mkdirSync(dirname(STATE), { recursive: true });
      writeFileSync(STATE, JSON.stringify(Object.fromEntries(this.browserPid)));
      for (let i = 0; i < 15 && !wins.length; i++) { wins = await this.browserWindows(hand, pid); if (!wins.length) await sleep(300); }
    }
    const visible = wins.filter(w => !w.minimized);
    if (!wins.length) throw new DriverError("window_lost", "the agent browser has no window");
    if (!visible.length) throw new DriverError("minimized", "restore the agent browser window");
    const win = visible.sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
    const bind = await cuaCall("get_browser_state", { session: hand, pid: pid!, window_id: win.window_id });
    const berr = errorOf(bind.data);
    if (berr) throw new DriverError(berr.code, berr.hint);
    const tabs: any[] = bind.data.tabs ?? [];
    const tab = tabs.find(t => t.active) ?? tabs[0];
    if (!tab) throw new DriverError("stale", "the agent browser has no tab");
    const ref: WindowRef = { kind: "browser", pid: pid!, windowId: win.window_id, app: win.app_name ?? "browser", title: win.title, targetId: bind.data.target_id, tabId: tab.tab_id };
    if (url && tab.url !== url) {
      const nav = await cuaCall("browser_navigate", { session: hand, target_id: ref.targetId, tab_id: ref.tabId, url });
      const nerr = errorOf(nav.data);
      if (nerr) throw new DriverError(nerr.code, nerr.hint);
      await sleep(800);
    }
    return ref;
  }

  // ---------------- desktop apps ----------------
  async listApps(): Promise<string[]> {
    if (this.apps) return this.apps;
    const r = await cuaCall("list_apps", {}, 20_000);
    const names = new Map<string, string>();
    for (const a of r.data?.apps ?? []) {
      const name = cleanName(a.name);
      if (!name || /\.exe$|!|\\/.test(name) || names.has(name.toLowerCase())) continue;
      names.set(name.toLowerCase(), name);
      // Packaged apps launch by AUMID, desktop apps by list_apps' launch path; a display name alone may not resolve.
      const lp: string | undefined = a.launch_path ?? undefined;
      const prefix = "shell:appsFolder\\";
      const aumid = lp?.startsWith(prefix) ? lp.slice(prefix.length) : undefined;
      this.launchInfo.set(name.toLowerCase(), { aumid, path: aumid ? undefined : lp });
    }
    this.apps = [...names.values()].sort().slice(0, 300);
    return this.apps;
  }

  /** The same app's current window when ours is gone (Word replaces its start window with the document window). */
  async rebind(hand: HandName, w: WindowRef): Promise<WindowRef | null> {
    if (w.kind !== "app") return null;
    const want = lc(w.app).replace(/\.exe$/, "").replace(/\b(windows|microsoft)\b/g, "").trim() || lc(w.app);
    const wins: any[] = (await this.windows(hand)).filter((x: any) => x.title && x.bounds?.height > 100 && !x.minimized);
    // the app's own process first; a title match only outside browsers (a tab titled "Spotify - Web Player" in the
    // user's Chrome is not Spotify)
    const browser = /^(chrome|msedge|firefox|brave|opera|vivaldi|iexplore)(\.exe)?$/i;
    const pick = wins.filter(x => x.pid === w.pid).sort(byArea)[0]
      ?? wins.filter(x => lc(x.app_name).replace(/\.exe$/, "").includes(want.replace(/\s+/g, ""))).sort(byArea)[0]
      ?? wins.filter(x => lc(x.title).includes(want) && (!browser.test(x.app_name ?? "") || browser.test(want))).sort(byArea)[0];
    return pick ? { kind: "app", pid: pick.pid, windowId: pick.window_id, app: w.app, title: pick.title } : null;
  }

  private async openApp(hand: HandName, app: string, uri?: string): Promise<WindowRef> {
    const before = new Set<number>((await this.windows(hand)).map((w: any) => w.window_id));
    if (uri) {
      // A link the app handles itself (spotify:search:..., a game launcher's launch link): opens the app, or the running
      // one, at that place. Its window is taken as soon as it is there (it was a fixed 2.5 s wait).
      openLink(uri);
      for (let i = 0; i < 16; i++) {
        await sleep(i ? 300 : 700);
        const w = await this.rebind(hand, { kind: "app", pid: -1, windowId: -1, app, title: "" });
        if (w) { if (i < 3) await sleep(500); return w; }   // a running app may still be switching to the link's page
      }
    }
    // Already open (Discord, Spotify, WhatsApp, Calculator): use its window instead of starting it again, which costs
    // seconds and can bring it to the front. Text editors get a fresh window or tab, so the user's text is never typed into.
    if (!/notepad|wordpad|textedit|word\b/i.test(app)) {
      const open = await this.rebind(hand, { kind: "app", pid: -1, windowId: -1, app, title: "" }).catch(() => null);
      if (open) return open;
    }
    // Launching gives a fresh window or tab where the app supports it (e.g. a new Notepad tab), instead of typing
    // into a document the user already has open. Packaged apps may take the foreground once while starting.
    if (!this.apps) await this.listApps().catch(() => {});
    const info = this.launchInfo.get(lc(app));
    const how = info?.aumid ? { aumid: info.aumid } : info?.path ? { launch_path: info.path } : { name: app };
    let la = await cuaCall("launch_app", { session: hand, ...how }, 30_000);
    let lerr = errorOf(la.data);
    // A broken packaged entry ("does not support the contract specified", seen with VS Code): try the name, then the
    // app's Start Menu or desktop shortcut, the way a person would start it.
    if (lerr && !("name" in how)) {
      const byName = await cuaCall("launch_app", { session: hand, name: app }, 30_000);
      if (!errorOf(byName.data)) { la = byName; lerr = undefined; }
    }
    if (lerr) {
      const lnk = findShortcut(app);
      if (!lnk) throw new DriverError(lerr.code, `could not start '${app}': ${lerr.hint ?? ""}`);
      Bun.spawn(["explorer.exe", lnk], { stdout: "ignore", stderr: "ignore" });
      la = { ...la, data: {} };
    }
    // Match windows on the meaningful words of the name: "Windows Notepad" -> "notepad".
    const want = lc(app).replace(/\.exe$/, "").replace(/\b(windows|microsoft)\b/g, "").trim() || lc(app);
    const named = (w: any) => lc(w.title).includes(want) || lc(w.app_name).includes(want);
    let reopened = false, restored = false;
    for (let i = 0; i < 40; i++) {
      const all = (await this.windows(hand)).filter((w: any) => w.title && w.bounds?.height > 100);
      const wins = all.filter((w: any) => !w.minimized);
      const launched = (la.data?.windows ?? []).map((w: any) => w.window_id);
      const pick = wins.find(w => launched.includes(w.window_id))
        ?? wins.filter(w => w.pid === la.data?.pid).sort(byArea)[0]
        ?? wins.filter(w => !before.has(w.window_id) && named(w)).sort(byArea)[0]
        ?? wins.filter(named).sort(byArea)[0];
      if (pick) return { kind: "app", pid: pick.pid, windowId: pick.window_id, app, title: pick.title };
      // its window is minimised: show it again without taking the foreground
      const small = all.filter(w => w.minimized && (w.pid === la.data?.pid || named(w))).sort(byArea)[0];
      if (small && !restored && this.fast.on) { restored = true; await this.fast.restore(small.window_id).catch(() => {}); }
      // running with no window at all (closed to the tray, like Discord, Spotify or WhatsApp): start it again from its
      // shortcut, which shows its window (as clicking it in the Start menu would)
      if (i === 12 && !reopened) {
        reopened = true;
        const lnk = findShortcut(app);
        if (lnk) Bun.spawn(["explorer.exe", lnk], { stdout: "ignore", stderr: "ignore" });
      }
      await sleep(400);
    }
    throw new DriverError("window_lost", `'${app}' started but no window appeared (is it hidden in the tray, or on another desktop?)`);
  }

  // ---------------- observe / act ----------------
  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    if (w.kind === "browser") {
      const r = await cuaCall("get_browser_state", { session: hand, target_id: w.targetId, tab_id: w.tabId, snapshot_format: "semantic_v2" });
      const err = errorOf(r.data);
      if (err) throw new DriverError(err.code, err.hint);
      return browserObservation(r.data, w, hand, r.ms);
    }
    // Fast read first: every control in one cached UI Automation call from the warm helper (Cua's read walks the tree
    // control by control in a new process each time: seconds for Discord or Spotify). Cua when it can't.
    if (this.fast.on && !this.cuaNext.has(w.windowId) && (this.readMisses.get(w.windowId) ?? 0) < 2) {
      const fr = await this.fast.read(w.windowId);
      if (fr.ok && fr.elements?.length) {
        this.readMisses.set(w.windowId, 0);
        const d = uiaWindowState(fr, w.windowId);
        for (const e of d.elements) this.seen.set(e.element_token, { pid: w.pid, hwnd: w.windowId, role: String(e.role ?? ""), label: e.label, frame: e.frame });
        return appObservation(d, w, hand, Math.round(fr.ms));
      }
      this.readMisses.set(w.windowId, (this.readMisses.get(w.windowId) ?? 0) + 1);
      console.log(`[fast lane] read of "${w.title}" -> Cua (${fr.error ?? "no controls"})`);
    }
    this.cuaNext.delete(w.windowId);
    // Apps built on a web view (Spotify, Teams) report hundreds of controls; without a higher cap the ones at the end
    // (Spotify's player bar with its Pause button) are cut off. perceive() still keeps at most 120 for the deciders.
    const r = await cuaCall("get_window_state", { session: hand, pid: w.pid, window_id: w.windowId, include_screenshot: false, timeout_ms: 4000, max_elements: 1000 }, 15_000);
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    for (const e of r.data.elements ?? []) {
      if (e.element_token) this.seen.set(e.element_token, { pid: w.pid, hwnd: w.windowId, role: String(e.role ?? ""), label: e.label ?? undefined, frame: e.frame ?? undefined });
    }
    if (this.seen.size > 20_000) this.seen = new Map([...this.seen].slice(-5000));
    return appObservation(r.data, w, hand, r.ms);
  }

  fastLane() { return { on: this.fast.on, reason: this.fast.reason, ...this.counts }; }

  /** try the fast lane; undefined = do it through Cua (the fast lane is off, or couldn't do it safely) */
  private async tryFast(hand: HandName, token: string, kind: "press" | "type", text?: string): Promise<ActionResult | undefined> {
    const el = this.seen.get(token);
    if (!this.fast.on || !el?.frame || !el.role) return undefined;
    const appKey = `${el.pid}:${el.hwnd}`;
    if ((this.fastMisses.get(appKey) ?? 0) >= 2) return undefined;
    const t = { pid: el.pid, hwnd: el.hwnd, frame: el.frame, role: el.role, label: el.label };
    const r = kind === "press" ? await this.fast.press(t) : await this.fast.type(t, text ?? "");
    const cli = `fastlane ${kind} ${el.role} "${el.label ?? ""}"${kind === "type" ? ` "${(text ?? "").slice(0, 40)}"` : ""}`;
    if (!r.ok) {
      this.counts.fellBack++;
      const misses = (this.fastMisses.get(appKey) ?? 0) + 1;
      this.fastMisses.set(appKey, misses);
      console.log(`[fast lane] ${cli} -> Cua (${r.error})${misses >= 2 ? `; Cua does this app's actions from now on` : ""}`);
      return undefined;
    }
    this.fastMisses.set(appKey, 0);
    this.counts.fast++;
    this.onAction?.({ hand, pid: el.pid, frame: el.frame, kind, via: "fast" });
    return { ok: true, route: "fast_lane", effect: r.how, ms: Math.round(r.ms), cli };
  }

  /** press or type on a control from a fast read, by reference (no search) */
  private async byRef(hand: HandName, w: WindowRef, token: string, kind: "press" | "type", text?: string): Promise<ActionResult> {
    const ref = token.slice(4);
    const r = kind === "press" ? await this.fast.pressRef(ref) : await this.fast.typeRef(ref, text ?? "");
    const el = this.seen.get(token);
    const cli = `fastlane ${kind} ${el?.role ?? ""} "${el?.label ?? ""}"${kind === "type" ? ` "${(text ?? "").slice(0, 40)}"` : ""}`;
    if (!r.ok) { this.counts.fellBack++; console.log(`[fast lane] ${cli} -> Cua (${r.error})`); return this.viaCua(w, r.error ?? "not done"); }
    this.counts.fast++;
    if (el?.frame) this.onAction?.({ hand, pid: el.pid, frame: el.frame, kind, via: "fast" });
    return { ok: true, route: "fast_lane", effect: r.how, ms: Math.round(r.ms), cli };
  }

  /** the next read of this window is Cua's (its tokens let Cua do what the fast lane could not); the agent reads again */
  private viaCua(w: WindowRef, why: string): ActionResult {
    this.cuaNext.add(w.windowId);
    return { ok: false, ms: 0, cli: "", error: { code: "stale", hint: `${why}: reading the window with Cua for this step` } };
  }

  private noteCua(hand: HandName, token: string, kind: "press" | "type") {
    this.counts.cua++;
    const el = this.seen.get(token);
    if (el?.frame) this.onAction?.({ hand, pid: el.pid, frame: el.frame, kind, via: "cua" });
  }

  /**
   * More of the page's text than one step's snapshot holds (which is cut to what is on and near the screen): follows
   * the snapshot's continuation up to `pages` times. Used to read an answer off a long page. Makes earlier tokens stale.
   */
  async readMore(hand: HandName, w: WindowRef, pages = 4): Promise<string[]> {
    if (w.kind !== "browser") return [];
    // The whole page's text in one read-only call (~0.3 s for an 18 KB article), including what is off screen.
    // Snapshots (and their continuations and queries) leave off-screen content out, measured on Wikipedia.
    const whole = await cuaText("page", { session: hand, pid: w.pid, window_id: w.windowId, action: "get_text" });
    if (whole.ok) {
      const lines = whole.text.split(/\r?\n/).map(l => l.replace(/\uFFFC/g, "").trim()).filter(l => l.length >= 2);
      if (lines.length >= 5) return dedupe(lines);
    }
    const base = { session: hand, target_id: w.targetId, tab_id: w.tabId, snapshot_format: "semantic_v2" };
    const lines: string[] = [];
    let cont: string | undefined;
    for (let i = 0; i < pages; i++) {
      const r = await cuaCall("get_browser_state", { ...base, ...(cont ? { continuation: cont } : {}) });
      if (errorOf(r.data)) break;
      lines.push(...pageText(r.data));
      cont = r.data.snapshot?.continuation ?? undefined;
      if (!cont) break;
    }
    return dedupe(lines);
  }

  async followActiveTab(hand: HandName, w: WindowRef): Promise<WindowRef> {
    if (w.kind !== "browser") return w;
    const bind = await cuaCall("get_browser_state", { session: hand, pid: w.pid, window_id: w.windowId }, 6_000);
    if (errorOf(bind.data)) return w;
    const tabs: any[] = bind.data.tabs ?? [];
    const active = tabs.find(t => t.active);
    if (!active) return w;
    // A fresh bind mints a new target id; use it with the active tab (refs are re-read next step anyway).
    return { ...w, targetId: bind.data.target_id, tabId: active.tab_id };
  }

  async act(hand: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    return w.kind === "browser" ? this.actBrowser(hand, w, a) : this.actApp(hand, w, a);
  }

  private async actBrowser(hand: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    const base = { session: hand, target_id: w.targetId, tab_id: w.tabId };
    switch (a.tool) {
      case "click": return toResult(await cuaCall("browser_click", { ...base, ref: a.token }));
      // replace: select the field first so typing never appends to stale text
      case "type": return toResult(await cuaCall("browser_type", { ...base, ref: a.token, text: a.text, replace: true }));
      case "key": {
        if (a.key !== "enter" || !a.token) return unsupported(`key ${a.key} in the browser`);
        // Chrome drops window-message keys in the background; a CDP keystroke "\n" in the field works (measured).
        return toResult(await cuaCall("browser_type", { ...base, ref: a.token, text: "\n", mode: "keystrokes" }));
      }
      case "scroll":
        return toResult(await cuaCall("browser_pointer", { ...base, action: "scroll", x: 400, y: 300, delta_y: a.direction === "down" ? 700 : -700 }));
      case "navigate": {
        const r = await cuaCall("browser_navigate", { ...base, url: a.url });
        await sleep(800);
        return toResult(r);
      }
    }
  }

  private async actApp(hand: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    const base = { session: hand, pid: w.pid, window_id: w.windowId };
    switch (a.tool) {
      case "click": {
        if (a.token.startsWith("uia:")) return this.byRef(hand, w, a.token, "press");
        const fast = await this.tryFast(hand, a.token, "press");
        if (fast) return fast;
        this.noteCua(hand, a.token, "press");
        return toResult(await cuaCall("click", { ...base, element_token: a.token }));
      }
      case "type": {
        // The fast lane and set_value replace the content through the UIA ValuePattern; type_text inserts characters.
        if (a.token.startsWith("uia:")) return this.byRef(hand, w, a.token, "type", a.text);
        const fast = await this.tryFast(hand, a.token, "type", a.text);
        if (fast) return fast;
        this.noteCua(hand, a.token, "type");
        const set = await cuaCall("set_value", { ...base, element_token: a.token, value: a.text });
        const res = toResult(set);
        if (res.ok) return res;
        const typed = await cuaCall("type_text", { ...base, element_token: a.token, text: a.text });
        return merge([set, typed], toResult(typed));
      }
      case "key": {
        // a key goes to a control Cua knows: read the window with Cua for this step
        if (a.token?.startsWith("uia:")) return this.viaCua(w, "keys go through Cua");
        const key = { enter: "return", tab: "tab", escape: "escape", backspace: "delete", pagedown: "pagedown", pageup: "pageup" }[a.key];
        return toResult(await cuaCall("press_key", { ...base, key, ...(a.token ? { element_token: a.token } : {}) }));
      }
      case "scroll": return toResult(await cuaCall("scroll", { ...base, direction: a.direction, amount: 5 }));
      case "navigate": return unsupported("navigate in a desktop app");
    }
  }

  /** the hand is idle: its coloured cursor is hidden (Cua's set_agent_cursor_enabled), shown again when it next acts */
  async release(hand: HandName): Promise<void> {
    await cuaCall("set_agent_cursor_enabled", { session: hand, enabled: false }, 5_000);
  }

  async endAll(): Promise<void> {
    this.fast.stop();
    // Ending a session also closes its isolated browser, so this runs only on shutdown when asked.
    for (const hand of HANDS) await cuaCall("end_session", { session: hand }, 5_000);
  }
}

/** The Start Menu or desktop shortcut whose name best matches an app ("Visual Studio Code.lnk"). Exported for tests. */
export function findShortcut(app: string, dirs = shortcutDirs()): string | undefined {
  const want = app.toLowerCase().replace(/\.exe$/, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (!want) return undefined;
  let best: { path: string; score: number } | undefined;
  const walk = (dir: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      const full = join(dir, n);
      if (/\.lnk$/i.test(n)) {
        const have = n.slice(0, -4).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        // exact name first, then a shortcut named inside the app's name or the other way round; never uninstallers
        const score = /uninstall|readme|help|website/.test(have) ? 0 : have === want ? 3 : have.startsWith(want) || want.startsWith(have) ? 2 : have.includes(want) ? 1 : 0;
        if (score && (!best || score > best.score)) best = { path: full, score };
      } else if (depth < 3 && !n.includes(".")) walk(full, depth + 1);
    }
  };
  for (const d of dirs) walk(d, 0);
  return best?.path;
}

function shortcutDirs(): string[] {
  const e = process.env;
  return [
    e.APPDATA && join(e.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    join(e.ProgramData ?? "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
    e.USERPROFILE && join(e.USERPROFILE, "Desktop"),
    join(e.PUBLIC ?? "C:\\Users\\Public", "Desktop"),
  ].filter((d): d is string => !!d);
}

/**
 * Opens a link with the app registered for it. Through an Internet shortcut file (what Epic's own desktop shortcuts
 * are), so nothing in the link is read by cmd: "&" in "?action=launch&silent=true" would otherwise end the command.
 */
export function openLink(uri: string): void {
  const file = join(tmpdir(), `agent-link-${Date.now()}.url`);
  writeFileSync(file, `[InternetShortcut]\r\nURL=${uri.trim().replace(/ /g, "%20")}\r\n`);
  Bun.spawn(["cmd", "/c", "start", "", file], { stdout: "ignore", stderr: "ignore" });
  setTimeout(() => { try { unlinkSync(file); } catch { /* still open or gone */ } }, 15_000);
}

function unsupported(what: string): ActionResult {
  return { ok: false, ms: 0, cli: "", error: { code: "unsupported", hint: `${what} is not supported` } };
}

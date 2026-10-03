// Windows driver (Cua Driver 0.32.0). Two surfaces, both driven in the background:
//  - browser: the agent's own Chrome/Edge with a throwaway profile (browser route: get_browser_state / browser_type / browser_click)
//  - app:     any desktop app through UI Automation (get_window_state / click / set_value / type_text / press_key)
// Measured on this laptop (evidence/): another app stayed in front during every action on both surfaces.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ActSpec, ActionResult, Driver, DriverCaps, Element, HandName, Observation, WindowSurface, WindowRef } from "../contracts";
import { cuaCall, cuaText, DriverError, errorOf, merge, toResult } from "./cli";
import { browserRole, uiaRole } from "./roles";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
  private apps?: string[];
  private launchInfo = new Map<string, { aumid?: string; path?: string }>();
  // The agent's browser pid, remembered across restarts so a restart reuses it instead of opening another.
  private browserPid = new Map<HandName, number>(
    existsSync(STATE) ? Object.entries(JSON.parse(readFileSync(STATE, "utf8"))) as [HandName, number][] : []);

  async ensureSession(hand: HandName): Promise<void> {
    const r = await cuaCall("start_session", { session: hand });
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    // Cursor tuning was the Mac's biggest speed win (2.4 s -> 0.6 s per click).
    await cuaCall("set_agent_cursor_motion", { session: hand, glide_duration_ms: 150, dwell_after_click_ms: 0 });
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
    const lw = await cuaCall("list_windows", { session: hand, pid });
    const all = (lw.data?.windows ?? []).filter((w: any) => w.pid === pid && w.title && w.bounds?.height > 100);
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
      const name = String(a.name ?? "");
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
    const wins: any[] = ((await cuaCall("list_windows", { session: hand })).data?.windows ?? [])
      .filter((x: any) => x.title && x.bounds?.height > 100 && !x.minimized);
    const pick = wins.filter(x => x.pid === w.pid).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0]
      ?? wins.filter(x => lc(x.title).includes(want) || lc(x.app_name).includes(want)).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
    return pick ? { kind: "app", pid: pick.pid, windowId: pick.window_id, app: w.app, title: pick.title } : null;
  }

  private async openApp(hand: HandName, app: string, uri?: string): Promise<WindowRef> {
    const before = new Set<number>((await cuaCall("list_windows", { session: hand })).data?.windows?.map((w: any) => w.window_id) ?? []);
    if (uri) {
      // A link the app handles itself (spotify:search:...): opens the app, or the running one, at that place.
      Bun.spawn(["cmd", "/c", "start", "", uri], { stdout: "ignore", stderr: "ignore" });
      await sleep(2500);
      const w = await this.rebind(hand, { kind: "app", pid: -1, windowId: -1, app, title: "" });
      if (w) return w;
    }
    // Launching gives a fresh window or tab where the app supports it (e.g. a new Notepad tab), instead of typing
    // into a document the user already has open. Packaged apps may take the foreground once while starting.
    if (!this.apps) await this.listApps().catch(() => {});
    const info = this.launchInfo.get(lc(app));
    const how = info?.aumid ? { aumid: info.aumid } : info?.path ? { launch_path: info.path } : { name: app };
    const la = await cuaCall("launch_app", { session: hand, ...how }, 30_000);
    const lerr = errorOf(la.data);
    if (lerr) throw new DriverError(lerr.code, `could not start '${app}': ${lerr.hint ?? ""}`);
    // Match windows on the meaningful words of the name: "Windows Notepad" -> "notepad".
    const want = lc(app).replace(/\.exe$/, "").replace(/\b(windows|microsoft)\b/g, "").trim() || lc(app);
    for (let i = 0; i < 20; i++) {
      const wins: any[] = ((await cuaCall("list_windows", { session: hand })).data?.windows ?? [])
        .filter((w: any) => w.title && w.bounds?.height > 100 && !w.minimized);
      const launched = (la.data?.windows ?? []).map((w: any) => w.window_id);
      const pick = wins.find(w => launched.includes(w.window_id))
        ?? wins.filter(w => w.pid === la.data?.pid).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0]
        ?? wins.filter(w => !before.has(w.window_id) && (lc(w.title).includes(want) || lc(w.app_name).includes(want)))[0]
        ?? wins.filter(w => lc(w.title).includes(want) || lc(w.app_name).includes(want)).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0))[0];
      if (pick) return { kind: "app", pid: pick.pid, windowId: pick.window_id, app, title: pick.title };
      await sleep(400);
    }
    throw new DriverError("window_lost", `'${app}' started but no window appeared`);
  }

  // ---------------- observe / act ----------------
  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    if (w.kind === "browser") {
      const r = await cuaCall("get_browser_state", { session: hand, target_id: w.targetId, tab_id: w.tabId, snapshot_format: "semantic_v2" });
      const err = errorOf(r.data);
      if (err) throw new DriverError(err.code, err.hint);
      return browserObservation(r.data, w, hand, r.ms);
    }
    const r = await cuaCall("get_window_state", { session: hand, pid: w.pid, window_id: w.windowId, include_screenshot: false, timeout_ms: 4000 });
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    return appObservation(r.data, w, hand, r.ms);
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
      case "click": return toResult(await cuaCall("click", { ...base, element_token: a.token }));
      case "type": {
        // set_value replaces the content through the UIA ValuePattern; type_text inserts characters.
        const set = await cuaCall("set_value", { ...base, element_token: a.token, value: a.text });
        const res = toResult(set);
        if (res.ok) return res;
        const typed = await cuaCall("type_text", { ...base, element_token: a.token, text: a.text });
        return merge([set, typed], toResult(typed));
      }
      case "key": {
        const key = { enter: "return", tab: "tab", escape: "escape", backspace: "delete", pagedown: "pagedown", pageup: "pageup" }[a.key];
        return toResult(await cuaCall("press_key", { ...base, key, ...(a.token ? { element_token: a.token } : {}) }));
      }
      case "scroll": return toResult(await cuaCall("scroll", { ...base, direction: a.direction, amount: 5 }));
      case "navigate": return unsupported("navigate in a desktop app");
    }
  }

  async endAll(): Promise<void> {
    // Ending a session also closes its isolated browser, so this runs only on shutdown when asked.
    for (const hand of ["Mint-3", "Red-7", "Blue-9"]) await cuaCall("end_session", { session: hand }, 5_000);
  }
}

function unsupported(what: string): ActionResult {
  return { ok: false, ms: 0, cli: "", error: { code: "unsupported", hint: `${what} is not supported` } };
}

// macOS driver (Cua Driver 0.32.0, accessibility route). NOT RUN on a Mac yet: written from the Mac gate measurements
// (hands-research/research-live-gates.md). Browser surface = Safari (one window; AutoFill off). App surface = any app.
// Measured Mac rules kept here: one get_window_state per step, web-content elements only for Safari, type_text inserts
// (so a filled field is selected first with Edit > Select All), no set_value in Safari, no Back button, no Cmd shortcuts.
import { HANDS, type ActSpec, type ActionResult, type Driver, type DriverCaps, type Element, type HandName, type Observation, type WindowSurface, type WindowRef } from "../contracts";
import { cuaCall, DriverError, errorOf, merge, toResult } from "./cli";
import { axRole } from "./roles";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const SAFARI = "com.apple.Safari";

export class MacDriver implements Driver {
  caps: DriverCaps = { platform: "darwin", name: "macOS (Cua 0.32.0: accessibility; untested in this repo)" };
  private apps?: string[];

  async ensureSession(hand: HandName): Promise<void> {
    const r = await cuaCall("start_session", { session: hand });
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    await cuaCall("set_agent_cursor_motion", { session: hand, glide_duration_ms: 150, dwell_after_click_ms: 0 });
  }
  async keepAlive(hand: HandName): Promise<void> { await cuaCall("start_session", { session: hand }, 5_000); }

  async listApps(): Promise<string[]> {
    if (this.apps) return this.apps;
    const r = await cuaCall("list_apps", {}, 20_000);
    this.apps = [...new Set<string>((r.data?.apps ?? []).map((a: any) => String(a.name ?? "")).filter(Boolean))].sort().slice(0, 300);
    return this.apps;
  }

  private async windowsOf(hand: HandName, match: (w: any) => boolean): Promise<any[]> {
    const lw = await cuaCall("list_windows", { session: hand });
    // Ghost windows: titleless 1800x39 entries; other Spaces are unreachable through AX [Mac LIVE].
    return (lw.data?.windows ?? []).filter((w: any) => match(w) && w.title && w.bounds?.height > 100 && (w.is_on_screen || w.on_current_space));
  }

  async open(hand: HandName, s: WindowSurface): Promise<WindowRef> {
    if (s.kind === "browser") {
      let wins = await this.windowsOf(hand, w => w.app_name === "Safari");
      if (!wins.length || s.url) {
        const r = await cuaCall("launch_app", { bundle_id: SAFARI, ...(s.url ? { urls: [s.url] } : {}), session: hand }, 30_000);
        const err = errorOf(r.data);
        if (err) throw new DriverError(err.code, err.hint);
        await sleep(2500);
        wins = await this.windowsOf(hand, w => w.app_name === "Safari");
      }
      // Two Safari windows make background keyboard input ambiguous (refused) [Mac LIVE].
      if (wins.length !== 1) throw new DriverError("refused", `Safari needs exactly one window (has ${wins.length})`);
      return { kind: "browser", pid: wins[0].pid, windowId: wins[0].window_id, app: "Safari", title: wins[0].title };
    }
    const r = await cuaCall("launch_app", { name: s.app, session: hand }, 30_000);
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, `could not start '${s.app}': ${err.hint ?? ""}`);
    for (let i = 0; i < 20; i++) {
      const wins = await this.windowsOf(hand, w => w.pid === r.data?.pid || String(w.app_name).toLowerCase() === s.app.toLowerCase());
      if (wins.length) return { kind: "app", pid: wins[0].pid, windowId: wins[0].window_id, app: s.app, title: wins[0].title };
      await sleep(400);
    }
    throw new DriverError("window_lost", `'${s.app}' started but no window appeared`);
  }

  async observe(hand: HandName, w: WindowRef): Promise<Observation> {
    const r = await cuaCall("get_window_state", { pid: w.pid, window_id: w.windowId, session: hand, include_screenshot: false, timeout_ms: 3000 });
    const err = errorOf(r.data);
    if (err) throw new DriverError(err.code, err.hint);
    const d = r.data;
    const elements: Element[] = (d.elements ?? [])
      .filter((e: any) => w.kind !== "browser" || e.in_web_content === true)      // browser chrome can never be clicked
      .map((e: any) => ({
        index: e.element_index, token: e.element_token, role: axRole(e.role), rawRole: e.role,
        label: e.label ?? undefined, value: e.value ?? undefined, actions: e.actions, enabled: e.enabled !== false,
        checked: e.role === "AXRadioButton" || e.role === "AXCheckBox" ? String(e.value) === "1" : undefined, inView: true,
      }));
    const text = elements.filter(e => (e.role === "text" || e.role === "heading") && e.label).map(e => e.label!);
    return { hand, t: new Date().toISOString(), window: { ...w, title: d.window_title ?? w.title }, title: d.window_title ?? w.title, elements, text, truncated: d.truncated === true, ms: r.ms };
  }

  async act(hand: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult> {
    const base = { pid: w.pid, window_id: w.windowId, session: hand };
    switch (a.tool) {
      case "click": return toResult(await cuaCall("click", { ...base, element_token: a.token }));
      case "type": {
        // type_text inserts at the caret [Mac LIVE "Chan Tai ManLee Siu Ming"]: select everything in the field first.
        const sel = await cuaCall("invoke_menu", { ...base, path: ["Edit", "Select All"] });
        const typed = await cuaCall("type_text", { ...base, element_token: a.token, text: a.text });
        return merge([sel, typed], toResult(typed));
      }
      case "key": return toResult(await cuaCall("press_key", { ...base, key: a.key === "enter" ? "return" : a.key, ...(a.token ? { element_token: a.token } : {}) }));
      case "scroll": return toResult(await cuaCall("scroll", { ...base, direction: a.direction, amount: 5 }));
      case "navigate": {
        if (w.kind !== "browser") return { ok: false, ms: 0, cli: "", error: { code: "unsupported", hint: "navigate needs the browser" } };
        // No address bar in the background (Cmd-L fails): Safari opens the URL in its window via launch_app.
        return toResult(await cuaCall("launch_app", { bundle_id: SAFARI, urls: [a.url], session: hand }, 30_000));
      }
    }
  }

  async endAll(): Promise<void> {
    for (const hand of HANDS) await cuaCall("end_session", { session: hand }, 5_000);
  }
}

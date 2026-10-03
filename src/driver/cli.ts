// One `cua-driver call <tool> <json>` subprocess per call (review-technical §0.5): 0.02 s overhead on the Mac,
// every call is its own daemon connection, and every logged call can be pasted into a shell and replayed.
import { join } from "node:path";
import type { ActionResult, DriverErrorCode } from "../contracts";

export function cuaPath(): string {
  if (process.env.CUA_DRIVER) return process.env.CUA_DRIVER;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "Programs", "Cua", "cua-driver", "bin", "cua-driver.exe");
  }
  return "cua-driver";
}

/** The exact command, quoted so it can be pasted into this platform's usual shell. */
export function replayLine(tool: string, args: object, platform = process.platform): string {
  const json = JSON.stringify(args);
  if (platform === "win32") {
    // PowerShell: --% stops PowerShell parsing; \" survives the exe's own argument splitting.
    return `cua-driver call ${tool} --% "${json.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `cua-driver call ${tool} '${json.replace(/'/g, "'\\''")}'`;
}

/** Thrown by observe()/targetWindow() so the loop can turn it into a coded exception. */
export class DriverError extends Error {
  constructor(public code: DriverErrorCode, hint?: string) { super(hint ? `${code}: ${hint}` : code); }
}

export interface CallResult { data: any; ms: number; cli: string; exitCode: number | null; timedOut: boolean }

export async function cuaCall(tool: string, args: object, timeoutMs = 12_000): Promise<CallResult> {
  const cli = replayLine(tool, args);
  const t0 = performance.now();
  let proc;
  try {
    proc = Bun.spawn([cuaPath(), "call", tool, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return { data: { error: { code: "daemon_down", hint: `cannot start cua-driver: ${(e as Error).message}` } }, ms: 0, cli, exitCode: null, timedOut: false };
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  const ms = Math.round(performance.now() - t0);
  let data: any;
  try {
    data = JSON.parse(out);
  } catch {
    const raw = (out + err).trim();
    data = { _raw: raw.slice(0, 800) };
    if (timedOut) data.error = { code: "timeout", hint: `no answer in ${timeoutMs} ms` };
    // An ended session is reported as plain text: "session has ended; tool call '…' was rejected."
    else if (/session has ended/i.test(raw)) data.error = { code: "session_ended", hint: raw.slice(0, 300) };
    else if (/daemon is not running|connect|pipe|socket/i.test(raw)) data.error = { code: "daemon_down", hint: raw.slice(0, 300) };
    else data.error = { code: "other", hint: raw.slice(0, 300) || `exit ${exitCode}` };
  }
  return { data, ms, cli, exitCode, timedOut };
}

/** For tools that answer in plain text (e.g. `page get_text`): the whole text, not the 800-character error excerpt. */
export async function cuaText(tool: string, args: object, timeoutMs = 15_000): Promise<{ text: string; ok: boolean; ms: number }> {
  const t0 = performance.now();
  try {
    const proc = Bun.spawn([cuaPath(), "call", tool, JSON.stringify(args)], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { text, ok: code === 0 && !!text.trim() && !/session has ended/i.test(text.slice(0, 200)), ms: Math.round(performance.now() - t0) };
  } catch { return { text: "", ok: false, ms: Math.round(performance.now() - t0) }; }
}

/** Raw Cua codes (0.32.0, Windows + macOS) mapped onto our small set. */
const MAP: Record<string, DriverErrorCode> = {
  session_ended: "session_ended",
  browser_ref_stale: "stale", browser_binding_stale: "stale", stale_element_token: "stale", browser_requires_setup: "stale",
  window_id_not_found: "window_lost", window_owner_pid_mismatch: "window_lost", ax_window_unresolved: "window_lost",
  off_space_or_ax_unresolved: "window_lost",
  background_unavailable: "background_unavailable", browser_input_trust_unavailable: "background_unavailable",
  minimized_or_hidden_window: "minimized",
  timeout: "timeout", daemon_down: "daemon_down",
  browser_action_unavailable: "unsupported", browser_route_unavailable: "unsupported", unsupported: "unsupported",
  menu_path_unavailable: "unsupported",
};

/** Pulls an error out of any response shape the driver uses (nested `error`, or a top-level `code`). */
export function errorOf(data: any): { code: DriverErrorCode; hint?: string } | undefined {
  // Shapes seen on 0.32.0: {error:{code,hint}}, {code:"background_unavailable"}, {status:"refused", refusal:{code,message}}
  const e = data?.error ?? data?.refusal;
  const raw: string | undefined =
    (e && typeof e === "object" ? e.code : typeof e === "string" ? e : undefined) ??
    (typeof data?.code === "string" ? data.code : undefined);
  if (!raw && data?.effect !== "refused" && data?.status !== "error" && data?.status !== "refused") return undefined;
  const hint = (e && typeof e === "object" ? e.hint ?? e.message : undefined) ?? data?.summary ?? data?.suggestion ?? data?.message ?? raw;
  // Plain-text failures that mean "that window is gone" (an app such as Word replaces its start window).
  const gone = /no window with window_id|window .{0,40}(no longer exists|not found|was closed)/i.test(`${raw ?? ""} ${hint ?? ""} ${data?._raw ?? ""}`);
  const code: DriverErrorCode = (raw && MAP[raw]) || (gone ? "window_lost" : data?.status === "refused" || data?.effect === "refused" ? "refused" : "other");
  return { code, hint: `${raw && !MAP[raw] ? raw + ": " : ""}${hint ? String(hint).slice(0, 300) : ""}` || undefined };
}

export function toResult(r: CallResult): ActionResult {
  const error = errorOf(r.data);
  return { ok: !error, effect: r.data?.effect, route: r.data?.route, error, ms: r.ms, cli: r.cli };
}

/** Several driver calls reported as one action. */
export function merge(parts: CallResult[], last: ActionResult): ActionResult {
  return { ...last, ms: parts.reduce((s, p) => s + p.ms, 0), cli: parts.map(p => p.cli).join(" ; ") };
}

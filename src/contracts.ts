// Shared types. Platform-neutral: Windows and macOS drivers both implement `Driver`.

// One Cua session per hand ("agent"). Cua colours a session's cursor by the -N suffix of its name (palette slot N), so
// each name matches its colour. Mint-3 and Cyan-5: the agent's browser windows; Red-7 and Purple-1: desktop apps;
// Blue-9: point-and-ask (see lanes.ts).
export const HANDS = ["Mint-3", "Red-7", "Blue-9", "Cyan-5", "Purple-1"] as const;
/** Cua's palette, the colour of each hand's cursor, its widget and its pulses (the same as the Mac version's). */
export const AGENT_COLOURS: Record<string, string> = {
  "Purple-1": "#a259ff", "Pink-2": "#ff5fa2", "Mint-3": "#2bb39a", "Amber-4": "#f5a623", "Cyan-5": "#22c3e6",
  "Magenta-6": "#d63bd6", "Red-7": "#ff4d4f", "Lime-8": "#8fd400", "Blue-9": "#3b82f6",
};
export type HandName = (typeof HANDS)[number];

/** Our role names. Each driver maps its platform's control types onto these (src/driver/roles.ts). */
export type Role =
  | "text field" | "text area" | "pop-up" | "option" | "radio" | "checkbox" | "button" | "link"
  | "menu item" | "tab" | "list item" | "tree item" | "slider" | "heading" | "text" | "other";

/** Where a task runs: the agent's own browser window, a desktop app window, or the file system (no window). */
export type Surface =
  | { kind: "browser"; url: string }
  | { kind: "app"; app: string; uri?: string }                          // uri: open the app at a link (spotify:search:...)
  | { kind: "files"; op: FileOp }
  | { kind: "document"; app: "word"; title: string; text: string }      // a new document written through Office itself
  | { kind: "answer"; reply: string };                                  // no computer action: Claude answered directly

export type WindowSurface = Extract<Surface, { kind: "browser" | "app" }>;

/** File operations run directly on disk (previewed, approved, checked; never delete, never overwrite). */
export type FileMatch = { exts?: string[]; name?: string };
export type FileOp =
  | { op: "organize"; folder: string }
  | { op: "move" | "copy"; folder: string; match: FileMatch; dest: string }
  | { op: "convert"; folder: string; match: FileMatch; to: string }
  | { op: "list"; folder: string; match: FileMatch }
  | { op: "find"; folder: string; name: string; want: "folder" | "file" | "any"; open: boolean; list?: boolean }   // "where is my Year 1 folder"; list: say what is in it
  | { op: "write"; path: string; text: string };

/** A check done in code when the part ends: stronger than reading the screen. */
export type Check =
  | { kind: "display_equals"; label: RegExp | string; expected: number }   // e.g. Calculator "Display is 42"
  | { kind: "field_equals"; role: "text area" | "text field"; expected: string }
  | { kind: "playing" };                                                  // media: a Pause button is showing

export interface WindowRef {
  kind: "browser" | "app"; pid: number; windowId: number; app: string; title: string;
  targetId?: string; tabId?: string;                                    // browser binding (Windows browser route)
}

export interface Element {
  index: number; token?: string; role: Role; rawRole?: string;
  label?: string; value?: string; actions?: string[];
  checked?: boolean; selected?: boolean; expanded?: boolean; enabled?: boolean;
  inView?: boolean;                                                     // false = exists but off screen
}

export interface Observation {
  hand: HandName; t: string; window: WindowRef; title: string; url?: string;
  elements: Element[];
  text: string[];                                                       // readable text on screen, in order
  truncated: boolean; ms: number;
}

export type DriverErrorCode =
  | "session_ended" | "stale" | "window_lost" | "background_unavailable" | "minimized"
  | "timeout" | "daemon_down" | "unsupported" | "refused" | "other";

export interface ActionResult {
  ok: boolean;                       // the driver did not refuse. NEVER proof that it worked
  effect?: string; route?: string;
  error?: { code: DriverErrorCode; hint?: string };
  ms: number; cli: string;           // exact command, pasteable into this platform's shell
}

export type Key = "enter" | "tab" | "escape" | "backspace" | "pagedown" | "pageup";
export type ActSpec =
  | { tool: "click"; token: string }
  | { tool: "type"; token: string; text: string }                       // replaces the field's content
  | { tool: "key"; token?: string; key: Key }
  | { tool: "scroll"; direction: "down" | "up" }
  | { tool: "navigate"; url: string };

export interface DriverCaps { platform: "win32" | "darwin" | "sim"; name: string }

export interface Driver {
  caps: DriverCaps;
  ensureSession(hand: HandName): Promise<void>;
  /** Opens (or reuses) the window for a surface. Browser: the agent's own isolated browser at `url`. */
  open(hand: HandName, s: WindowSurface): Promise<WindowRef>;
  observe(hand: HandName, w: WindowRef): Promise<Observation>;
  act(hand: HandName, w: WindowRef, a: ActSpec): Promise<ActionResult>;
  /** Names of installed desktop apps, for the planner. */
  listApps(): Promise<string[]>;
  /** Browser: more of the page's text than one snapshot holds (for reading an answer). */
  readMore?(hand: HandName, w: WindowRef, pages?: number): Promise<string[]>;
  /** App: the same app's current window, when the one we had is gone (Word swaps its start window). */
  rebind?(hand: HandName, w: WindowRef): Promise<WindowRef | null>;
  /** Browser: if a click opened another tab and it is now active, bind to it. */
  followActiveTab?(hand: HandName, w: WindowRef): Promise<WindowRef>;
  keepAlive?(hand: HandName): Promise<void>;
  /** a hand is done for now: its coloured cursor is hidden until it acts again */
  release?(hand: HandName): Promise<void>;
  endAll(): Promise<void>;
  /** every press or text insert in an app, where it happened (the overlay flashes it in the hand's colour) */
  onAction?: (n: ActionNote) => void;
  /** the fast lane (UI Automation directly): on or off, and how many actions went which way */
  fastLane?(): { on: boolean; reason: string; fast: number; cua: number; fellBack: number };
}

export interface ActionNote { hand: HandName; pid?: number; frame: { x: number; y: number; w: number; h: number }; kind: "press" | "type"; via: "fast" | "cua" }

// ---------- perception + decisions ----------
export interface Item {
  i: number; id: string;             // id = role:label, stable across steps
  role: Role; text: string; value?: string; state?: string; token: string;
}

export type Kind = "click" | "type" | "press_enter" | "scroll_down" | "scroll_up" | "go_to_url" | "wait" | "done" | "stuck";
export interface Decision {
  kind: Kind;
  item?: number;                     // index into the items of this step
  valueName?: string;                // which planned value to type (jev)
  text?: string;                     // text to type (from a planned value or Claude)
  url?: string;
  reason?: string;
  probs?: { kind?: Record<string, number>; item?: Record<string, number>; value?: Record<string, number> };
  conf: { kind: number; item?: number; value?: number };
  gate: number;
  backend: "jev" | "claude" | "replay" | "rule";   // rule = decided in code (e.g. "Reject all" on a cookie banner)
  why?: string;                      // why this backend decided (e.g. "jev gate 0.31 < 0.4")
  model: string; inputTokens: number; outputTokens: number; ms: number;
}

// ---------- tasks ----------
export interface Subtask {
  surface: Surface; goal: string; values: { name: string; text: string }[];
  question?: boolean;                // the user asked for information: the answer must be read off the screen
  check?: Check;                     // code check before the part counts as done
  usePreviousAnswer?: boolean;       // the text to type is the answer of the previous part
  needsPrevious?: boolean;           // uses what earlier parts found, so it waits for them (independent parts run at the same time)
}
export interface Plan {
  subtasks: Subtask[]; question: string; by: "claude" | "jev+rules";
  aboutScreen?: boolean;             // a question about (or a drawing on) what is on the user's screen: answered by point-and-ask
}

export type ExceptionCode =
  | "needs_info" | "plan_failed" | "low_confidence" | "stalled" | "step_limit" | "false_done"
  | "driver_refused" | "window_lost" | "declined" | "stopped" | "model_error" | "unsafe";

export interface Task {
  id: string; instruction: string; source: "typed" | "voice";
  status: "queued" | "planning" | "running" | "done" | "partial" | "failed" | "stopped";   // partial: some parts done, some failed
  plan?: Plan;
  result?: { answer: string; evidence: string; handoff?: boolean };     // checked by a second reading of the screen (handoff: explain mode passed it to the agents)
  exception?: { code: ExceptionCode; reason: string };
  counts: { steps: number; jev: number; claude: number; gui: number; files: number; approvals: number; falseDoneCaught: number };
  cost: { jevUsd: number; claudeUsd: number };
  startedAt?: string; endedAt?: string;
}

export interface ApprovalRequest { id: string; taskId: string; action: string; why: string }

/**
 * One part of a task as an "agent" (the Mac version's word): the hand that does it, in its colour, its app, what it is
 * doing now and how it ended. The panel's agent cards and the overlay's widgets show these.
 */
export interface AgentState {
  id: string; taskId: string; sub: number;
  hand?: string; name: string; colour: string;   // name: the hand without its number ("Mint"); parts without a window get a colour too
  app: string; goal: string;
  status: "queued" | "running" | "done" | "failed";
  now: string; answer?: string; reason?: string;
  steps: number; seconds: number; startedAt?: number;
  windowId?: number; pid?: number;   // the window it works in (for the live preview in its widget)
}
export type Approver = (r: ApprovalRequest) => Promise<boolean>;

// ---------- JSONL: runs/<runId>/steps.jsonl ----------
export type LogLine =
  | { type: "task_start"; runId: string; t: string; task: Task; driver: string; deciders: string[] }
  | { type: "plan"; runId: string; t: string; taskId: string; plan: Plan; ms: number }
  | { type: "step"; runId: string; t: string; taskId: string; sub: number; step: number; window: { title: string; url?: string };
      items: Item[]; nDropped: number; decision: Decision; acted?: ActSpec; result?: ActionResult; note?: string;
      ms: { observe: number; decide: number; act: number; total: number } }
  | { type: "approval"; runId: string; t: string; taskId: string; request: ApprovalRequest; approved: boolean }
  | { type: "verify"; runId: string; t: string; taskId: string; sub: number; complete: boolean; answer: string; evidence: string; by: "code" | "claude" | "jev"; ms: number }
  | { type: "files"; runId: string; t: string; taskId: string; sub: number; op: FileOp; actions: FileAction[]; results: { ok: boolean; detail: string }[] }
  | { type: "task_end"; runId: string; t: string; task: Task }
  | { type: "ask"; runId: string; t: string; taskId: string; question: string; window?: string; element?: string; answer: string; by: "claude" | "jev" | "code"; pointedAt?: string; ms: number }
  | { type: "notice"; runId: string; t: string; level: "info" | "warn" | "error"; text: string }
  | { type: "agent"; runId: string; t: string; taskId: string; agent: AgentState };

export interface Logger { runId: string; write(l: LogLine): void }

export type FileAction =
  | { kind: "mkdir"; path: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "convert"; from: string; to: string }
  | { kind: "write"; path: string; text: string }
  | { kind: "open"; path: string };                                     // show a folder / file in File Explorer

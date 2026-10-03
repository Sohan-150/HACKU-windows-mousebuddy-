// TypeSafe jev: the cheap, fast decider for every step. It answers typed questions with a probability per option:
//   kind  - what sort of action
//   item  - which control on screen
//   value - which of the planned text values to type (or none: then Claude writes the text)
// Gate (awlevin/typesafe-computer-use runner.py): act only when confidence >= 0.4, else hand the step to Claude.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Decision, Item, Kind, Subtask } from "./contracts";

export const GATE = 0.4;
export const JEV_MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";
export const JEV_USD_PER_INPUT_TOKEN = 0.042e-6;

export interface StepState {
  instruction: string;               // what the user asked, verbatim
  sub: Subtask;                      // the current part of the plan
  notes: string[];                   // answers from earlier parts of the plan
  surface: string; windowTitle: string; url?: string;
  screenText: string[];
  items: Item[];
  previousActions: string[];         // last 8, each with its outcome
  alreadyTriedHere: string[];
  canGoToUrl?: boolean;              // something can supply an address (Claude, or a planned URL value)
  conversation?: { instruction: string; answer: string }[];   // earlier tasks in this session (for follow-ups)
}

export const KINDS: Record<Kind, string> = {
  click: "Click one control on screen (chosen in the item question).",
  type: "Type text into one text field or text area (chosen in the item question); the text is chosen in the value question.",
  press_enter: "Press Enter in the field that was just typed into, for example to run a search or send the form.",
  scroll_down: "Scroll down to see more of the page or window.",
  scroll_up: "Scroll back up to see the top of the page or window.",
  go_to_url: "Open a different web address in the browser.",
  wait: "Nothing to do yet; the page or window is still loading or changing.",
  done: "The goal is already achieved and visible on screen, or the answer to the question is visible on screen.",
  stuck: "Nothing on screen helps with the goal; a different approach or the user is needed.",
};

export function itemCriterion(it: Item): string {
  return `${it.role} '${it.text}'${it.value ? `, currently '${it.value.slice(0, 60)}'` : ""}${it.state ? ` (${it.state})` : ""}`;
}

export function buildRequest(s: StepState) {
  const kinds = { ...KINDS } as Record<string, string>;
  if (s.surface !== "browser" || !(s.canGoToUrl || s.sub.values.some(v => /^https?:\/\//i.test(v.text)))) delete kinds.go_to_url;
  const items: Record<string, string> = Object.fromEntries(s.items.map(it => [String(it.i), itemCriterion(it)]));
  items.none = "no control: the action does not need one";
  const values: Record<string, string> = Object.fromEntries(s.sub.values.map(v => [v.name, `${v.name}: '${v.text.slice(0, 120)}'`]));
  values.none = "none of these: new text has to be written";
  return {
    state: {
      user_instruction: s.instruction,
      current_goal: s.sub.goal,
      notes_from_earlier_steps: s.notes,
      window: { kind: s.surface, title: s.windowTitle, url: s.url ?? null },
      previous_actions: s.previousActions,
      already_tried_on_this_screen: s.alreadyTriedHere,
      screen_text: s.screenText,
      controls_in_reading_order: s.items.map(it => ({ i: it.i, role: it.role, text: it.text, value: it.value ?? null, state: it.state ?? null })),
    },
    questions: {
      kind: { type: "choice" as const, instructions: "You are operating this window one action at a time to achieve the current goal. Which kind of action makes the most progress right now? Never repeat an action listed as already tried on this screen.", criteria: kinds },
      item: { type: "choice" as const, instructions: "If the action needs a control, which control on screen?", criteria: items },
      value: { type: "choice" as const, instructions: "If text has to be typed, which of these prepared texts belongs in that control?", criteria: values },
    },
  };
}

/** Which confidences gate the action: click min(kind,item); type min(kind,item) (value is checked separately); else kind. */
export function gateOf(kind: string, c: { kind: number; item?: number }): number {
  return kind === "click" || kind === "type" ? Math.min(c.kind, c.item ?? 0) : c.kind;
}

export class Jev {
  private ts: TypeSafeClient;
  extra: JevExtra;
  constructor(opts: { apiKey?: string; fetch?: typeof fetch } = {}) {
    // The SDK default (10 s x 3 tries) could stall a step for ~30 s; 4 s x 2 is the measured-safe setting.
    this.ts = new TypeSafeClient({
      timeout: 4000, retry: { maxRetries: 1 }, defaultModel: JEV_MODEL,
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.fetch ? { fetch: opts.fetch as any } : {}),
    } as any);
    this.extra = new JevExtra(this.ts);
  }

  /**
   * Decides one step. With `only`, the item question offers just those items (a narrower re-ask when the first
   * answer was unsure); item numbers in the decision still refer to the full list.
   */
  async decide(s: StepState, only?: number[]): Promise<Decision> {
    const req = buildRequest(only ? { ...s, items: s.items.filter(it => only.includes(it.i)) } : s);
    const t0 = performance.now();
    const { data } = await this.ts.systemOne(req as any).withResponse();
    const a: any = data.answers;
    for (const k of ["kind", "item", "value"] as const) {
      if (!(a[k]?.choice in req.questions[k].criteria)) throw new Error(`jev answered '${a[k]?.choice}' for ${k}, not one of the options`);
    }
    const kind = a.kind.choice as Kind;
    const item = a.item.choice === "none" ? undefined : Number(a.item.choice);
    const valueName = a.value.choice === "none" ? undefined : a.value.choice;
    const conf = { kind: a.kind.confidence, item: a.item.confidence, value: a.value.confidence };
    return {
      kind, item, valueName,
      text: valueName ? s.sub.values.find(v => v.name === valueName)?.text : undefined,
      probs: { kind: a.kind.probabilities, item: a.item.probabilities, value: a.value.probabilities },
      conf, gate: gateOf(kind, conf), backend: "jev", model: data.model,
      inputTokens: data.usage?.input_tokens ?? 0, outputTokens: 0, ms: Math.round(performance.now() - t0),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Questions used when there is no Claude: classifying the instruction, checking "done", picking the answer line.

export const TASK_TYPES = {
  web_question: "Find information or answer a question by looking it up on the web.",
  web_task: "Do something on a particular website (open it, search it, fill something in on it).",
  calculate: "Work out an arithmetic result (add, subtract, multiply, divide numbers), for example in Calculator.",
  write_text: "Write or type some text in a text editor such as Notepad.",
  open_app: "Open a desktop app and do something in it.",
  files: "Work with files and folders on this computer: organise, move, copy, convert, list or count files.",
  chat: "A general question or request that needs no computer action (explain, write, advise, chat).",
  screen_question: "A question about something on the screen that the user is pointing at ('what is this', 'what does this button do').",
  unclear: "The instruction is unclear or is missing information needed to start.",
} as const;
export type TaskType = keyof typeof TASK_TYPES;

export const FILE_OPS = {
  organize: "Tidy a folder by sorting its files into sub-folders by type.",
  move: "Move some files to another folder.",
  copy: "Copy some files to another folder.",
  convert: "Convert files to another format (for example PNG to JPG, or a text file to PDF).",
  list: "List or count files in a folder.",
  find: "Find where a file or folder is, by its name ('where is my Year 1 folder', 'open my tax return').",
} as const;
export type FileOpKind = keyof typeof FILE_OPS;

export interface Classification {
  type: TaskType; typeConf: number;
  app?: string; appConf: number;
  fileOp?: FileOpKind; fileOpConf: number;
  inputTokens: number; ms: number;
}

export interface DoneCheck { done: number; answer?: string; answerConf: number; inputTokens: number; ms: number }

export class JevExtra {
  constructor(private ts: TypeSafeClient = new TypeSafeClient({ timeout: 4000, retry: { maxRetries: 1 }, defaultModel: JEV_MODEL } as any)) {}

  /** One request: what kind of task, which installed app (if any), which file operation (if any). */
  async classify(instruction: string, apps: string[]): Promise<Classification> {
    const appCriteria: Record<string, string> = Object.fromEntries(apps.slice(0, 240).map((a, i) => [String(i), a]));
    appCriteria.none = "no particular desktop app";
    const req = {
      state: { instruction },
      questions: {
        type: { type: "choice", instructions: "What kind of task is this instruction for a computer assistant?", criteria: TASK_TYPES },
        app: { type: "choice", instructions: "Which installed desktop app should be used, if the instruction needs one?", criteria: appCriteria },
        file_op: { type: "choice", instructions: "If the task is about files, which file operation is it?", criteria: { ...FILE_OPS, none: "not a file task" } },
      },
    };
    const t0 = performance.now();
    const { data } = await this.ts.systemOne(req as any).withResponse();
    const a: any = data.answers;
    const appIdx = a.app.choice === "none" ? undefined : Number(a.app.choice);
    return {
      type: a.type.choice, typeConf: a.type.confidence,
      app: appIdx !== undefined ? apps[appIdx] : undefined, appConf: a.app.confidence,
      fileOp: a.file_op.choice === "none" ? undefined : a.file_op.choice, fileOpConf: a.file_op.confidence,
      inputTokens: data.usage?.input_tokens ?? 0, ms: Math.round(performance.now() - t0),
    };
  }

  /** Which of these controls does the user's question point to ("where is the save button")? */
  async pickControl(question: string, options: string[]): Promise<{ index?: number; conf: number; inputTokens: number }> {
    const criteria: Record<string, string> = Object.fromEntries(options.slice(0, 250).map((o, i) => [String(i), o]));
    criteria.none = "none of these controls";
    const req = { state: { user_question: question }, questions: { control: { type: "choice", instructions: "Which control on screen does the user's question ask about, or should they use?", criteria } } };
    const { data } = await this.ts.systemOne(req as any).withResponse();
    const a: any = data.answers.control;
    return { index: a.choice === "none" ? undefined : Number(a.choice), conf: a.confidence, inputTokens: data.usage?.input_tokens ?? 0 };
  }

  /** Is the goal visibly achieved? For a question, which line of screen text answers it? */
  async checkDone(s: StepState, question: boolean): Promise<DoneCheck> {
    const lines = s.screenText.filter(l => l.length >= 3).slice(0, 200).map(l => l.slice(0, 300));
    const questions: Record<string, unknown> = {
      done: { type: "noul", instructions: "Does the screen show that the current goal is achieved?", criteria: { true: "the goal is visibly achieved", false: "the goal is not achieved yet" } },
    };
    if (question) {
      const criteria: Record<string, string> = Object.fromEntries(lines.map((l, i) => [String(i), l]));
      criteria.none = "no line answers the question";
      questions.answer = { type: "choice", instructions: `Which line of the screen text answers the user's question: ${s.instruction}`, criteria };
    }
    const req = { state: { user_instruction: s.instruction, current_goal: s.sub.goal, window: { title: s.windowTitle, url: s.url ?? null }, screen_text: lines }, questions };
    const t0 = performance.now();
    const { data } = await this.ts.systemOne(req as any).withResponse();
    const a: any = data.answers;
    const pick = question && a.answer?.choice !== "none" ? lines[Number(a.answer.choice)] : undefined;
    return { done: a.done.noul, answer: pick, answerConf: question ? a.answer.confidence : 1, inputTokens: data.usage?.input_tokens ?? 0, ms: Math.round(performance.now() - t0) };
  }
}

// One hotkey for everything: is what the user said a job for the agents ("compute 128 times 37 in Calculator",
// "mute me on Discord", "open Spotify and play Drake") or a question about the screen ("how do I…", "what does this
// button do", "circle the zebra")? Ported from the Mac version, then made to lean towards doing: anything phrased as an
// order goes to the agents, and only clear questions about the screen are explained. Clear cases are decided in code;
// an unclear one goes to jev; with no answer from jev, a question is explained and anything else is done.
import type { JevExtra } from "./jev";
import { calculation, looksLikeFind } from "./planner";
import { isScreenQuestion } from "./pointer";

export type Route = { to: "agents" | "explain" | "stop"; via: "code" | "jev"; ms: number; confidence?: number };

const STOP = /^(stop|cancel|abort|halt)( (it|that|everything|the agents|agents|now))?$/;
const DISMISS = /^(stop|cancel|clear|never ?mind|hide|that's all|thanks|thank you)$/;
const POLITE = /^((please|pls|can you|could you|would you|will you|can u|go and|hey backstage,?|backstage,?|i want you to|i need you to|i'd like you to) )*/;
// an order: starts with an action verb (after "please" / "can you")
const VERBS = "open|launch|run|start|close|quit|exit|minimi[sz]e|maximi[sz]e|restore|switch to|bring up|compute|calculate|work out|add|subtract|multiply|divide|write|type|draft|compose|make|create|save|search|look up|google|find|play|pause|resume|stop playing|skip|shuffle|repeat the song|watch|listen to|organi[sz]e|sort|tidy|move|copy|convert|rename|put|set|turn|switch|send|message|text|reply|dm|email|call|ring|join|leave|mute|unmute|deafen|undeafen|enable|disable|click|press|tap|scroll|select|choose|pick|go to|visit|show|take|book|plan|get|download|install|update|check|post|share|upload|attach|like|follow|subscribe|delete|remove|clear the";
const DO = new RegExp(`^(${VERBS})\\b`);
// drawing on the screen and teaching are explain mode, even phrased as an order
const EXPLAIN_ORDER = /^(underline|ring|circle|highlight|point (at|to|out)|draw (a |an )?(circle|ring|box|arrow|line)|mark|annotate|label|show me (how|where|what|which)|teach me|explain|walk me through|tell me (what|how|where|why|which))\b/;
// a question about what's on the screen, or how to do something (the user does it)
const QUESTION = /^(how (do|can|would|should) i|how to|what('s| is| are| does| do) (this|that|these|those|it|here|the .{1,30} (on|in) (my|the) screen)|what am i (looking|seeing)|where (is|are|do|can) (the|this|that|my .{1,20} (button|menu|tab|icon|setting))|why (is|does|did|can't|won't) (this|that|it)|which (button|one|key|menu|tab)|can you see|what does .* (do|mean)|is this|are these)\b/;
const LESSON = /^(next( step)?|continue|go on|ok|okay|done|got it|and then|then what|repeat|again|back|previous)$/;
const APPS = /\b(calculator|notepad|word|excel|powerpoint|outlook|teams|paint|file explorer|explorer|chrome|edge|browser|spotify|youtube|google|google maps|epic games|steam|discord|whatsapp|telegram|slack|zoom|vs ?code|visual studio code|terminal|settings|photos|camera|clock|mail|calendar|onenote|obs|vlc|netflix|instagram|twitter|x\.com|facebook|messenger|signal|skype|figma|notion|obsidian|minecraft|fortnite|roblox)\b/;
// travel and the weather are look-ups for the agents, even phrased as "how do I get to…"
const LOOKUP = /\b(get (to|from)|directions?|route (to|from)|flights?|fly to|weather|temperature|forecast)\b/;
const ASKS = /\?$|^(what|what's|whats|why|how|who|where|which|when|is|are|does|do|did|can you see|could you see)\b/;

export type Chooser = Pick<JevExtra, "choose">;

/** phrased as a question (a "?" at the end, or a question word first) */
const asks = (text: string) => ASKS.test(text.trim().toLowerCase().replace(/[.!]+$/, ""));
const norm = (text: string) => text.toLowerCase().replace(/[.!?,]+$/g, "").replace(/\s+/g, " ").trim();

/** what code alone can tell: undefined when it is unclear (then jev decides) */
export function codeRoute(text: string, ctx: { lesson: boolean; agentsBusy: boolean }): Route["to"] | undefined {
  const w = norm(text);
  if (STOP.test(w) && ctx.agentsBusy) return "stop";
  if (DISMISS.test(w)) return "explain"; // "clear", "never mind": clears the drawings (not a job called "clear")
  if (ctx.lesson && LESSON.test(w)) return "explain";
  const order = w.replace(POLITE, "");
  if (EXPLAIN_ORDER.test(order)) return "explain";
  if (DO.test(order)) return "agents";       // "can you open Spotify and send 'this is me'" is an order, whatever it says
  if (looksLikeFind(text)) return "agents";   // "where is my Year 1 folder" is a search on disk
  if (LOOKUP.test(w) && !/\b(this|that|here|screen|window|button)\b/.test(w)) return "agents";
  if (calculation(w) && /\b(calculat|comput|work out|what is|what's|times|plus|minus|divided)/.test(w)) return "agents";
  if (isScreenQuestion(text) || QUESTION.test(w)) return "explain";
  if (APPS.test(w) && !asks(text)) return "agents";   // "Spotify, Drake please", "my mic on Discord off"
  if (ctx.lesson && w.split(" ").length <= 3) return "explain"; // short replies during a lesson
  return undefined;
}

export async function route(text: string, ctx: { lesson: boolean; agentsBusy: boolean; jev?: Chooser | null }): Promise<Route> {
  const t0 = performance.now();
  const done = (to: Route["to"], via: Route["via"] = "code", confidence?: number): Route => ({ to, via, ms: Math.round(performance.now() - t0), confidence });
  const known = codeRoute(text, ctx);
  if (known) return done(known);
  // unclear: a question is explained, anything else is done (the agents ask when they need more)
  const fallback = asks(text) ? "explain" : "agents";
  if (!ctx.jev) return done(fallback);
  try {
    const c = await ctx.jev.choose(
      `The user pressed the assistant hotkey and said: "${text}". Should agents DO this on the computer, or should the assistant EXPLAIN something on the screen?`,
      {
        agents: "a task to carry out on the computer: open or use an app, send a message, play, mute, type, compute, search or look up, organise files",
        explain: "a question about what is on the screen, or how to do something (the user does it)",
      },
      { said: text },
    );
    return done(c.confidence >= 0.5 ? (c.choice === "agents" ? "agents" : "explain") : fallback, "jev", c.confidence);
  } catch {
    return done(fallback);
  }
}

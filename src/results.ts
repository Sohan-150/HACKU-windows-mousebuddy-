// What the agents found, made readable for the widgets and sayable for the voice. Ported from the Mac version.
import type { AgentState } from "./contracts";

/** an agent's answer for a widget: no search-result breadcrumbs, Calculator results as "45 × 12 = 540" */
export function tidyAnswer(answer: string): string {
  let s = answer.replace(/\s+/g, " ").trim();
  s = s.replace(/https?:\/\/\S+(\s*›\s*[^\s›]+)*(\s*(\.\.\.|…))?\s*/g, "").trim(); // "https://site.net › a › b... "
  s = s.replace(/\s+([,.;:])/g, "$1");
  const calc = s.match(/^(-?[\d.,]+%?(?:\s*[×÷+\-−]\s*-?[\d.,]+%?)+)\s*=?\s+(-?[\d.,]+(?:e[+-]?\d+)?)$/);
  if (calc) s = `${calc[1]!.replace(/\s*([×÷+−]|(?<=\d)-)\s*/g, " $1 ")} = ${calc[2]}`;
  return s;
}

/** the same answer, to be read out: symbols as words, at most the first two sentences */
export function sayable(answer: string): string {
  let s = tidyAnswer(answer)
    .replace(/(?:[A-Za-z]:\\|\/Users\/|~\/)(?:[^\\/\s]+[\\/])*([^\\/]+?\.(?:docx|txt|rtf|pdf|md))/g, "$1") // a saved file: just its name
    .replace(/ × /g, " times ").replace(/ ÷ /g, " divided by ").replace(/ [−-] /g, " minus ").replace(/ \+ /g, " plus ").replace(/ = /g, " is ");
  const sentences = s.split(/(?<=[.!?])\s+/);
  s = sentences.slice(0, 2).join(" ");
  if (s.length > 220) s = `${s.slice(0, 217).replace(/\s+\S*$/, "")}…`;
  return s;
}

/** one or two sentences to say when a task ends, one for each of its agents */
export function spokenSummary(agents: AgentState[], status: string, error?: string): string {
  if (status === "error") return `Something went wrong: ${error ?? "unknown error"}`;
  if (status === "stopped") return "Stopped. The agents left everything as it is now.";
  if (!agents.length) return error ? sayable(error) : "I couldn't work out how to do that. Try naming the app or the website.";
  const one = agents.length === 1;
  const parts = agents.map(a => {
    if (a.status !== "done") return `${one ? "I" : a.name} couldn't finish in ${a.app}${a.reason ? `: ${sayable(a.reason)}` : ""}`;
    const ans = a.answer?.trim();
    // a writing task answers with the text it wrote: don't read the whole text back
    if (!ans || (/\b(write|type|note|draft)\b/i.test(a.goal) && (a.goal.includes(ans.slice(0, 40)) || ans.length > 120))) return one ? `Done in ${a.app}` : `${a.app} is done`;
    return one ? sayable(ans) : `In ${a.app}: ${sayable(ans)}`;
  });
  return parts.map(p => (/[.!?…]$/.test(p) ? p : `${p}.`)).join(" ");
}

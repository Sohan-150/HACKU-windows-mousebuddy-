// One small planning call: checks the request shape for this model, the JSON output and the cost tracking.
import { Claude, CLAUDE_MODEL } from "../src/claude";
const c = new Claude({ budgetUsd: 0.2 });
const t0 = performance.now();
for (const instr of ["Explain what a VPN is in two sentences", "Find the opening hours of the Hong Kong Museum of Art"]) {
  const r = await c.plan(instr, { today: "2026-10-03", platform: "Windows", apps: ["Calculator", "Notepad"] });
  const s = r.plan.subtasks.map(p => p.surface.kind === "answer" ? `answer: ${p.surface.reply.slice(0, 160)}` : p.surface.kind === "browser" ? `browser ${p.surface.url} -> ${p.goal}` : JSON.stringify(p.surface));
  console.log(`[${CLAUDE_MODEL}] ${instr}\n   ${r.plan.question || s.join(" | ")}  (${r.ms} ms)`);
}
console.log(`[${CLAUDE_MODEL}] total $${c.usage.usd.toFixed(5)}, ${c.usage.inputTokens} in / ${c.usage.outputTokens} out, ${Math.round(performance.now() - t0)} ms`);

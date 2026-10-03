// Live harness: sends tasks to the running app one by one, answers approvals, prints each step. Usage:
//   bun scratch/live.ts "instruction" [approve|deny] ...
const base = "http://127.0.0.1:3000";
const args = process.argv.slice(2);
const jobs: { text: string; answer: boolean }[] = [];
for (let i = 0; i < args.length; i++) { const answer = args[i + 1] === "deny" ? false : true; if (args[i + 1] === "deny" || args[i + 1] === "approve") { jobs.push({ text: args[i], answer }); i++; } else jobs.push({ text: args[i], answer }); }
const res = await fetch(base + "/events");
const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
let current: { id: string; answer: boolean } | null = null; const answered = new Set<string>();
const next = async () => { const j = jobs.shift(); if (!j) { process.exit(0); } const t = await (await fetch(base + "/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: j.text }) })).json(); current = { id: t.id, answer: j.answer }; console.log(`\n=== ${j.text}`); };
await next();
for (;;) {
  const { value, done } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let k; while ((k = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, k).replace(/^data: /, ""); buf = buf.slice(k + 2);
    const e = JSON.parse(raw);
    if (e.type === "state") for (const a of e.state.approvals) if (!answered.has(a.id) && current) { answered.add(a.id); const ok = current.answer && !/accept|agree/i.test(a.action); console.log(`  APPROVAL? ${a.action} (${a.why}) -> ${ok ? "approve" : "deny"}`); await fetch(`${base}/api/approvals/${a.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approve: ok }) }); }
    if (e.type === "plan") console.log(`  plan (${e.plan.by}): ${e.plan.question || e.plan.subtasks.map((s: any) => `${s.surface.kind === "browser" ? s.surface.url : s.surface.kind === "app" ? s.surface.app : s.surface.kind === "files" ? "files:" + s.surface.op.op : "answer"} -> ${s.goal}`).join(" | ")}`);
    if (e.type === "step") { const d = e.decision, it = d.item !== undefined ? e.items[d.item] : null; console.log(`  #${e.step} ${d.backend} ${d.kind}${it ? ` '${it.text}'` : ""}${e.acted?.text ? ` <- ${JSON.stringify(e.acted.text)}` : ""} gate=${d.gate?.toFixed(2)}${d.why ? ` [${d.why}]` : ""}${e.result && !e.result.ok ? ` REFUSED ${e.result.error?.code}` : ""}${e.note ? ` (${e.note})` : ""} ${e.ms.total}ms`); }
    if (e.type === "verify") console.log(`  verify(${e.by}): ${e.complete} | ${e.evidence}`);
    if (e.type === "files") console.log(`  files: ${e.results.map((r: any) => (r.ok ? "ok " : "FAIL ") + r.detail).join(" | ")}`);
    if (e.type === "task_end") { const t = e.task; console.log(`  => ${t.status}${t.exception ? ` ${t.exception.code}: ${t.exception.reason}` : `: ${t.result?.answer}`}\n     ${((Date.parse(t.endedAt) - Date.parse(t.startedAt)) / 1000).toFixed(1)}s, jev calls ${t.counts.jev}, claude ${t.counts.claude}, gui ${t.counts.gui}, files ${t.counts.files}, cost $${(t.cost.jevUsd + t.cost.claudeUsd).toFixed(5)}`); await next(); }
  }
}

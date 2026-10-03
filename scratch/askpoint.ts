// Finds a visible point on a control in a window matching argv[2] (not covered by a higher window) and asks argv[3] there.
import { cuaCall } from "../src/driver/cli";
const [, , titleRe, question, labelRe] = process.argv;
await cuaCall("start_session", { session: "Blue-9" });
const lw = (await cuaCall("list_windows", { session: "Blue-9" })).data.windows.filter((w: any) => w.title && !w.minimized && w.is_on_screen !== false);
const win = titleRe === "TOP" ? lw.filter((w: any) => !/^cua/i.test(w.title) && !/NVIDIA|Input Experience/.test(w.title) && w.bounds.height > 40).sort((a: any, b: any) => b.z_index - a.z_index)[0] : lw.find((w: any) => new RegExp(titleRe, "i").test(w.title));
if (!win) { console.log("no window", titleRe); process.exit(1); }
const st = (await cuaCall("get_window_state", { session: "Blue-9", pid: win.pid, window_id: win.window_id, include_screenshot: false })).data;
const covered = (x: number, y: number) => lw.some((w: any) => w !== win && (w.z_index ?? 0) > (win.z_index ?? 0) && x >= w.bounds.x && y >= w.bounds.y && x <= w.bounds.x + w.bounds.width && y <= w.bounds.y + w.bounds.height && !/^cua/i.test(w.title));
const el = (st.elements ?? []).find((e: any) => e.frame && new RegExp(labelRe ?? ".", "i").test(e.label ?? "") && !covered(e.frame.x + e.frame.w / 2, e.frame.y + e.frame.h / 2));
if (!el) { console.log("no uncovered control matching", labelRe, "in", win.title, "z", win.z_index); process.exit(1); }
const x = Math.round(el.frame.x + el.frame.w / 2), y = Math.round(el.frame.y + el.frame.h / 2);
console.log(`pointing at ${el.role} "${el.label}" (${x},${y}) in "${win.title}"`);
const t0 = performance.now();
const r = await (await fetch("http://127.0.0.1:3000/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: question, x, y }) })).json();
console.log(`${r.status}: ${r.result?.answer ?? r.exception?.reason ?? JSON.stringify(r)}\n  evidence: ${r.result?.evidence}\n  ${Math.round(performance.now() - t0)} ms, jev ${r.counts?.jev}, cost $${((r.cost?.jevUsd ?? 0) + (r.cost?.claudeUsd ?? 0)).toFixed(5)}`);

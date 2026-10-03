// The pointing chain on an agent-owned window: jev picks the control, the agent cursor glides there, a ring circles it.
import { WinDriver } from "../src/driver/win";
import { cuaCall } from "../src/driver/cli";
import { Jev } from "../src/jev";
import { askScreen } from "../src/ask";
import { warmHighlight, stopHighlight } from "../src/highlight";
import type { PointerContext, PointedElement } from "../src/pointer";
warmHighlight();
const d = new WinDriver();
await d.ensureSession("Blue-9");
const w = await d.open("Blue-9", { kind: "app", app: "Calculator" });
const st = (await cuaCall("get_window_state", { session: "Blue-9", pid: w.pid, window_id: w.windowId, include_screenshot: false })).data;
const els: PointedElement[] = (st.elements ?? []).filter((e: any) => e.frame?.w > 0 && e.label).map((e: any) => ({ index: e.element_index, role: e.role, label: e.label, frame: e.frame }));
const b = (await cuaCall("list_windows", { session: "Blue-9" })).data.windows.find((x: any) => x.window_id === w.windowId).bounds;
const ctx: PointerContext = { x: b.x + 10, y: b.y + 10, t: new Date().toISOString(), window: { pid: w.pid, windowId: w.windowId, title: w.title, app: "Calculator", bounds: b }, nearby: [], all: els };
await Bun.sleep(1200);                                     // let the ring helper finish starting
const rings: any[] = [];
const { highlight } = await import("../src/highlight");
const r = await askScreen(process.argv[2] ?? "where is the equals button?", ctx, { hand: "Blue-9", claude: null, jev: new Jev(), ring: (f, ms) => { rings.push(f); return highlight(f, ms); } }, ctx);
console.log(JSON.stringify({ answer: r.answer, by: r.by, pointedAt: r.pointedAt, ring: rings[0], ms: r.ms, jevTokens: r.jevTokens }, null, 1));
const cur = (await cuaCall("get_agent_cursor_state", { session: "Blue-9" })).data;
console.log("agent cursor now:", JSON.stringify(cur).slice(0, 200));
await Bun.sleep(3200); stopHighlight(); process.exit(0);

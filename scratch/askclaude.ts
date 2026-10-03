// Point-and-ask with Claude on an agent-owned window (Calculator): a real window screenshot, the pointer on a button.
import { WinDriver } from "../src/driver/win";
import { cuaCall } from "../src/driver/cli";
import { Claude } from "../src/claude";
import { askScreen } from "../src/ask";
import { highlight, warmHighlight, stopHighlight } from "../src/highlight";
import { tmpdir } from "node:os"; import { join } from "node:path";
import type { PointerContext, PointedElement } from "../src/pointer";
warmHighlight();
const [question, pointAtLabel] = [process.argv[2], process.argv[3]];
const d = new WinDriver(); await d.ensureSession("Blue-9");
const w = await d.open("Blue-9", { kind: "app", app: "Calculator" });
const shot = join(tmpdir(), `agent-test-${Date.now()}.png`);
const st = (await cuaCall("get_window_state", { session: "Blue-9", pid: w.pid, window_id: w.windowId, include_screenshot: true, screenshot_out_file: shot, max_image_dimension: 1400, timeout_ms: 4000 }, 15000)).data;
const els: PointedElement[] = (st.elements ?? []).filter((e: any) => e.frame?.w > 0 && e.label).map((e: any) => ({ index: e.element_index, role: e.role, label: e.label, value: e.value, frame: e.frame }));
const b = st.window_bounds, scale = st.screenshot_width / b.width;
const target = els.find(e => new RegExp(pointAtLabel, "i").test(e.label))!;
const x = target.frame.x + target.frame.w / 2, y = target.frame.y + target.frame.h / 2;
const ctx: PointerContext = { x, y, t: new Date().toISOString(), window: { pid: w.pid, windowId: w.windowId, title: w.title, app: "Calculator", bounds: b },
  element: target, nearby: [], all: els, screenshot: { path: shot, width: st.screenshot_width, height: st.screenshot_height, px: Math.round((x - b.x) * scale), py: Math.round((y - b.y) * scale) } };
await Bun.sleep(800);
const claude = new Claude();
const rings: any[] = [];
const r = await askScreen(question, ctx, { hand: "Blue-9", claude, jev: null, ring: (f, ms) => { rings.push(f); return highlight(f, ms); } }, ctx);
console.log(`Q: ${question}   (pointer on "${target.label}")\nA (${r.by}, ${r.ms} ms, $${r.claudeUsd.toFixed(4)}): ${r.answer}\n   pointed at: ${r.pointedAt ?? "-"}  ring: ${JSON.stringify(rings[0] ?? null)}`);
await Bun.sleep(3000); stopHighlight(); process.exit(0);

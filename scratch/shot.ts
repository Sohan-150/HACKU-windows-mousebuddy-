import { join } from "node:path";
import { cuaCall } from "../src/driver/cli";
const out = join(process.env.TEMP!, "agent-shot-test.png");
const w = (await cuaCall("list_windows", {})).data.windows.find((x: any) => /calculator/i.test(x.title));
const r = await cuaCall("get_window_state", { session: "Blue-9", pid: w.pid, window_id: w.window_id, include_screenshot: true, screenshot_out_file: out, max_image_dimension: 1200 });
const { elements, tree_markdown, ...rest } = r.data;
console.log(JSON.stringify(rest).slice(0, 1200));
const f = Bun.file(out); console.log("file", out, await f.exists() ? f.size : "missing");

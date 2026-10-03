import { dlopen, FFIType, ptr } from "bun:ffi";
import { cuaCall } from "../src/driver/cli";
const u = dlopen("user32.dll", {
  SetProcessDpiAwarenessContext: { args: [FFIType.i64], returns: FFIType.i32 },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.i32 },
});
u.symbols.SetProcessDpiAwarenessContext(-4n as any);   // per-monitor v2: physical pixels
const p = new Int32Array(2); u.symbols.GetCursorPos(ptr(p));
const c = (await cuaCall("get_cursor_position", {})).data;
console.log("Win32 physical cursor:", p[0], p[1], "| Cua cursor:", c.x, c.y);
const wins = (await cuaCall("list_windows", {})).data.windows.filter((w: any) => /calculator/i.test(w.title));
console.log("Calculator window:", JSON.stringify(wins[0]?.bounds));
if (wins[0]) {
  const st = (await cuaCall("get_window_state", { pid: wins[0].pid, window_id: wins[0].window_id, include_screenshot: false, session: "Blue-9" })).data;
  const six = st.elements?.find((e: any) => e.label === "Six");
  console.log("'Six' frame:", JSON.stringify(six?.frame), "| window_bounds:", JSON.stringify(st.window_bounds));
}

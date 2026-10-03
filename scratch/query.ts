import { WinDriver, pageText } from "../src/driver/win";
import { cuaCall } from "../src/driver/cli";
const d = new WinDriver();
await d.ensureSession("Mint-3");
const b = await d.open("Mint-3", { kind: "browser", url: "" });
console.log("page:", b.title);
for (const q of process.argv.slice(2)) {
  const t0 = performance.now();
  const r = await cuaCall("get_browser_state", { session: "Mint-3", target_id: b.targetId, tab_id: b.tabId, snapshot_format: "semantic_v2", query: q });
  const lines = pageText(r.data);
  console.log(`query "${q}": ${Math.round(performance.now() - t0)} ms, ${lines.length} lines, keys ${Object.keys(r.data).join(",")}`);
  for (const l of lines.slice(0, 6)) console.log("   |", l.slice(0, 200));
  if (r.data.query_matches || r.data.matches) console.log("   matches:", JSON.stringify(r.data.query_matches ?? r.data.matches).slice(0, 600));
}

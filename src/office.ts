// "Create a Word document and write X": a new document written through Word's own automation interface (COM), with
// real headings and bullets, then shown. More reliable than typing into Word's canvas, which takes no background
// input. It is not saved, so nothing on disk changes without the user. Windows only; the Mac falls back to the GUI.
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ParaStyle = "title" | "h1" | "h2" | "h3" | "bullet" | "normal";
export interface DocResult { ok: boolean; name: string; chars: number; paragraphs: number; error?: string; ms: number }

/** Light markdown -> paragraphs: "# " heading 1, "## " heading 2, "### " heading 3, "- " / "* " bullet. */
export function toParagraphs(title: string, text: string): { text: string; style: ParaStyle }[] {
  const out: { text: string; style: ParaStyle }[] = [];
  if (title.trim()) out.push({ text: title.trim(), style: "title" });
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    const m = l.match(/^(#{1,3})\s+(.*)$/);
    if (m) out.push({ text: m[2].replace(/\*\*/g, ""), style: (["h1", "h2", "h3"] as const)[m[1].length - 1] });
    else if (/^[-*•]\s+/.test(l)) out.push({ text: l.replace(/^[-*•]\s+/, "").replace(/\*\*/g, ""), style: "bullet" });
    else out.push({ text: l.replace(/\*\*/g, ""), style: "normal" });
  }
  // Skip a first heading that repeats the title.
  if (out.length > 1 && out[0].style === "title" && out[1].style === "h1" && out[1].text.toLowerCase() === out[0].text.toLowerCase()) out.splice(1, 1);
  return out;
}

const SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$in = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json
$styles = @{ title = -63; h1 = -2; h2 = -3; h3 = -4; bullet = -49; normal = -1 }
$w = New-Object -ComObject Word.Application
$d = $w.Documents.Add()
$d.Content.Text = (($in.paragraphs | ForEach-Object { $_.text }) -join [char]13)
$i = 1
foreach ($p in $in.paragraphs) { $d.Paragraphs.Item($i).Style = $styles[$p.style]; $i++ }
$w.Visible = $true
$d.Activate()
$out = @{ ok = $true; name = $d.Name; chars = $d.Content.Text.Length; paragraphs = $d.Paragraphs.Count }
$out | ConvertTo-Json -Compress
`;

/** Creates and shows a new Word document; reads its text length back to check it. */
export async function createWordDocument(title: string, text: string): Promise<DocResult> {
  const t0 = performance.now();
  if (process.platform !== "win32") return { ok: false, name: "", chars: 0, paragraphs: 0, error: "Word automation is Windows-only here", ms: 0 };
  const paragraphs = toParagraphs(title, text);
  const input = join(tmpdir(), `agent-doc-${Date.now()}.json`), script = join(tmpdir(), `agent-doc-${Date.now()}.ps1`);
  writeFileSync(input, JSON.stringify({ paragraphs }), "utf8");
  writeFileSync(script, "﻿" + SCRIPT, "utf8");                       // BOM: PowerShell 5 reads the script as UTF-8
  try {
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, input], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 60_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited; clearTimeout(timer);
    const line = out.trim().split(/\r?\n/).pop() ?? "";
    try { return { ...JSON.parse(line), ms: Math.round(performance.now() - t0) }; }
    catch { return { ok: false, name: "", chars: 0, paragraphs: 0, error: (err || out).trim().slice(0, 300) || "Word did not answer", ms: Math.round(performance.now() - t0) }; }
  } finally {
    for (const f of [input, script]) try { unlinkSync(f); } catch { /* gone */ }
  }
}

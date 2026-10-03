// File tasks, done directly on disk (not through the GUI): organise, move, copy, convert, list, write, find.
// Rules: inside the user's home folder only; preview first and the user approves; never delete; never overwrite
// (a new name is chosen); every result is checked on disk afterwards; an undo log is kept in the run folder.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileAction, FileMatch, FileOp } from "./contracts";

export class FileOpError extends Error {}

const SKIP = /^(desktop\.ini|thumbs\.db|\.ds_store)$|\.(tmp|crdownload|part|partial|lnk)$/i;
const GROUPS: [string, string[]][] = [
  ["Images", ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "heic", "svg", "ico"]],
  ["PDFs", ["pdf"]],
  ["Documents", ["doc", "docx", "txt", "rtf", "odt", "md", "pages"]],
  ["Spreadsheets", ["xls", "xlsx", "csv", "ods", "numbers"]],
  ["Presentations", ["ppt", "pptx", "odp", "key"]],
  ["Archives", ["zip", "rar", "7z", "tar", "gz"]],
  ["Audio", ["mp3", "wav", "flac", "m4a", "aac", "ogg"]],
  ["Video", ["mp4", "mov", "avi", "mkv", "webm"]],
  ["Installers", ["exe", "msi"]],
  ["Code", ["js", "ts", "py", "java", "c", "cpp", "cs", "html", "css", "json", "ipynb"]],
];
const IMAGE_FORMATS: Record<string, string> = { png: "Png", jpg: "Jpeg", jpeg: "Jpeg", bmp: "Bmp", gif: "Gif", tif: "Tiff", tiff: "Tiff" };
const TO_PDF_FROM = ["txt", "md", "html", "htm", "png", "jpg", "jpeg", "gif", "svg", "webp", "json", "csv"];

const ext = (p: string) => extname(p).slice(1).toLowerCase();
export const inHome = (p: string, home = homedir()) => resolve(p).toLowerCase().startsWith(resolve(home).toLowerCase() + "\\") || resolve(p).toLowerCase().startsWith(resolve(home).toLowerCase() + "/");

function files(folder: string, m?: FileMatch): string[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new FileOpError(`The folder ${folder} does not exist.`);
  return readdirSync(folder, { withFileTypes: true })
    .filter(d => d.isFile() && !d.name.startsWith(".") && !SKIP.test(d.name))
    .map(d => d.name)
    .filter(n => !m || ((!m.exts || m.exts.includes(ext(n)) || (ext(n) === "jpeg" && m.exts.includes("jpg"))) && (!m.name || n.toLowerCase() === m.name.toLowerCase())))
    .map(n => join(folder, n));
}

/** A free name: "a.pdf" -> "a (1).pdf" if taken (also by an earlier action in the same plan). */
function freeName(path: string, taken: Set<string>): string {
  let p = path, i = 1;
  while (existsSync(p) || taken.has(p.toLowerCase())) { p = join(dirname(path), `${basename(path, extname(path))} (${i++})${extname(path)}`); }
  taken.add(p.toLowerCase());
  return p;
}

export interface FilePlan { actions: FileAction[]; summary: string; answer?: string; needsApproval: boolean }

/** Dry run: what would happen. Nothing on disk changes. */
export function planFiles(op: FileOp, home = homedir()): FilePlan {
  const guard = (p: string) => { if (!inHome(p, home)) throw new FileOpError(`For safety I only work inside ${home}; ${p} is outside it.`); };
  const taken = new Set<string>();
  if (op.op === "write") {
    guard(op.path);
    const to = freeName(op.path, taken);
    return { actions: [{ kind: "write", path: to, text: op.text }], summary: `Write ${op.text.length} characters to ${to}`, needsApproval: true };
  }
  guard(op.folder);
  if (op.op === "find") {
    // Read-only search; opening the match in File Explorer changes nothing, so it needs no approval.
    const hits = findByName(op.folder, op.name, op.want);
    if (!hits.length) {
      return { actions: [], needsApproval: false, summary: `nothing called "${op.name}"`,
        answer: `I couldn't find a ${op.want === "any" ? "file or folder" : op.want} called "${op.name}" in ${op.folder} (I also tried it with numbers and words swapped, like "one" and "1").` };
    }
    const best = hits[0];
    const more = hits.length > 1 ? ` Also found: ${hits.slice(1, 4).map(h => h.path).join("; ")}.` : "";
    return {
      actions: op.open ? [{ kind: "open", path: best.path }] : [], needsApproval: false, summary: `found ${hits.length}`,
      answer: `Your ${best.isDir ? "folder" : "file"} "${basename(best.path)}" is in ${dirname(best.path)}.${op.open ? " I've opened it in File Explorer." : ""}${more}`,
    };
  }
  if (op.op === "list") {
    const found = files(op.folder, op.match);
    const what = op.match.exts ? op.match.exts.map(e => e.toUpperCase()).join("/") + " files" : op.match.name ?? "files";
    const names = found.map(f => basename(f));
    return { actions: [], needsApproval: false, summary: `Looked in ${op.folder}`,
      answer: `${found.length} ${what} in ${op.folder}${names.length ? `: ${names.slice(0, 15).join(", ")}${names.length > 15 ? `, and ${names.length - 15} more` : ""}` : ""}.` };
  }
  if (op.op === "organize") {
    const actions: FileAction[] = [];
    const made = new Set<string>();
    for (const f of files(op.folder)) {
      const group = GROUPS.find(([, exts]) => exts.includes(ext(f)))?.[0] ?? "Other";
      const dir = join(op.folder, group);
      if (!made.has(dir) && !existsSync(dir)) { actions.push({ kind: "mkdir", path: dir }); made.add(dir); }
      actions.push({ kind: "move", from: f, to: freeName(join(dir, basename(f)), taken) });
    }
    const moves = actions.filter(a => a.kind === "move").length;
    const groups = [...new Set(actions.filter(a => a.kind === "move").map(a => basename(dirname((a as any).to))))];
    return { actions, needsApproval: moves > 0, summary: moves ? `Move ${moves} file(s) in ${op.folder} into ${groups.join(", ")}` : `Nothing to organise in ${op.folder}` };
  }
  if (op.op === "move" || op.op === "copy") {
    guard(op.dest);
    const found = files(op.folder, op.match);
    const actions: FileAction[] = existsSync(op.dest) ? [] : [{ kind: "mkdir", path: op.dest }];
    for (const f of found) actions.push(op.op === "move" ? { kind: "move", from: f, to: freeName(join(op.dest, basename(f)), taken) } : { kind: "copy", from: f, to: freeName(join(op.dest, basename(f)), taken) });
    return { actions, needsApproval: found.length > 0, summary: found.length ? `${op.op === "move" ? "Move" : "Copy"} ${found.length} file(s) from ${op.folder} to ${op.dest}` : `No matching files in ${op.folder}` };
  }
  // convert
  const conv = op as Extract<FileOp, { op: "convert" }>;
  const found = files(conv.folder, conv.match);
  const to = conv.to === "jpeg" ? "jpg" : conv.to;
  const actions: FileAction[] = [];
  const skipped: string[] = [];
  for (const f of found) {
    const from = ext(f);
    const ok = (IMAGE_FORMATS[from] && IMAGE_FORMATS[to]) || (to === "pdf" && TO_PDF_FROM.includes(from)) || (from === "csv" && to === "json") || (from === "json" && to === "csv");
    if (!ok) { skipped.push(basename(f)); continue; }
    actions.push({ kind: "convert", from: f, to: freeName(join(dirname(f), `${basename(f, extname(f))}.${to}`), taken) });
  }
  if (!actions.length) throw new FileOpError(found.length ? `I can't convert ${skipped.join(", ")} to ${to.toUpperCase()} (supported: images between PNG/JPG/BMP/GIF/TIFF; text, HTML and images to PDF; CSV to/from JSON).` : `No matching files in ${conv.folder}.`);
  return { actions, needsApproval: true, summary: `Convert ${actions.length} file(s) to ${to.toUpperCase()} (originals are kept)${skipped.length ? `; can't convert ${skipped.join(", ")}` : ""}` };
}

// ---------- execution ----------
function browserExe(): string | undefined {
  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].find(existsSync);
  }
  const pf = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const cands = pf.flatMap(p => [join(p, "Google", "Chrome", "Application", "chrome.exe"), join(p, "Microsoft", "Edge", "Application", "msedge.exe")]);
  return cands.find(existsSync);
}

const SIPS_FORMAT: Record<string, string> = { jpg: "jpeg", jpeg: "jpeg", png: "png", bmp: "bmp", gif: "gif", tif: "tiff", tiff: "tiff" };

async function convert(from: string, to: string): Promise<string> {
  const a = ext(from), b = ext(to);
  if (IMAGE_FORMATS[a] && IMAGE_FORMATS[b] && process.platform === "darwin") {
    // macOS's own imaging tool.
    const p = Bun.spawnSync(["sips", "-s", "format", SIPS_FORMAT[b], from, "--out", to], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0 || !existsSync(to)) throw new FileOpError(`image conversion failed: ${p.stderr.toString().slice(0, 200)}`);
    return "converted with sips";
  }
  if (IMAGE_FORMATS[a] && IMAGE_FORMATS[b]) {
    // Windows' own imaging (System.Drawing). JPEG has no transparency, so it is drawn on white.
    const ps = `Add-Type -AssemblyName System.Drawing; $src = [System.Drawing.Image]::FromFile($args[0]); ` +
      `$bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); ` +
      `$g.Clear([System.Drawing.Color]::White); $g.DrawImage($src, 0, 0, $src.Width, $src.Height); $g.Dispose(); $src.Dispose(); ` +
      `$bmp.Save($args[1], [System.Drawing.Imaging.ImageFormat]::${IMAGE_FORMATS[b]}); $bmp.Dispose()`;
    const p = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `& { ${ps} }`, from, to], { stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new FileOpError(`image conversion failed: ${p.stderr.toString().slice(0, 200)}`);
    return "converted with Windows imaging";
  }
  if (b === "pdf") {
    const exe = browserExe();
    if (!exe) throw new FileOpError("no Chrome or Edge found to print to PDF");
    let source = from;
    if (["txt", "md", "json", "csv"].includes(a)) {
      // Plain text is wrapped in a page so it prints with line breaks kept.
      const esc = readFileSync(from, "utf8").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
      source = join(tmpdir(), `agent-${Date.now()}.html`);
      writeFileSync(source, `<!doctype html><meta charset="utf-8"><title>${basename(from)}</title><pre style="font:12pt Consolas,monospace;white-space:pre-wrap">${esc}</pre>`);
    }
    const profile = join(tmpdir(), `agent-pdf-${Date.now()}`);
    const p = Bun.spawnSync([exe, "--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--user-data-dir=${profile}`, `--print-to-pdf=${to}`, pathToFileURL(source).href], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    if (!existsSync(to)) throw new FileOpError(`printing to PDF failed (${p.exitCode}): ${p.stderr.toString().slice(0, 200)}`);
    return `printed to PDF with ${basename(exe)} (headless)`;
  }
  if (a === "csv" && b === "json") {
    const [head, ...rows] = readFileSync(from, "utf8").split(/\r?\n/).filter(Boolean).map(splitCsv);
    writeFileSync(to, JSON.stringify(rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))), null, 2));
    return "converted CSV to JSON";
  }
  if (a === "json" && b === "csv") {
    const data = JSON.parse(readFileSync(from, "utf8"));
    if (!Array.isArray(data)) throw new FileOpError("the JSON is not a list of rows");
    const head = [...new Set(data.flatMap((r: object) => Object.keys(r)))];
    const q = (v: unknown) => { const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    writeFileSync(to, [head.join(","), ...data.map((r: any) => head.map(h => q(r[h])).join(","))].join("\n") + "\n");
    return "converted JSON to CSV";
  }
  throw new FileOpError(`no converter for ${a} -> ${b}`);
}

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Runs the actions in order, then checks every one on disk. Never deletes; refuses to overwrite. */
export async function runFiles(actions: FileAction[]): Promise<{ ok: boolean; detail: string }[]> {
  const results: { ok: boolean; detail: string }[] = [];
  for (const a of actions) {
    try {
      if (a.kind === "mkdir") { mkdirSync(a.path, { recursive: true }); results.push({ ok: existsSync(a.path), detail: `made folder ${a.path}` }); continue; }
      if (a.kind === "open") { openInExplorer(a.path); results.push({ ok: existsSync(a.path), detail: `opened ${a.path}` }); continue; }
      const target = a.kind === "write" ? a.path : a.to;
      if (existsSync(target)) throw new FileOpError(`${target} already exists; not overwriting`);
      if (a.kind === "write") { writeFileSync(a.path, a.text); results.push({ ok: readFileSync(a.path, "utf8") === a.text, detail: `wrote ${a.path}` }); continue; }
      if (a.kind === "move") { renameSync(a.from, a.to); results.push({ ok: existsSync(a.to) && !existsSync(a.from), detail: `moved ${basename(a.from)} -> ${a.to}` }); continue; }
      if (a.kind === "copy") { copyFileSync(a.from, a.to); results.push({ ok: existsSync(a.to) && statSync(a.to).size === statSync(a.from).size, detail: `copied ${basename(a.from)} -> ${a.to}` }); continue; }
      const how = await convert(a.from, a.to);
      results.push({ ok: existsSync(a.to) && statSync(a.to).size > 0 && looksLike(a.to), detail: `${basename(a.from)} -> ${basename(a.to)} (${how})` });
    } catch (e) {
      results.push({ ok: false, detail: `${a.kind}: ${(e as Error).message}` });
    }
  }
  return results;
}

// ---------- find by name ----------
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const FILLER = new Set(["my", "the", "a", "an", "folder", "folders", "file", "files", "called", "named", "document", "directory"]);

/** "Year One", "year-1", "Year_1st" all become ["year", "1"]: case, separators and number words don't matter. */
export function nameTokens(s: string): string[] {
  return s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .flatMap(t => t.match(/^([a-z]+)(\d+)$/) ? [t.replace(/\d+$/, ""), t.replace(/^[a-z]+/, "")] : [t])
    .map(t => {
      const n = NUMBER_WORDS.indexOf(t); if (n >= 0) return String(n);
      const o = ORDINALS.indexOf(t); if (o > 0) return String(o);
      return t.replace(/^(\d+)(st|nd|rd|th)$/, "$1");
    });
}

/** Folders/files under `root` whose name has every word of `name` (fuzzy as above), best first. Read-only, bounded. */
export function findByName(root: string, name: string, want: "folder" | "file" | "any", limitMs = 6000): { path: string; isDir: boolean }[] {
  const q = nameTokens(name).filter(t => !FILLER.has(t));
  if (!q.length) return [];
  const t0 = Date.now(), hits: { path: string; isDir: boolean; score: number }[] = [];
  const skipDir = /^(appdata|node_modules|\.git|\$recycle\.bin|application data|local settings|cookies|nethood|printhood|recent|sendto|start menu|templates|my documents|\.venv|venv|__pycache__)$/i;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || Date.now() - t0 > limitMs || hits.length > 200) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const full = join(dir, e.name), isDir = e.isDirectory();
      if ((want === "any" || (want === "folder") === isDir)) {
        const toks = nameTokens(e.name);
        if (q.every(t => toks.includes(t))) hits.push({ path: full, isDir, score: (toks.length === q.length ? 2 : 1) + (isDir === (want !== "file") ? 1 : 0) - depth * 0.01 });
      }
      if (isDir && !skipDir.test(e.name)) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return hits.sort((a, b) => b.score - a.score).slice(0, 10).map(({ path, isDir }) => ({ path, isDir }));
}

/** Shows a folder (or selects a file) in File Explorer. Windows; Finder on the Mac. */
function openInExplorer(path: string) {
  const isDir = statSync(path).isDirectory();
  if (process.platform === "darwin") Bun.spawn(isDir ? ["open", path] : ["open", "-R", path], { stdout: "ignore", stderr: "ignore" });
  else Bun.spawn(isDir ? ["explorer.exe", path] : ["explorer.exe", `/select,${path}`], { stdout: "ignore", stderr: "ignore" });
}

/** Checks the file header matches its extension (a real PNG, JPEG, PDF...). */
function looksLike(path: string): boolean {
  const b = readFileSync(path).subarray(0, 8);
  switch (ext(path)) {
    case "png": return b[0] === 0x89 && b[1] === 0x50;
    case "jpg": case "jpeg": return b[0] === 0xff && b[1] === 0xd8;
    case "gif": return b.toString("ascii", 0, 3) === "GIF";
    case "bmp": return b.toString("ascii", 0, 2) === "BM";
    case "pdf": return b.toString("ascii", 0, 4) === "%PDF";
    case "tif": case "tiff": return (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d);
    case "json": try { JSON.parse(readFileSync(path, "utf8")); return true; } catch { return false; }
    default: return true;
  }
}

/** Undo for moves (moves back); copies and conversions are new files and are listed, not deleted. */
export function undoMoves(actions: FileAction[]): { ok: boolean; detail: string }[] {
  const results = actions.filter((a): a is Extract<FileAction, { kind: "move" }> => a.kind === "move").reverse().map(a => {
    try {
      if (!existsSync(a.to)) return { ok: false, detail: `${a.to} is gone` };
      if (existsSync(a.from)) return { ok: false, detail: `${a.from} exists again; left both` };
      renameSync(a.to, a.from);
      return { ok: true, detail: `moved back ${basename(a.from)}` };
    } catch (e) { return { ok: false, detail: (e as Error).message }; }
  });
  // Folders the move created and that are empty again go too (rmdir refuses a folder that has anything in it).
  for (const a of [...actions].reverse()) {
    if (a.kind === "mkdir" && existsSync(a.path) && !readdirSync(a.path).length) try { rmdirSync(a.path); } catch { /* keep it */ }
  }
  return results;
}

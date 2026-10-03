// Replica claims form + oracle. GET / serves the form, POST /submit stores a claim,
// GET /api/claims is the independent source of truth the agent checks after Submit.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClaimRecord {
  id: number; payee: string; amount: string; date: string; category: string; paidBy: string; notes: string; t: string;
}

const HERE = import.meta.dir;
const FORM_FILE = join(HERE, "form.html");
const DIRTY = { payee: "Chan Tai Man", amount: "128.50", date: "30/09/2026", notes: "" };
const NO_STORE = { "Cache-Control": "no-store" };

// Served to Chromium only (Windows agent browser). Safari gets the untouched native <select> its measured recipe uses.
const CHROMIUM_SELECT = readFileSync(join(HERE, "chromium-select.css"), "utf8");
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const render = (v: Record<string, string>, chromium: boolean) => readFileSync(FORM_FILE, "utf8")
  .replace("{{chromiumSelect}}", chromium ? CHROMIUM_SELECT : "")
  .replace(/\{\{(\w+)\}\}/g, (_, k) => esc(v[k] ?? ""));

export function startReplica(opts: { port?: number; dbFile?: string } = {}) {
  const port = opts.port ?? Number(process.env.REPLICA_PORT ?? 8765);
  const dbFile = opts.dbFile ?? join(HERE, "..", "runs", "replica-claims.jsonl");
  mkdirSync(dirname(dbFile), { recursive: true });
  let claims: ClaimRecord[] = existsSync(dbFile)
    ? readFileSync(dbFile, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l))
    : [];

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        // ?dirty=1 pre-fills the form for the naive evidence arm (disclosed in the README).
        const chromium = /Chrome\/|Chromium\/|Edg\//.test(req.headers.get("user-agent") ?? "");
        const html = render(url.searchParams.get("dirty") === "1" ? DIRTY : {}, chromium);
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
      }
      if (req.method === "POST" && url.pathname === "/submit") {
        const f = await req.formData();
        const get = (k: string) => String(f.get(k) ?? "");
        const rec: ClaimRecord = {
          id: (claims.at(-1)?.id ?? 0) + 1,
          payee: get("payee"), amount: get("amount"), date: get("date"),
          category: get("category"), paidBy: get("paidBy"), notes: get("notes"),
          t: new Date().toISOString(),
        };
        claims.push(rec);
        appendFileSync(dbFile, JSON.stringify(rec) + "\n");
        const page = `<!doctype html><html><head><meta charset="utf-8"><title>Claim received</title></head>
<body style="font:16px system-ui,sans-serif;margin:24px auto;max-width:520px;padding:0 16px">
<h1>Claim received</h1><p>Reference #${rec.id}</p><p><a href="/">Submit another claim</a></p></body></html>`;
        return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
      }
      if (req.method === "GET" && url.pathname === "/api/claims") {
        return Response.json(claims, { headers: NO_STORE });
      }
      if (req.method === "POST" && url.pathname === "/api/reset") {
        claims = [];
        writeFileSync(dbFile, "");
        return Response.json({ ok: true }, { headers: NO_STORE });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
}

if (import.meta.main) {
  const s = startReplica();
  console.log(`replica claims form on http://127.0.0.1:${s.port}/`);
}

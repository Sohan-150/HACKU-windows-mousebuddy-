import io
def sub(path, old, new):
    s = io.open(path, encoding="utf-8").read(); assert old in s, (path, old[:70]); io.open(path, "w", encoding="utf-8").write(s.replace(old, new))
P = "src/driver/win.ts"
sub(P, '''  private apps?: string[];''', '''  private apps?: string[];
  private launchInfo = new Map<string, { aumid?: string; path?: string }>();''')
sub(P, '''    const r = await cuaCall("list_apps", {}, 20_000);
    const names = (r.data?.apps ?? []).map((a: any) => String(a.name ?? "")).filter((n: string) => n && !/\.exe$|!|\\/.test(n));
    this.apps = [...new Set<string>(names)].sort().slice(0, 300);
    return this.apps;''', '''    const r = await cuaCall("list_apps", {}, 20_000);
    for (const a of r.data?.apps ?? []) {
      const name = String(a.name ?? "");
      if (!name || /\.exe$|!|\\/.test(name)) continue;
      // Packaged apps launch by AUMID; desktop apps by the launch path list_apps gives (display names alone may not resolve).
      const lp: string | undefined = a.launch_path ?? undefined;
      const aumid = lp?.startsWith("shell:appsFolder\\\\") ? lp.slice("shell:appsFolder\\\\".length) : undefined;
      if (!this.launchInfo.has(name.toLowerCase())) this.launchInfo.set(name.toLowerCase(), { aumid, path: aumid ? undefined : lp });
    }
    this.apps = [...this.launchInfo.keys()].map(k => (r.data.apps as any[]).find(a => String(a.name).toLowerCase() === k).name as string).sort().slice(0, 300);
    return this.apps;''')
sub(P, '''    const la = await cuaCall("launch_app", { session: hand, name: app }, 30_000);
    const lerr = errorOf(la.data);
    if (lerr) throw new DriverError(lerr.code, `could not start '${app}': ${lerr.hint ?? ""}`);
    const want = lc(app).replace(/\.exe$/, "");''', '''    if (!this.apps) await this.listApps().catch(() => {});
    const info = this.launchInfo.get(lc(app));
    const how = info?.aumid ? { aumid: info.aumid } : info?.path ? { launch_path: info.path } : { name: app };
    const la = await cuaCall("launch_app", { session: hand, ...how }, 30_000);
    const lerr = errorOf(la.data);
    if (lerr) throw new DriverError(lerr.code, `could not start '${app}': ${lerr.hint ?? ""}`);
    // Match windows on the meaningful word(s) of the name: "Windows Notepad" -> "notepad".
    const want = lc(app).replace(/\.exe$/, "").replace(/\b(windows|microsoft)\b/g, "").trim() || lc(app);''')

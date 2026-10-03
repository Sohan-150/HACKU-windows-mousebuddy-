# Backstage fast lane for Windows: presses and text inserts straight through UI Automation, the twin of the Mac
# version's FastLane.swift.
#
# Why: Cua Driver runs every action through one input lane in its daemon (about 0.6 s per click, and two apps at the
# same time take as long as one after the other). The same Invoke sent directly through UI Automation takes a few
# milliseconds, and agents in different apps really act at the same time. Cua stays in charge of everything else
# (reading windows, the agent's browser, keys, scrolling, launching), and of these two actions whenever the fast lane
# can't do them safely. UI Automation is built into Windows: nothing to install, no permission prompt.
#
# Protocol: one JSON request per line on stdin, one JSON reply per line on stdout (requests run at the same time).
#   {"id":1,"op":"press","pid":123,"hwnd":456,"x":10,"y":20,"w":40,"h":30,"role":"Button","label":"Seven"}
#   {"id":2,"op":"type", ...same..., "text":"hello"}
#   {"id":3,"op":"restore","hwnd":456}       a minimised window shown again, without taking the foreground
#   -> {"id":1,"ok":true,"ms":3.1,"how":"hit-test invoke"}  or  {"id":1,"ok":false,"error":"..."}
# On start it prints {"ready":true}. Coordinates are physical screen pixels (the same space as Cua's frames).
#
# Safety: an element is only acted on if its process, control type, frame (within 3 pixels) and name match what the
# agent saw. Text is only set in native fields (never inside a web page, where the page wouldn't notice the change),
# and only reported as done if the field's value really changed. A press that opens a modal dialog can block
# Invoke: after 1.5 s it is reported as done (it happened), so Cua never presses a second time. Nothing is done
# after 3 s of looking (the server would have given up and asked Cua by the time it was done).
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Web.Script.Serialization;

public static class FastLane {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);

    static readonly object writeLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static TextWriter stdout;
    static readonly Dictionary<string, ControlType> types = new Dictionary<string, ControlType>(StringComparer.OrdinalIgnoreCase);

    static void Reply(Dictionary<string, object> d) {
        lock (writeLock) { try { stdout.WriteLine(json.Serialize(d)); stdout.Flush(); } catch { } }
    }

    static string Norm(string s) {
        if (s == null) return "";
        var sb = new StringBuilder(); bool space = false;
        foreach (char c in s.ToLowerInvariant()) {
            if (char.IsWhiteSpace(c)) { if (!space && sb.Length > 0) sb.Append(' '); space = true; }
            else { sb.Append(c); space = false; }
        }
        return sb.ToString().Trim();
    }

    static string ValueOf(AutomationElement e) {
        try { object p; if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) return ((ValuePattern)p).Current.Value; } catch { }
        return null;
    }

    class Target {
        public int Pid; public long Hwnd; public Rect R; public string Role = "", Label = "";
        public System.Windows.Point Center { get { return new System.Windows.Point(R.X + R.Width / 2, R.Y + R.Height / 2); } }
        public bool Matches(AutomationElement e) {
            try {
                var c = e.Current;
                if (c.ProcessId != Pid || c.ControlType == null || !string.Equals(c.ControlType.ProgrammaticName, "ControlType." + Role, StringComparison.OrdinalIgnoreCase)) return false;
                var f = c.BoundingRectangle;
                if (f.IsEmpty) return false;
                if (Math.Abs(f.X - R.X) > 3 || Math.Abs(f.Y - R.Y) > 3 || Math.Abs(f.Width - R.Width) > 3 || Math.Abs(f.Height - R.Height) > 3) return false;
                string want = Norm(Label);
                if (want == "") return true;
                foreach (var v in new string[] { c.Name, c.HelpText, c.AutomationId }) {
                    string have = Norm(v);
                    if (have != "" && (have == want || have.Contains(want) || want.Contains(have))) return true;
                }
                string val = Norm(ValueOf(e));
                return val != "" && (val == want || val.Contains(want) || want.Contains(val));
            } catch { return false; }
        }
    }

    /** the element the agent meant: hit-test at its centre and walk up, else a search of the app's windows */
    static AutomationElement Locate(Target t, Stopwatch sw, out string how) {
        how = "";
        try {
            var e = AutomationElement.FromPoint(t.Center);
            for (int i = 0; i < 8 && e != null; i++) {
                if (t.Matches(e)) { how = "hit-test"; return e; }
                e = TreeWalker.ControlViewWalker.GetParent(e);
            }
        } catch { }
        // behind another window (the agents work in the background), or the hit-test landed on a sibling: search the
        // app's windows, descending only into elements that overlap the target (like the Mac version), for 600 ms
        ControlType type;
        if (!types.TryGetValue(t.Role, out type)) return null;
        var roots = new List<AutomationElement>();
        try {
            if (t.Hwnd != 0) {
                var w = AutomationElement.FromHandle(new IntPtr(t.Hwnd));
                if (w != null && w.Current.ProcessId == t.Pid) roots.Add(w);
            }
        } catch { }
        try {
            foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, t.Pid))) {
                bool dup = false;
                foreach (var r in roots) if (Automation.Compare(r, w)) { dup = true; break; }
                if (!dup) roots.Add(w);
            }
        } catch { }
        long until = sw.ElapsedMilliseconds + 600;
        foreach (var root in roots) {
            if (t.Matches(root)) { how = "search"; return root; }
            var found = Search(t, type, root, sw, until);
            if (found != null) { how = "search"; return found; }
        }
        return null;
    }

    /** breadth-first, children fetched with their frame and type in one call each, pruned to the target's frame */
    static AutomationElement Search(Target t, ControlType type, AutomationElement root, Stopwatch sw, long until) {
        var cr = new CacheRequest();
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        var near = t.R; near.Inflate(2, 2);
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        int seen = 0;
        using (cr.Activate()) {
            while (queue.Count > 0 && sw.ElapsedMilliseconds < until && seen < 5000) {
                AutomationElementCollection kids;
                try { kids = queue.Dequeue().FindAll(TreeScope.Children, Condition.TrueCondition); } catch { continue; }
                foreach (AutomationElement k in kids) {
                    seen++;
                    Rect f; ControlType ct;
                    try { f = k.Cached.BoundingRectangle; ct = k.Cached.ControlType; } catch { continue; }
                    if (ct == type && !f.IsEmpty && Math.Abs(f.X - t.R.X) <= 3 && Math.Abs(f.Y - t.R.Y) <= 3 && t.Matches(k)) return k;
                    if (f.IsEmpty || f.IntersectsWith(near)) queue.Enqueue(k);
                }
            }
        }
        return null;
    }

    /** runs an action that may block (Invoke on a button that opens a modal dialog); true = it finished in time */
    static bool Bounded(Action a, int ms, out Exception error) {
        Exception err = null;
        var th = new Thread(() => { try { a(); } catch (Exception e) { err = e; } });
        th.IsBackground = true;
        th.Start();
        bool finished = th.Join(ms);
        error = err;
        return finished;
    }

    static string Press(AutomationElement e) {
        object p;
        Exception err;
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) {
            var inv = (InvokePattern)p;
            // still running after 1.5 s: a modal dialog opened, so the press happened
            if (!Bounded(() => inv.Invoke(), 1500, out err)) return "invoke (still running)";
            if (err != null) throw err;
            return "invoke";
        }
        if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggle"; }
        if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "select"; }
        if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
            var ec = (ExpandCollapsePattern)p;
            if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) { ec.Collapse(); return "collapse"; }
            ec.Expand(); return "expand";
        }
        throw new Exception("it can't be pressed through UI Automation");
    }

    static string Lines(string s) { return (s ?? "").Replace("\r\n", "\n").Replace("\r", "\n"); }

    static string SetText(AutomationElement e, string text) {
        var c = e.Current;
        if (c.FrameworkId == "Chrome") throw new Exception("inside a web page: needs key events");
        object p;
        if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out p)) throw new Exception("the field takes no value");
        var vp = (ValuePattern)p;
        if (vp.Current.IsReadOnly) throw new Exception("the field is read-only");
        string before = vp.Current.Value;
        Exception err;
        if (!Bounded(() => vp.SetValue(text), 1500, out err)) throw new Exception("no answer from the field");
        if (err != null) throw err;
        string after = Lines(vp.Current.Value), want = Lines(text);
        // only "done" if the field really holds the text now (some fields accept the write and ignore it)
        if (want == "" ? after == "" : after.Contains(want)) return before == vp.Current.Value ? "set value (unchanged)" : "set value";
        throw new Exception("the field did not change");
    }

    static void Handle(Dictionary<string, object> r) {
        var sw = Stopwatch.StartNew();
        var d = new Dictionary<string, object>();
        d["id"] = r.ContainsKey("id") ? r["id"] : 0;
        try {
            string op = Str(r, "op");
            if (op == "restore") {
                // a minimised window shown again WITHOUT taking the foreground (SW_SHOWNOACTIVATE)
                var h = new IntPtr((long)Num(r, "hwnd"));
                if (h == IntPtr.Zero) throw new Exception("no window");
                if (IsIconic(h)) ShowWindowAsync(h, 4);
                d["ok"] = true; d["how"] = "restore";
                d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
                Reply(d);
                return;
            }
            var t = new Target();
            t.Pid = (int)Num(r, "pid"); t.Hwnd = (long)Num(r, "hwnd");
            t.R = new Rect(Num(r, "x"), Num(r, "y"), Math.Max(0, Num(r, "w")), Math.Max(0, Num(r, "h")));
            t.Role = Str(r, "role").Replace(" ", ""); t.Label = Str(r, "label");
            if (t.Pid <= 0 || t.Role == "") throw new Exception("bad request");
            if (t.R.Width <= 0 || t.R.Height <= 0) throw new Exception("no frame");
            string how;
            var e = Locate(t, sw, out how);
            if (e == null) throw new Exception("element not found where the agent saw it");
            if (!e.Current.IsEnabled) throw new Exception("the control is disabled");
            // never act late: the server stops waiting after 6 s and has Cua do it (this and a 1.5 s press stay under that)
            if (sw.ElapsedMilliseconds > 3000) throw new Exception("finding it took too long: left to Cua");
            if (op == "press") how += " " + Press(e);
            else if (op == "type") how += " " + SetText(e, Str(r, "text"));
            else throw new Exception("unknown op " + op);
            d["ok"] = true; d["how"] = how;
        } catch (Exception ex) {
            d["ok"] = false; d["error"] = ex.Message;
        }
        d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1);
        Reply(d);
    }

    static string Str(Dictionary<string, object> r, string k) { object v; return r.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
    static double Num(Dictionary<string, object> r, string k) { object v; try { return r.TryGetValue(k, out v) && v != null ? Convert.ToDouble(v) : 0; } catch { return 0; } }

    public static void Run() {
        // physical pixels, like Cua's frames (per-monitor aware where Windows has it)
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        foreach (var f in typeof(ControlType).GetFields(BindingFlags.Public | BindingFlags.Static))
            if (f.FieldType == typeof(ControlType)) types[f.Name] = (ControlType)f.GetValue(null);
        json.MaxJsonLength = int.MaxValue;
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var hello = new Dictionary<string, object>(); hello["ready"] = true;
        Reply(hello);
        string line;
        while ((line = stdin.ReadLine()) != null) {
            Dictionary<string, object> req;
            try { req = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
            if (req == null) continue;
            var one = req;
            ThreadPool.QueueUserWorkItem(_ => Handle(one));
        }
    }
}
"@
[FastLane]::Run()

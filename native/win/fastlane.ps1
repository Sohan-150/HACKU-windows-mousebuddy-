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
#   {"id":4,"op":"read","hwnd":456,"max":1500}   the window's controls in ONE cached call (name, type, frame, value,
#        toggle, selected, expanded, enabled, offscreen) -> {"ok":true,"seq":7,"title":"...","elements":[{"i":0,...}]}
#   {"id":5,"op":"press","ref":"456:7:12"} / {"op":"type","ref":"456:7:12","text":"hi"}   act on a control from that read
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
    // the controls of each window's latest read, so an action needs no search: window -> (read number, index -> control)
    static readonly Dictionary<long, KeyValuePair<int, List<AutomationElement>>> reads = new Dictionary<long, KeyValuePair<int, List<AutomationElement>>>();
    static int readSeq;

    /** all the window's controls in one call: a cached FindAll returns every property at once (the fast way to read
     *  UI Automation; walking the tree control by control costs a round trip each) */
    static void Read(Dictionary<string, object> r, Dictionary<string, object> d) {
        long hw = (long)Num(r, "hwnd");
        int max = (int)Num(r, "max"); if (max <= 0) max = 1500;
        var root = AutomationElement.FromHandle(new IntPtr(hw));
        if (root == null) throw new Exception("no such window");
        var cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.IsOffscreenProperty);
        cr.Add(ValuePattern.ValueProperty); cr.Add(TogglePattern.ToggleStateProperty); cr.Add(SelectionItemPattern.IsSelectedProperty);
        cr.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        AutomationElementCollection all;
        using (cr.Activate()) all = root.FindAll(TreeScope.Descendants, Automation.ControlViewCondition);
        var list = new List<object>();
        var keep = new List<AutomationElement>();
        foreach (AutomationElement e in all) {
            if (keep.Count >= max) break;
            Rect f; ControlType ct;
            try { f = e.Cached.BoundingRectangle; ct = e.Cached.ControlType; } catch { continue; }
            if (f.IsEmpty || f.Width < 1 || f.Height < 1 || ct == null) continue;
            var o = new Dictionary<string, object>();
            o["i"] = keep.Count;
            o["role"] = ct.ProgrammaticName.Replace("ControlType.", "");
            string name = ""; try { name = e.Cached.Name ?? ""; } catch { }
            o["name"] = name;
            object v = Cached(e, ValuePattern.ValueProperty); if (v is string && (string)v != "") o["value"] = ((string)v).Length > 2000 ? ((string)v).Substring(0, 2000) : v;
            object tg = Cached(e, TogglePattern.ToggleStateProperty); if (tg is ToggleState) o["toggle"] = (ToggleState)tg == ToggleState.On ? "on" : "off";
            object sel = Cached(e, SelectionItemPattern.IsSelectedProperty); if (sel is bool && (bool)sel) o["selected"] = true;
            object ex = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty); if (ex is ExpandCollapseState) o["expanded"] = (ExpandCollapseState)ex == ExpandCollapseState.Expanded;
            try { if (!e.Cached.IsEnabled) o["enabled"] = false; } catch { }
            try { if (e.Cached.IsOffscreen) o["offscreen"] = true; } catch { }
            o["x"] = Math.Round(f.X); o["y"] = Math.Round(f.Y); o["w"] = Math.Round(f.Width); o["h"] = Math.Round(f.Height);
            list.Add(o);
            keep.Add(e);
        }
        int seq;
        lock (reads) { seq = ++readSeq; reads[hw] = new KeyValuePair<int, List<AutomationElement>>(seq, keep); }
        string title = ""; try { title = root.Current.Name ?? ""; } catch { }
        d["ok"] = true; d["seq"] = seq; d["title"] = title; d["elements"] = list; d["how"] = "read " + list.Count;
    }

    static object Cached(AutomationElement e, AutomationProperty p) {
        try { var v = e.GetCachedPropertyValue(p, true); return v == AutomationElement.NotSupported ? null : v; } catch { return null; }
    }

    /** a control from a window's latest read ("hwnd:read:index"); null when that read is no longer the latest */
    static AutomationElement FromRef(string reference) {
        var parts = reference.Split(':');
        if (parts.Length != 3) return null;
        long hw; int seq, i;
        if (!long.TryParse(parts[0], out hw) || !int.TryParse(parts[1], out seq) || !int.TryParse(parts[2], out i)) return null;
        lock (reads) {
            KeyValuePair<int, List<AutomationElement>> got;
            if (!reads.TryGetValue(hw, out got) || got.Key != seq || i < 0 || i >= got.Value.Count) return null;
            return got.Value[i];
        }
    }

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
                // the process is not compared: a Store app's window belongs to its frame host (ApplicationFrameHost) and
                // its buttons to the app itself (CalculatorApp), so they never match. Type, name and frame identify it.
                if (c.ControlType == null || !string.Equals(c.ControlType.ProgrammaticName, "ControlType." + Role, StringComparison.OrdinalIgnoreCase)) return false;
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
        // app's windows, descending only into elements that overlap the target (like the Mac version), for 300 ms
        ControlType type;
        if (!types.TryGetValue(t.Role, out type)) return null;
        var roots = new List<AutomationElement>();
        try {
            if (t.Hwnd != 0) {
                var w = AutomationElement.FromHandle(new IntPtr(t.Hwnd));
                if (w != null) roots.Add(w);    // the agent's own window (its process may differ: Store apps)
            }
        } catch { }
        try {
            foreach (AutomationElement w in AutomationElement.RootElement.FindAll(TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, t.Pid))) {
                bool dup = false;
                foreach (var r in roots) if (Automation.Compare(r, w)) { dup = true; break; }
                if (!dup) roots.Add(w);
            }
        } catch { }
        long until = sw.ElapsedMilliseconds + 300;
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
        // a list row without Invoke (a chat in a chat list): Select would only highlight it; a real click opens it (Cua)
        var ct = e.Current.ControlType;
        if (ct == ControlType.ListItem || ct == ControlType.DataItem || ct == ControlType.TreeItem) throw new Exception("a list row needs a click");
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
            if (op == "read") { Read(r, d); d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1); Reply(d); return; }
            string reference = Str(r, "ref");
            if (reference != "") {
                // a control from the latest read: no search, act at once
                var el = FromRef(reference);
                if (el == null) throw new Exception("stale: the window was read again since");
                if (!el.Current.IsEnabled) throw new Exception("the control is disabled");
                string done = op == "press" ? Press(el) : op == "type" ? SetText(el, Str(r, "text")) : null;
                if (done == null) throw new Exception("unknown op " + op);
                d["ok"] = true; d["how"] = "ref " + done;
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

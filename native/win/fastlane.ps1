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
#   {"id":6,"op":"windows"}   every visible top-level window (like Cua's list_windows, in milliseconds)
#   {"id":8,"op":"front_type","hwnd":456,"ref":"456:7:12","text":"hi","vk":13,"cx":0,"cy":0,"replace":true}
#        the foreground fallback: the window comes to the front, the control is focused and the screen point cx,cy (if
#        any) clicked ("soft": only when it could not be focused), SendInput types (Unicode; replace = Ctrl+A first) and/or presses the key vk, the user's window
#        goes back. A target can also be given like a press (pid, x, y, w, h,
#        role, label); with no target it types into whatever the window has focused.
#   {"id":7,"op":"shot","hwnd":456,"max":1280}   a picture of the window for the model -> {path, imgW, imgH, k, sx, sy}; a
#        point (x, y) in it is window-local pixel (x*k, y*k) for Cua's click (same origin as Cua's own screenshots), and
#        screen pixel (sx + x*k, sy + y*k)
#   -> {"id":1,"ok":true,"ms":3.1,"how":"hit-test invoke"}  or  {"id":1,"ok":false,"error":"..."}
# On start it prints {"ready":true}. Coordinates are physical screen pixels (the same space as Cua's frames).
#
# Safety: an element is only acted on if its process, control type, frame (within 3 pixels) and name match what the
# agent saw. Text is only set in native fields (never inside a web page, where the page wouldn't notice the change),
# and only reported as done if the field's value really changed. A press that opens a modal dialog can block
# Invoke: after 1.5 s it is reported as done (it happened), so Cua never presses a second time. Nothing is done
# after 3 s of looking (the server would have given up and asked Cua by the time it was done).
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions, System.Drawing -TypeDefinition @"
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
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT value, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetInt(IntPtr hWnd, int attr, out int value, int size);
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct WINDOWPLACEMENT { public int length, flags, showCmd; public int minX, minY, maxX, maxY; public RECT normal; }
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT wp);
    static readonly Dictionary<uint, string> exeOf = new Dictionary<uint, string>();

    // ---- the foreground fallback: SendInput into a field, for apps that ignore background typing (web editors in
    // WebView2 / Electron apps such as WhatsApp). The window comes to the front for a moment, then the user's goes back.
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")] static extern uint ThreadOf(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    static INPUT Key(ushort vk, ushort scan, uint flags) {
        var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
    }

    [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    static readonly object frontLock = new object();

    static INPUT Mouse(uint flags) {
        var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; return i;
    }

    static bool Front(IntPtr h) {
        for (int attempt = 0; attempt < 2; attempt++) {
            // a zero mouse move makes this process the last one to send input, which lets it set the foreground
            if (attempt > 0) SendInput(1, new INPUT[] { Mouse(1) }, Marshal.SizeOf(typeof(INPUT)));
            var fg = GetForegroundWindow();
            uint me = GetCurrentThreadId(), other = fg == IntPtr.Zero ? 0 : ThreadOf(fg, IntPtr.Zero);
            bool attached = other != 0 && other != me && AttachThreadInput(me, other, true);
            if (IsIconic(h)) ShowWindow(h, 9);
            BringWindowToTop(h); SetForegroundWindow(h);
            if (attached) AttachThreadInput(me, other, false);
            for (int i = 0; i < 8 && GetForegroundWindow() != h; i++) Thread.Sleep(15);
            if (GetForegroundWindow() == h) return true;
        }
        return false;
    }

    /** focus the control and click the point (a web view's renderer only takes real keyboard focus from a click), type
     *  the text (Unicode keystrokes; replace = select all first) and/or press a key (vk), with its window in front for a
     *  moment; one at a time (there is one foreground) */
    static string FrontType(AutomationElement e, IntPtr window, string text, int vk, int clickX, int clickY, bool replace, bool soft) {
        RECT wr;
        if (clickX > 0 && GetWindowRect(window, out wr) && (clickX < wr.Left || clickX >= wr.Right || clickY < wr.Top || clickY >= wr.Bottom))
            throw new Exception("the point is outside the window");
        // one at a time; a request that waited 4 s for another agent's turn gives up (the server stops waiting at 8 s, and
        // must never see it done late)
        if (!Monitor.TryEnter(frontLock, 4000)) throw new Exception("the foreground was busy with another agent");
        try {
            var before = GetForegroundWindow();
            try {
                if (!Front(window)) throw new Exception("the window would not come to the front");
                Thread.Sleep(80);
                string how = "";
                bool focused = false;
                if (e != null) { try { e.SetFocus(); focused = true; how = "focus "; } catch { } Thread.Sleep(60); }
                if (clickX > 0 && clickY > 0 && !(soft && focused)) {
                    // a real click on the field, and the pointer goes back
                    POINT was; GetCursorPos(out was);
                    SetCursorPos(clickX, clickY);
                    SendInput(2, new INPUT[] { Mouse(2), Mouse(4) }, Marshal.SizeOf(typeof(INPUT)));   // LEFTDOWN, LEFTUP
                    Thread.Sleep(120);
                    SetCursorPos(was.X, was.Y);
                    how += "click ";
                }
                var keys = new List<INPUT>();
                text = text ?? "";
                if (replace && text != "") {   // Ctrl+A: the field's old text is replaced, as a background type would
                    keys.Add(Key(0x11, 0, 0)); keys.Add(Key(0x41, 0, 0)); keys.Add(Key(0x41, 0, 2)); keys.Add(Key(0x11, 0, 2));
                }
                foreach (char c in (text ?? "").Replace("\r", "").Replace("\n", " ")) { keys.Add(Key(0, c, 4)); keys.Add(Key(0, c, 4 | 2)); }   // KEYEVENTF_UNICODE (| KEYUP)
                if (vk > 0) { keys.Add(Key((ushort)vk, 0, 0)); keys.Add(Key((ushort)vk, 0, 2)); }
                if (keys.Count > 0) {
                    // (a click alone is done whatever came to the front after it, a dialog it opened for one: never
                    // reported as failed, so it is never clicked a second time)
                    if (GetForegroundWindow() != window) throw new Exception("the window lost the front before typing");
                    uint sent = SendInput((uint)keys.Count, keys.ToArray(), Marshal.SizeOf(typeof(INPUT)));
                    if (sent != keys.Count) throw new Exception("the keystrokes were blocked");
                }
                Thread.Sleep(Math.Min(1000, 150 + 2 * keys.Count));   // the app takes the keys before its window goes back
                return (how + (text != "" ? "typed " : "") + (vk > 0 ? "key " + vk + " " : "") + "in front").Trim();
            } finally {
                if (before != IntPtr.Zero && before != window) Front(before);   // the user's window goes back in front
            }
        } finally { Monitor.Exit(frontLock); }
    }

    static string Exe(uint pid) {
        lock (exeOf) {
            string n;
            if (exeOf.TryGetValue(pid, out n)) return n;
            try { n = Process.GetProcessById((int)pid).ProcessName + ".exe"; } catch { n = ""; }
            exeOf[pid] = n;
            return n;
        }
    }

    static string TitleOf(IntPtr h) {
        int n = GetWindowTextLength(h);
        if (n <= 0) return "";
        var sb = new StringBuilder(n + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    /** every top-level window a person could see, top to bottom (EnumWindows: milliseconds, no new process) */
    static void Windows(Dictionary<string, object> d) {
        var list = new List<object>();
        var order = new List<IntPtr>();
        EnumProc cb = (h, l) => { order.Add(h); return true; };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        for (int i = 0; i < order.Count; i++) {
            var h = order[i];
            if (!IsWindowVisible(h)) continue;
            int cloaked; if (DwmGetInt(h, 14, out cloaked, 4) == 0 && cloaked != 0) continue;   // DWMWA_CLOAKED: on another desktop, or a hidden app frame
            string title = TitleOf(h);
            if (title == "") continue;
            RECT r; if (!GetWindowRect(h, out r)) continue;
            bool small = IsIconic(h);
            if (small) {
                // a minimised window sits at -32000 with a title bar's size: its size when shown again is what counts
                var wp = new WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT));
                if (GetWindowPlacement(h, ref wp)) r = wp.normal;
            }
            uint pid; GetWindowThreadProcessId(h, out pid);
            var w = new Dictionary<string, object>();
            w["window_id"] = (long)h; w["pid"] = (long)pid; w["title"] = title; w["app_name"] = Exe(pid);
            var b = new Dictionary<string, object>(); b["x"] = r.Left; b["y"] = r.Top; b["width"] = r.Right - r.Left; b["height"] = r.Bottom - r.Top;
            w["bounds"] = b; w["minimized"] = small; w["z_index"] = order.Count - i;
            list.Add(w);
        }
        d["ok"] = true; d["windows"] = list;
    }

    /** a picture of one window (PrintWindow: covered windows too), cropped like Cua's screenshots (the visible frame
     *  plus a 1 px inset), so a point in it is a window-local pixel for Cua's click; scaled for the model */
    static void Shot(Dictionary<string, object> r, Dictionary<string, object> d) {
        var h = new IntPtr((long)Num(r, "hwnd"));
        int max = (int)Num(r, "max"); if (max <= 0) max = 1280;
        RECT wr; if (!GetWindowRect(h, out wr)) throw new Exception("no such window");
        if (IsIconic(h)) throw new Exception("the window is minimised");
        int ww = wr.Right - wr.Left, wh = wr.Bottom - wr.Top;
        if (ww < 20 || wh < 20) throw new Exception("the window is too small");
        RECT fr; int ox = 0, oy = 0, cw = ww, ch = wh;
        if (DwmGetWindowAttribute(h, 9, out fr, 16) == 0) { ox = fr.Left + 1 - wr.Left; oy = fr.Top + 1 - wr.Top; cw = fr.Right - fr.Left - 2; ch = fr.Bottom - fr.Top - 2; }
        using (var full = new System.Drawing.Bitmap(ww, wh, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
            using (var g = System.Drawing.Graphics.FromImage(full)) {
                IntPtr dc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(h, dc, 2); } finally { g.ReleaseHdc(dc); }
                if (!ok) throw new Exception("the window could not be captured");
            }
            double k = Math.Max(1.0, Math.Max(cw, ch) / (double)max);
            int iw = (int)Math.Round(cw / k), ih = (int)Math.Round(ch / k);
            var path = Path.Combine(Path.GetTempPath(), "backstage-window-" + DateTime.Now.Ticks + ".png");
            using (var small = new System.Drawing.Bitmap(iw, ih, System.Drawing.Imaging.PixelFormat.Format24bppRgb)) {
                using (var g = System.Drawing.Graphics.FromImage(small)) {
                    g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                    g.DrawImage(full, new System.Drawing.Rectangle(0, 0, iw, ih), new System.Drawing.Rectangle(ox, oy, cw, ch), System.Drawing.GraphicsUnit.Pixel);
                }
                small.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
            d["ok"] = true; d["path"] = path; d["imgW"] = iw; d["imgH"] = ih; d["k"] = k; d["winW"] = cw; d["winH"] = ch;
            d["sx"] = wr.Left + ox; d["sy"] = wr.Top + oy;   // the picture's top-left corner on the screen
        }
    }

    /** the same app's pop-ups over a window (menus, drop-downs, context menus are windows of their own) */
    static List<IntPtr> PopupsOf(IntPtr main) {
        uint pid; GetWindowThreadProcessId(main, out pid);
        var found = new List<IntPtr>();
        EnumProc cb = (h, l) => {
            if (h == main || !IsWindowVisible(h)) return true;
            uint p; GetWindowThreadProcessId(h, out p);
            if (p != pid) return true;
            const int WS_POPUP = unchecked((int)0x80000000);
            int style = GetWindowLong(h, -16), ex = GetWindowLong(h, -20);
            bool popup = (style & WS_POPUP) != 0 || (ex & 0x8) != 0 || GetWindow(h, 4) == main;   // a pop-up, topmost, or owned by the window
            RECT r; if (!popup || !GetWindowRect(h, out r) || r.Right - r.Left < 8 || r.Bottom - r.Top < 8) return true;
            found.Add(h);
            return found.Count < 4;
        };
        EnumWindows(cb, IntPtr.Zero);
        GC.KeepAlive(cb);
        return found;
    }

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
        var collections = new List<AutomationElementCollection>();
        using (cr.Activate()) {
            // an open menu or drop-down is a window of its own: read it first, it is what the user is looking at
            if (Str(r, "popups") != "False") {
                foreach (var ph in PopupsOf(new IntPtr(hw))) {
                    try { var pr = AutomationElement.FromHandle(ph); if (pr != null) collections.Add(pr.FindAll(TreeScope.Subtree, Automation.ControlViewCondition)); } catch { }
                }
            }
            collections.Add(root.FindAll(TreeScope.Descendants, Automation.ControlViewCondition));
        }
        var list = new List<object>();
        var keep = new List<AutomationElement>();
        foreach (var all in collections)
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
            if (op == "windows") { Windows(d); d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1); Reply(d); return; }
            if (op == "shot") { Shot(r, d); d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1); Reply(d); return; }
            if (op == "front_type") {
                var win = new IntPtr((long)Num(r, "hwnd"));
                AutomationElement target = null;
                string rf = Str(r, "ref");
                if (rf != "") target = FromRef(rf);
                else if (Num(r, "w") > 0) {
                    var tt = new Target(); tt.Pid = (int)Num(r, "pid"); tt.Hwnd = (long)Num(r, "hwnd");
                    tt.R = new Rect(Num(r, "x"), Num(r, "y"), Num(r, "w"), Num(r, "h")); tt.Role = Str(r, "role").Replace(" ", ""); tt.Label = Str(r, "label");
                    string how0; target = Locate(tt, sw, out how0);
                }
                if (win == IntPtr.Zero) throw new Exception("no window");
                if (target == null && (rf != "" || Num(r, "w") > 0) && Num(r, "cx") <= 0) throw new Exception("the field was not found (and no point to click)");
                if (target != null && Num(r, "cx") > 0) {
                    bool off = false; try { off = target.Current.IsOffscreen; } catch { }
                    if (off) throw new Exception("the control is out of view: scroll to it first");
                }
                int vk = (int)Num(r, "vk"); if (vk <= 0 && Str(r, "enter") == "True") vk = 0x0D;
                d["ok"] = true; d["how"] = FrontType(target, win, Str(r, "text"), vk, (int)Num(r, "cx"), (int)Num(r, "cy"), Str(r, "replace") == "True", Str(r, "soft") == "True");
                d["ms"] = Math.Round(sw.Elapsed.TotalMilliseconds, 1); Reply(d); return;
            }
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

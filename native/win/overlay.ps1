# Backstage Overlay for Windows: the on-screen half of the agent, the twin of the Mac version's Overlay.swift.
#
#  * A small buddy follows the cursor (35 px to the right). It shows listening / thinking / the answer, and flies to the
#    thing it is explaining.
#  * Drawings over the screen: rings, boxes, circles, underlines, arrows and labels in mint, which draw themselves in and
#    fade away (a lesson step stays until "next"). Click-through.
#  * While agents work, each one has a widget in the bottom-right corner: its colour, its app, what it is doing now, a
#    running clock, and its result. Every press or text insert flashes a ring in the agent's colour where it happened.
#    The widgets can be dragged anywhere (they stay there); everything else lets clicks through.
#  * Answers are spoken: the MP3 parts the server fetched (ElevenLabs), else the Windows voice.
#  * Keys: Esc stops the voice (press it again within 2 s to clear the drawings); Alt + Right / Left move through a
#    lesson. They are global hotkeys registered only while they mean something, so the rest of the time they belong to
#    your apps. Holding the talk keys is voice.py's job; a tap opens the typing box here.
#  * The screen is captured here the moment the talk keys go down (before the buddy shows anything), and every window of
#    this app is excluded from screen captures (SetWindowDisplayAffinity), so it is never in a screenshot.
#  * A tray icon has the menu: ask or give a job, clear drawings, stop the agents, hide the buddy when idle, quit.
#
# Protocol: JSON lines on stdin from the server, JSON lines on stdout to it. Coordinates are physical screen pixels, the
# same space as Cua's window bounds and element frames. Exits when stdin closes.
#   in:  hello {key} | capture {id} | listening | status {text} | idle | typebox | clear | error {text}
#        answer {seq, say, shapes[], step?, fadeMs, audio: "follows"|"system"} | audio {seq, part, path} | speak {seq, part, say}
#        agents {running, tasks[]} | tap {colour, x, y, w, h}
#   out: ready | captured {id, path, imgW, imgH, x, y, w, h, cx, cy} | ask {text, cursor} | step {go} | dismiss | stop | key {what} | quit
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions, System.Speech -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.Synthesis;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

public static class Native {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int a, int b, int c, int d, int e, int f);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; public POINT(int x, int y) { this.x = x; this.y = y; } }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; public SIZE(int cx, int cy) { this.cx = cx; this.cy = cy; } }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
    [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint affinity);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string command, StringBuilder ret, int retLen, IntPtr callback);

    /** brings one of our windows to the front although another app has the focus (Windows refuses a plain call) */
    public static void Focus(IntPtr hwnd) {
        IntPtr fg = GetForegroundWindow();
        uint other = GetWindowThreadProcessId(fg, IntPtr.Zero), me = GetCurrentThreadId();
        bool attached = other != me && AttachThreadInput(other, me, true);
        SetForegroundWindow(hwnd);
        if (attached) AttachThreadInput(other, me, false);
    }
}

/** the look: the Mac version's colours */
public static class Look {
    public static readonly Color MINT = Color.FromArgb(51, 212, 153);
    public static readonly Color CORAL = Color.FromArgb(255, 107, 107);
    public static readonly Color INK = Color.FromArgb(240, 15, 23, 41);
    public static float S = 1f;                                   // physical pixels per Mac point (the screen's scale)
    public static int P(float v) { return (int)Math.Round(v * S); }
    public static Font Font(float px, FontStyle style) { return new Font("Segoe UI", px * S, style, GraphicsUnit.Pixel); }
    public static Font Semibold(float px) {
        try { return new Font("Segoe UI Semibold", px * S, FontStyle.Regular, GraphicsUnit.Pixel); } catch { return Font(px, FontStyle.Bold); }
    }
    public static Color Hex(string hex, Color fallback) {
        try { var h = (hex ?? "").TrimStart('#'); int v = Convert.ToInt32(h, 16); return Color.FromArgb((v >> 16) & 255, (v >> 8) & 255, v & 255); } catch { return fallback; }
    }
    public static Color A(Color c, double alpha) { return Color.FromArgb(Math.Max(0, Math.Min(255, (int)(alpha * 255))), c.R, c.G, c.B); }
    public static GraphicsPath Round(RectangleF r, float radius) {
        var p = new GraphicsPath(); float d = Math.Max(0.1f, Math.Min(radius * 2, Math.Min(r.Width, r.Height)));
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90); p.CloseFigure();
        return p;
    }
    public static Graphics Begin(Bitmap b) {
        var g = Graphics.FromImage(b);
        g.SmoothingMode = SmoothingMode.AntiAlias; g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.Clear(Color.Transparent);
        return g;
    }
    /** a soft glow under a stroke (the Mac's shadow), then the stroke itself */
    public static void Glow(Graphics g, GraphicsPath path, Color c, float width, float[] dash) {
        float[] widths = { width + P(10), width + P(6), width + P(3) };
        int[] alphas = { 28, 50, 90 };
        for (int i = 0; i < widths.Length; i++) {
            using (var pen = new Pen(Color.FromArgb(alphas[i], c), widths[i])) { Style(pen, dash, widths[i]); g.DrawPath(pen, path); }
        }
        using (var pen = new Pen(c, width)) { Style(pen, dash, width); g.DrawPath(pen, path); }
    }
    static void Style(Pen pen, float[] dash, float width) {
        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
        if (dash != null) { pen.DashStyle = DashStyle.Custom; pen.DashPattern = new float[] { Math.Max(0.01f, dash[0] / width), Math.Max(0.01f, dash[1] / width) }; }
    }
}

/** a window drawn with per-pixel alpha (soft edges, glow, fades), on top, never activated, never in a screen capture */
public class Layered : Form {
    protected bool clickThrough = true;
    public Layered() { FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual; Size = new Size(1, 1); }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x80000 | 0x80 | 0x8 | 0x08000000;      // layered, tool window, topmost, never activated
            if (clickThrough) cp.ExStyle |= 0x20;                  // clicks go to the window below
            return cp;
        }
    }
    protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); try { Native.SetWindowDisplayAffinity(Handle, 0x11); } catch { } }
    public int X0, Y0;
    /** puts the picture on screen with its top-left at (x, y) */
    public void Present(Bitmap bmp, int x, int y, byte opacity) {
        if (!IsHandleCreated) CreateControl();
        if (!Visible) Show();                                      // a layered window shows nothing until it is given a picture
        X0 = x; Y0 = y;
        IntPtr screen = Native.GetDC(IntPtr.Zero), mem = Native.CreateCompatibleDC(screen), hbmp = IntPtr.Zero, old = IntPtr.Zero;
        try {
            hbmp = bmp.GetHbitmap(Color.FromArgb(0));
            old = Native.SelectObject(mem, hbmp);
            var size = new Native.SIZE(bmp.Width, bmp.Height); var src = new Native.POINT(0, 0); var dst = new Native.POINT(x, y);
            var blend = new Native.BLENDFUNCTION(); blend.BlendOp = 0; blend.BlendFlags = 0; blend.SourceConstantAlpha = opacity; blend.AlphaFormat = 1;
            Native.UpdateLayeredWindow(Handle, screen, ref dst, ref size, mem, ref src, 0, ref blend, 2);
        } finally {
            if (old != IntPtr.Zero) Native.SelectObject(mem, old);
            if (hbmp != IntPtr.Zero) Native.DeleteObject(hbmp);
            Native.DeleteDC(mem); Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }
}

public class Shape {
    public string Kind = "", Text = "";
    public RectangleF Rect;
    public PointF From, To;
    public static Shape Of(Dictionary<string, object> d) {
        var s = new Shape(); s.Kind = J.S(d, "kind"); s.Text = J.S(d, "text");
        if (s.Kind == "") return null;
        s.Rect = new RectangleF(J.F(d, "x"), J.F(d, "y"), J.F(d, "w"), J.F(d, "h"));
        var f = J.O(d, "from"); var t = J.O(d, "to");
        if (f != null) s.From = new PointF(J.F(f, "x"), J.F(f, "y"));
        if (t != null) s.To = new PointF(J.F(t, "x"), J.F(t, "y"));
        return s;
    }
    /** where the buddy flies to: just right of the thing */
    public PointF Anchor {
        get {
            if (Kind == "arrow") return new PointF(To.X + Look.P(14), To.Y + Look.P(10));
            if (Kind == "label") return new PointF(Rect.X + Look.P(14), Rect.Y + Look.P(14));
            return new PointF(Rect.Right + Look.P(10), Rect.Y + Rect.Height / 2);
        }
    }
    public RectangleF Bounds {
        get {
            if (Kind == "arrow") return RectangleF.FromLTRB(Math.Min(From.X, To.X), Math.Min(From.Y, To.Y), Math.Max(From.X, To.X), Math.Max(From.Y, To.Y));
            return Rect;
        }
    }
}

/** the drawings: one click-through window over the shapes, drawn in one after another, then faded */
public class Canvas : Layered {
    List<Shape> shapes = new List<Shape>();
    DateTime born; double fadeMs; bool animating;
    Rectangle area;
    public void Display(List<Shape> list, double fade) {
        shapes = list; born = DateTime.Now; fadeMs = fade; animating = shapes.Count > 0;
        if (shapes.Count == 0) { Clear(); return; }
        RectangleF u = shapes[0].Bounds;
        foreach (var s in shapes) u = RectangleF.Union(u, s.Bounds);
        var vs = SystemInformation.VirtualScreen;
        int m = Look.P(170);
        area = Rectangle.Intersect(vs, Rectangle.FromLTRB((int)u.Left - m, (int)u.Top - m, (int)u.Right + m, (int)u.Bottom + m));
        if (area.Width < 2 || area.Height < 2) { Clear(); return; }
        Render(255);
    }
    public void Clear() { shapes = new List<Shape>(); animating = false; fadeMs = 0; if (Visible) Hide(); }
    /** 60 times a second while drawing in or fading */
    public void Tick() {
        if (shapes.Count == 0) return;
        double age = (DateTime.Now - born).TotalMilliseconds;
        if (fadeMs > 0 && age > fadeMs) {
            double left = fadeMs + 600 - age;
            if (left <= 0) { Clear(); return; }
            Render((byte)(255 * left / 600));
            return;
        }
        if (animating) { Render(255); if (age > 450 + 120 * shapes.Count + 200) animating = false; }
    }
    void Render(byte opacity) {
        using (var b = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
        using (var g = Look.Begin(b)) {
            g.TranslateTransform(-area.X, -area.Y);
            double now = (DateTime.Now - born).TotalSeconds;
            for (int i = 0; i < shapes.Count; i++) {
                double t = Math.Max(0, now - i * 0.12);
                Draw(g, shapes[i], (float)Math.Min(1, t / 0.45));
            }
            Present(b, area.X, area.Y, opacity);
        }
    }
    void Stroke(Graphics g, GraphicsPath path, float length, float p, float width) {
        Look.Glow(g, path, Look.MINT, width, p < 1 ? new float[] { Math.Max(0.1f, length * p), length * 2 } : null);
    }
    void Label(Graphics g, string text, PointF p, bool below, bool right, float alpha) {
        if (string.IsNullOrEmpty(text) || alpha <= 0) return;
        using (var font = Look.Semibold(14)) {
            var size = g.MeasureString(text, font, Look.P(260));
            float w = size.Width + Look.P(18), h = size.Height + Look.P(10);
            RectangleF r = right ? new RectangleF(p.X + Look.P(10), p.Y - h / 2, w, h)
                : new RectangleF(below ? p.X - size.Width / 2 - Look.P(9) : p.X + Look.P(10), below ? p.Y + Look.P(8) : p.Y - size.Height - Look.P(20), w, h);
            r.X = Math.Min(Math.Max(r.X, area.X + 4), area.Right - r.Width - 4);
            r.Y = Math.Min(Math.Max(r.Y, area.Y + 4), area.Bottom - r.Height - 4);
            using (var path = Look.Round(r, Look.P(8)))
            using (var fill = new SolidBrush(Look.A(Look.INK, 0.94 * alpha)))
            using (var pen = new Pen(Look.A(Look.MINT, alpha), Look.P(1.5f))) { g.FillPath(fill, path); g.DrawPath(pen, path); }
            using (var ink = new SolidBrush(Look.A(Color.White, alpha))) g.DrawString(text, font, ink, new RectangleF(r.X + Look.P(9), r.Y + Look.P(5), size.Width + 2, size.Height + 2));
        }
    }
    void Draw(Graphics g, Shape s, float p) {
        float textAlpha = Math.Max(0, Math.Min(1, (p - 0.6f) / 0.4f));
        if (s.Kind == "ring" || s.Kind == "box") {
            float pad = s.Kind == "ring" ? Look.P(6) : Look.P(3);
            var r = RectangleF.Inflate(s.Rect, pad, pad);
            float radius = s.Kind == "ring" ? Math.Min(Look.P(12), r.Height / 2) : Look.P(4);
            using (var path = Look.Round(r, radius)) Stroke(g, path, 2 * (r.Width + r.Height), p, Look.P(3.5f));
            Label(g, s.Text, new PointF(r.X + r.Width / 2, r.Bottom), true, false, textAlpha);
        } else if (s.Kind == "circle") {
            var r = RectangleF.Inflate(s.Rect, Math.Max(Look.P(10), s.Rect.Width * 0.12f), Math.Max(Look.P(10), s.Rect.Height * 0.25f));
            using (var path = new GraphicsPath()) { path.AddEllipse(r); Stroke(g, path, (float)(Math.PI * (r.Width + r.Height) / 2), p, Look.P(3.5f)); }
            Label(g, s.Text, new PointF(r.X + r.Width / 2, r.Bottom), true, false, textAlpha);
        } else if (s.Kind == "underline") {
            float y = s.Rect.Bottom + Look.P(3);
            using (var path = new GraphicsPath()) {
                path.AddBezier(new PointF(s.Rect.X, y), new PointF(s.Rect.X + s.Rect.Width * 0.33f, y + Look.P(3)), new PointF(s.Rect.X + s.Rect.Width * 0.66f, y - Look.P(2)), new PointF(s.Rect.Right, y));
                Stroke(g, path, Math.Max(1, s.Rect.Width), p, Look.P(4));
            }
            Label(g, s.Text, new PointF(s.Rect.Right, s.Rect.Y + s.Rect.Height / 2), false, true, textAlpha);
        } else if (s.Kind == "arrow") {
            PointF a = s.From, b2 = s.To;
            var mid = new PointF((a.X + b2.X) / 2, (a.Y + b2.Y) / 2);
            float len = (float)Math.Sqrt((b2.X - a.X) * (b2.X - a.X) + (b2.Y - a.Y) * (b2.Y - a.Y));
            var c = new PointF(mid.X - (b2.Y - a.Y) * 0.22f, mid.Y + (b2.X - a.X) * 0.22f);   // a gentle curve
            using (var path = new GraphicsPath()) { path.AddBezier(a, c, c, b2); Stroke(g, path, Math.Max(1, len * 1.1f), p, Look.P(3.5f)); }
            if (p > 0.85f) {
                double ang = Math.Atan2(b2.Y - c.Y, b2.X - c.X);
                using (var head = new GraphicsPath()) {
                    foreach (double d in new double[] { Math.PI * 0.84, -Math.PI * 0.84 }) {
                        head.StartFigure();
                        head.AddLine(b2, new PointF(b2.X + Look.P(16) * (float)Math.Cos(ang + d), b2.Y + Look.P(16) * (float)Math.Sin(ang + d)));
                    }
                    Look.Glow(g, head, Look.MINT, Look.P(3.5f), null);
                }
            }
            Label(g, s.Text, a, false, false, textAlpha);
        } else if (s.Kind == "label") {
            if (p > 0) {
                using (var dot = new GraphicsPath()) {
                    dot.AddEllipse(s.Rect.X - Look.P(5), s.Rect.Y - Look.P(5), Look.P(10), Look.P(10));
                    using (var glow = new Pen(Color.FromArgb(70, Look.MINT), Look.P(6))) g.DrawPath(glow, dot);
                    using (var fill = new SolidBrush(Look.MINT)) g.FillPath(fill, dot);
                }
            }
            Label(g, s.Text, new PointF(s.Rect.X, s.Rect.Y), false, false, Math.Min(1, p * 1.5f));
        }
    }
}

/** where an agent acted: a quick ring in its colour, growing and fading */
public class Pulse : Layered {
    Rectangle target; Color colour; DateTime born = DateTime.Now;
    public const double Life = 0.7;
    public Pulse(Rectangle r, Color c) { target = r; colour = c; }
    public bool Tick() {
        double k = Math.Min(1, (DateTime.Now - born).TotalSeconds / Life);
        if (k >= 1) { Close(); return false; }
        int m = Look.P(26);
        var area = Rectangle.Inflate(target, m, m);
        using (var b = new Bitmap(Math.Max(2, area.Width), Math.Max(2, area.Height), PixelFormat.Format32bppArgb))
        using (var g = Look.Begin(b)) {
            float grow = Look.P(2 + 10 * (float)k);
            var r = new RectangleF(m - grow, m - grow, target.Width + 2 * grow, target.Height + 2 * grow);
            using (var path = Look.Round(r, Math.Min(Look.P(12), r.Height / 2))) Look.Glow(g, path, Look.A(colour, 0.95 * (1 - k)), Look.P(3), null);
            Present(b, area.X, area.Y, 255);
        }
        return true;
    }
}

/** one agent's widget */
public class Card {
    public string Id = "", Name = "", App = "", Goal = "", Status = "queued", Now = "", Answer = "", Reason = "";
    public Color Colour = Look.MINT;
    public double Seconds;
    public DateTime? StartedAt;                       // when this overlay first saw it running (the clock ticks between updates)
}

/** the agents' widgets, bottom right (drag them anywhere: they stay there) */
public class Dock : Layered {
    public List<Card> Cards = new List<Card>();
    DateTime? hideAt;
    bool down, moved; Point downCursor, downAt; Point? placed;
    const int W = 300, H = 70, GAP = 8;
    public Dock() { clickThrough = false; }
    public void Apply(Dictionary<string, object> m) {
        bool running = J.B(m, "running");
        var old = new Dictionary<string, Card>();
        foreach (var c in Cards) old[c.Id] = c;
        var cards = new List<Card>();
        foreach (var o in J.L(m, "tasks")) {
            var d = o as Dictionary<string, object>; if (d == null) continue;
            var c = new Card();
            c.Id = J.S(d, "id"); c.Name = J.S(d, "name"); if (c.Name == "") c.Name = "Agent";
            c.App = J.S(d, "app"); c.Goal = J.S(d, "goal"); c.Status = J.S(d, "status"); if (c.Status == "") c.Status = "queued";
            c.Now = J.S(d, "now"); c.Answer = J.S(d, "answer").Replace("\n", " "); c.Reason = J.S(d, "reason");
            c.Colour = Look.Hex(J.S(d, "colour"), Look.MINT); c.Seconds = J.F(d, "seconds");
            Card prev; old.TryGetValue(c.Id, out prev);
            c.StartedAt = prev != null && prev.StartedAt.HasValue ? prev.StartedAt : (c.Status == "running" ? (DateTime?)DateTime.Now.AddSeconds(-c.Seconds) : null);
            cards.Add(c);
        }
        Cards = cards;
        if (Cards.Count == 0) { Hide(); return; }
        hideAt = running ? (DateTime?)null : DateTime.Now.AddSeconds(15);       // results stay readable, then the widgets go
        Render();
    }
    /** 20 times a second: the clocks, the breathing dots, the fade */
    public void Tick() {
        if (Cards.Count == 0) return;
        byte opacity = 255;
        if (hideAt.HasValue) {
            double left = (hideAt.Value - DateTime.Now).TotalSeconds;
            if (left <= 0) { Cards = new List<Card>(); hideAt = null; Hide(); return; }
            if (left < 1) opacity = (byte)(255 * left);
        }
        Render(opacity);
    }
    void Render() { Render(255); }
    void Render(byte opacity) {
        int w = Look.P(W), h = Look.P(H), gap = Look.P(GAP);
        int total = Cards.Count * (h + gap) - gap;
        int x, y;
        if (down) { x = X0; y = Y0; }
        else if (placed.HasValue) { x = placed.Value.X; y = placed.Value.Y; }
        else { var wa = Screen.PrimaryScreen.WorkingArea; x = wa.Right - w - Look.P(16); y = wa.Bottom - total - Look.P(16); }
        double t = (DateTime.Now - DateTime.Today).TotalSeconds;
        using (var b = new Bitmap(w, Math.Max(2, total), PixelFormat.Format32bppArgb))
        using (var g = Look.Begin(b))
        using (var bold = Look.Semibold(13)) using (var small = Look.Font(11.5f, FontStyle.Regular)) using (var mono = Look.Font(11.5f, FontStyle.Bold)) {
            var trim = new StringFormat(StringFormatFlags.NoWrap); trim.Trimming = StringTrimming.EllipsisCharacter;
            for (int i = 0; i < Cards.Count; i++) {
                var c = Cards[i];
                var r = new RectangleF(0, i * (h + gap), w, h);
                var accent = c.Status == "failed" ? Look.CORAL : c.Colour;
                using (var card = Look.Round(RectangleF.Inflate(r, -1, -1), Look.P(12)))
                using (var fill = new SolidBrush(Look.INK)) using (var pen = new Pen(Look.A(accent, 0.85), Look.P(1.2f))) { g.FillPath(fill, card); g.DrawPath(pen, card); }
                // the agent's colour dot: breathing while it works
                bool running = c.Status == "running";
                float d = Look.P(running ? 10 + 2.5f * (float)Math.Sin(t * 5) : 10);
                var dot = new RectangleF(r.X + Look.P(18) - d / 2, r.Y + Look.P(18) - d / 2, d, d);
                using (var glow = new SolidBrush(Color.FromArgb(running ? 70 : 35, c.Colour))) g.FillEllipse(glow, RectangleF.Inflate(dot, Look.P(4), Look.P(4)));
                using (var fill = new SolidBrush(c.Colour)) g.FillEllipse(fill, dot);
                using (var white = new SolidBrush(Color.White)) using (var dim = new SolidBrush(Color.FromArgb(140, 255, 255, 255))) {
                    g.DrawString(c.Name, bold, white, r.X + Look.P(30), r.Y + Look.P(8));
                    float nameW = g.MeasureString(c.Name, bold).Width;
                    g.DrawString("  \u00b7  " + c.App, small, dim, new RectangleF(r.X + Look.P(30) + nameW, r.Y + Look.P(10), w - Look.P(130) - nameW, Look.P(16)), trim);
                    double secs = running ? (c.StartedAt.HasValue ? (DateTime.Now - c.StartedAt.Value).TotalSeconds : c.Seconds) : c.Seconds;
                    string badge = running ? string.Format("{0:0} s", secs) : c.Status == "done" ? string.Format("\u2713  {0:0.0} s", secs) : c.Status == "failed" ? "\u2715  stopped" : "waiting";
                    var badgeColour = c.Status == "done" ? Look.MINT : c.Status == "failed" ? Look.CORAL : Color.FromArgb(140, 255, 255, 255);
                    float bw = g.MeasureString(badge, mono).Width;
                    using (var bb = new SolidBrush(badgeColour)) g.DrawString(badge, mono, bb, r.Right - Look.P(14) - bw, r.Y + Look.P(9));
                    g.DrawString(c.Goal, small, dim, new RectangleF(r.X + Look.P(14), r.Y + Look.P(30), w - Look.P(28), Look.P(17)), trim);
                    string now = c.Status == "done" ? (c.Answer == "" ? "Done" : "\u2192 " + c.Answer)
                        : c.Status == "failed" ? (c.Reason == "" ? "Couldn't finish" : c.Reason)
                        : c.Now != "" ? c.Now : (running ? "working" + new string('.', (int)(t * 3) % 4) : "waiting for its turn");
                    var nowColour = c.Status == "failed" ? Look.CORAL : c.Status == "done" ? Color.White : Color.FromArgb(217, 255, 255, 255);
                    using (var nb = new SolidBrush(nowColour)) g.DrawString(now, small, nb, new RectangleF(r.X + Look.P(14), r.Y + Look.P(47), w - Look.P(28), Look.P(17)), trim);
                }
            }
            Present(b, x, y, opacity);
        }
    }
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button != MouseButtons.Left) return; down = true; moved = false; downCursor = Cursor.Position; downAt = new Point(X0, Y0); Capture = true; }
    protected override void OnMouseMove(MouseEventArgs e) {
        if (!down) return;
        var p = Cursor.Position; int dx = p.X - downCursor.X, dy = p.Y - downCursor.Y;
        if (!moved && Math.Abs(dx) + Math.Abs(dy) < 5) return;
        moved = true; X0 = downAt.X + dx; Y0 = downAt.Y + dy; Render();
    }
    protected override void OnMouseUp(MouseEventArgs e) { if (!down) return; down = false; Capture = false; if (moved) placed = new Point(X0, Y0); }
}

/** the buddy next to the cursor: listening / thinking / the answer; flies to what it explains */
public class Buddy : Layered {
    public string State = "idle", Words = "";
    public bool HiddenWhenIdle;
    PointF? flyTarget; PointF flyFrom; DateTime flyStart; PointF pos;
    public void Set(string state, string text) { State = state; Words = text ?? ""; }
    public void Home() { flyTarget = null; }
    public void Fly(PointF p) { flyFrom = pos; flyTarget = p; flyStart = DateTime.Now; }
    string Showing { get { double t = (DateTime.Now - DateTime.Today).TotalSeconds; return State == "thinking" ? Words + new string('.', (int)(t * 3) % 4) : Words; } }
    /** 60 times a second */
    public void Tick() {
        if (HiddenWhenIdle && State == "idle") { if (Visible) Hide(); return; }
        var m = Cursor.Position;
        var follow = new PointF(m.X + Look.P(35), m.Y + Look.P(8));
        if (flyTarget.HasValue) {
            double k = Math.Min(1, (DateTime.Now - flyStart).TotalSeconds / 0.55);
            k = k < 0.5 ? 2 * k * k : 1 - Math.Pow(-2 * k + 2, 2) / 2;                       // ease in and out
            pos = new PointF(flyFrom.X + (float)((flyTarget.Value.X - flyFrom.X) * k), flyFrom.Y + (float)((flyTarget.Value.Y - flyFrom.Y) * k));
        } else pos = follow;
        Render();
    }
    void Render() {
        double t = (DateTime.Now - DateTime.Today).TotalSeconds;
        string shown = Showing;
        using (var font = Look.Font(13.5f, FontStyle.Regular)) {
            SizeF ts = SizeF.Empty;
            using (var probe = new Bitmap(1, 1)) using (var pg = Graphics.FromImage(probe)) if (shown != "") ts = pg.MeasureString(shown, font, Look.P(300));
            float bw = shown == "" ? 0 : ts.Width + Look.P(22), bh = shown == "" ? 0 : ts.Height + Look.P(14);
            int w = (int)Math.Max(Look.P(30), Look.P(30) + bw + Look.P(4)), h = (int)Math.Max(Look.P(30), bh + Look.P(10));
            using (var b = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            using (var g = Look.Begin(b)) {
                double pulse = State == "listening" ? 1 + 0.25 * Math.Sin(t * 8) : 1;
                var colour = State == "listening" || State == "error" ? Look.CORAL : Look.MINT;
                float d = (float)(Look.P(12) * pulse);
                var dot = new RectangleF(Look.P(14) - d / 2, Look.P(14) - d / 2, d, d);
                using (var glow = new SolidBrush(Color.FromArgb(60, colour))) g.FillEllipse(glow, RectangleF.Inflate(dot, Look.P(4), Look.P(4)));
                using (var fill = new SolidBrush(Look.A(colour, State == "idle" ? 0.75 : 1))) g.FillEllipse(fill, dot);
                using (var ring = new Pen(Color.FromArgb(230, 255, 255, 255), Look.P(1.5f))) g.DrawEllipse(ring, dot);
                if (shown != "") {
                    var r = new RectangleF(Look.P(28), Look.P(4), bw, bh);
                    using (var path = Look.Round(r, Look.P(10)))
                    using (var fill = new SolidBrush(Look.INK)) using (var pen = new Pen(Look.A(colour, 0.9), Look.P(1.2f))) { g.FillPath(fill, path); g.DrawPath(pen, path); }
                    using (var white = new SolidBrush(Color.White)) g.DrawString(shown, font, white, new RectangleF(r.X + Look.P(11), r.Y + Look.P(7), ts.Width + 2, ts.Height + 2));
                }
                // the dot's centre sits on the target point
                Present(b, (int)(pos.X - Look.P(14)), (int)(pos.Y - Look.P(14)), 255);
            }
        }
    }
}

/** voice out: the MP3 parts the server fetched, else the Windows voice, one after another */
public class Voice {
    readonly Queue<string[]> queue = new Queue<string[]>();   // {"mp3", path} or {"text", words}
    SpeechSynthesizer synth;
    string defaultVoice;
    Prompt speaking;                                           // the Windows voice's sentence now
    string playing;                                            // the MCI alias playing now
    string playingFile;
    public bool Busy;
    public Action Done;
    public Voice() { try { synth = new SpeechSynthesizer(); synth.Rate = 1; defaultVoice = synth.Voice.Name; } catch { synth = null; } }
    public void Speak(string text) { Stop(); Add("text", text); }
    public void Add(string kind, string value) { queue.Enqueue(new string[] { kind, value }); if (!Busy) Next(); }
    int n;
    void Next() {
        if (queue.Count == 0) { Busy = false; if (Done != null) Done(); return; }
        Busy = true;
        var p = queue.Dequeue();
        if (p[0] == "mp3") {
            string alias = "bstk" + (++n);
            if (Native.mciSendString(string.Format("open \"{0}\" type mpegvideo alias {1}", p[1], alias), null, 0, IntPtr.Zero) == 0
                && Native.mciSendString("play " + alias, null, 0, IntPtr.Zero) == 0) { playing = alias; playingFile = p[1]; return; }
            Native.mciSendString("close " + alias, null, 0, IntPtr.Zero);
            Remove(p[1]);
            Next();
        } else {
            if (synth == null || p[1].Trim() == "") { Next(); return; }
            try {
                // the voice for the language it is written in (Chinese when it has Han characters)
                bool han = false; foreach (char ch in p[1]) if (ch >= 0x4e00 && ch <= 0x9fff) { han = true; break; }
                string want = defaultVoice;
                if (han) foreach (var v in synth.GetInstalledVoices()) if (v.VoiceInfo.Culture.Name.StartsWith("zh")) { want = v.VoiceInfo.Name; break; }
                if (want != null && synth.Voice.Name != want) synth.SelectVoice(want);
                speaking = synth.SpeakAsync(p[1]);
            } catch { speaking = null; Next(); }
        }
    }
    /** called 60 times a second: has the part playing now finished? */
    public void Tick() {
        if (!Busy) return;
        if (playing != null) {
            var sb = new StringBuilder(64);
            Native.mciSendString("status " + playing + " mode", sb, 64, IntPtr.Zero);
            var mode = sb.ToString();
            if (mode == "playing" || mode == "seeking" || mode == "not ready") return;
            Native.mciSendString("close " + playing, null, 0, IntPtr.Zero);
            Remove(playingFile);
            playing = null; playingFile = null;
            Next();
        } else if (speaking == null || speaking.IsCompleted) { speaking = null; Next(); }
    }
    public void Stop() {
        queue.Clear(); Busy = false;
        try { if (synth != null) synth.SpeakAsyncCancelAll(); } catch { }
        speaking = null;
        if (playing != null) { Native.mciSendString("stop " + playing, null, 0, IntPtr.Zero); Native.mciSendString("close " + playing, null, 0, IntPtr.Zero); Remove(playingFile); playing = null; playingFile = null; }
    }
    static void Remove(string f) { try { if (f != null) File.Delete(f); } catch { } }
}

/** the typing box (tap the talk keys): ask about the screen, or give the agents a job */
public class TypeBox : Form {
    readonly TextBox field = new TextBox();
    public Action<string> Submit;
    public Action WhenClosed;
    IntPtr previous;
    public TypeBox() {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(15, 23, 41); Size = new Size(Look.P(380), Look.P(40)); KeyPreview = true;
        field.BorderStyle = BorderStyle.None; field.BackColor = BackColor; field.ForeColor = Color.White;
        field.Font = Look.Font(15, FontStyle.Regular); field.Location = new Point(Look.P(14), Look.P(10)); field.Width = Look.P(352);
        Controls.Add(field);
        Region = Region.FromHrgn(Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Look.P(24), Look.P(24)));
        field.KeyDown += (s, e) => {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; var t = field.Text.Trim(); Close2(); if (t != "" && Submit != null) Submit(t); }
            else if (e.KeyCode == Keys.Escape) { e.SuppressKeyPress = true; Close2(); }
        };
        Deactivate += (s, e) => Close2();
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        try { Native.SetWindowDisplayAffinity(Handle, 0x11); } catch { }
        Native.SendMessage(field.Handle, 0x1501, (IntPtr)1, "Ask about your screen, or give the agents a job\u2026");   // EM_SETCUEBANNER
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Look.Round(new RectangleF(1, 1, Width - 3, Height - 3), Look.P(12))) using (var pen = new Pen(Look.MINT, Look.P(1.5f))) e.Graphics.DrawPath(pen, path);
    }
    public bool IsOpen { get { return Visible; } }
    public void Open(Point near) {
        previous = Native.GetForegroundWindow();
        var screen = Screen.FromPoint(near).WorkingArea;
        int x = Math.Min(Math.Max(near.X + Look.P(20), screen.Left + 8), screen.Right - Width - 8);
        int y = Math.Min(Math.Max(near.Y + Look.P(24), screen.Top + 8), screen.Bottom - Height - 8);
        Location = new Point(x, y);
        field.Text = "";
        Show(); Native.Focus(Handle); Activate(); field.Focus();
    }
    bool closing;
    public void Close2() {
        if (!Visible || closing) return;
        closing = true; Hide(); closing = false;
        if (previous != IntPtr.Zero) Native.Focus(previous);
        if (WhenClosed != null) WhenClosed();
    }
}

/** global hotkeys, registered only while they mean something */
public class Keys2 : NativeWindow {
    readonly Dictionary<int, Action> actions = new Dictionary<int, Action>();
    readonly HashSet<int> on = new HashSet<int>();
    public Keys2() { CreateHandle(new CreateParams()); }
    public void Set(int id, uint vk, uint mods, bool wanted, Action action) {
        actions[id] = action;
        if (wanted && !on.Contains(id)) { if (Native.RegisterHotKey(Handle, id, mods | 0x4000, vk)) on.Add(id); }
        else if (!wanted && on.Contains(id)) { Native.UnregisterHotKey(Handle, id); on.Remove(id); }
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0312) { Action a; if (actions.TryGetValue(m.WParam.ToInt32(), out a)) a(); }
        base.WndProc(ref m);
    }
}

public static class J {
    public static string S(Dictionary<string, object> m, string k) { object v; return m != null && m.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
    public static float F(Dictionary<string, object> m, string k) { object v; try { return m != null && m.TryGetValue(k, out v) && v != null ? Convert.ToSingle(v, System.Globalization.CultureInfo.InvariantCulture) : 0f; } catch { return 0f; } }
    public static int I(Dictionary<string, object> m, string k, int d) { object v; try { return m != null && m.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : d; } catch { return d; } }
    public static bool B(Dictionary<string, object> m, string k) { object v; return m != null && m.TryGetValue(k, out v) && v is bool && (bool)v; }
    public static Dictionary<string, object> O(Dictionary<string, object> m, string k) { object v; return m != null && m.TryGetValue(k, out v) ? v as Dictionary<string, object> : null; }
    public static List<object> L(Dictionary<string, object> m, string k) {
        var list = new List<object>(); object v;
        if (m != null && m.TryGetValue(k, out v) && v is IEnumerable && !(v is string)) foreach (var x in (IEnumerable)v) list.Add(x);
        return list;
    }
}

public static class Overlay {
    static readonly object writeLock = new object();
    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    // UTF-8 both ways, whatever the console's code page (the pipes are not a console)
    static readonly TextWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    static readonly TextReader stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    static Canvas canvas; static Dock dock; static Buddy buddy; static Voice voice; static TypeBox box; static Keys2 keys;
    static List<Pulse> pulses = new List<Pulse>();
    static NotifyIcon tray; static ToolStripMenuItem statusLine, talkLine;
    static int answerSeq, audioSeq = -1; static string answerSay = ""; static DateTime answerAt; static bool waitingAudio;
    static DateTime? idleAfter; static DateTime escAgainUntil = DateTime.MinValue; static bool lessonOn;
    static int frame;

    public static void Out(Dictionary<string, object> d) {
        lock (writeLock) { try { stdout.WriteLine(json.Serialize(d)); stdout.Flush(); } catch { } }
    }
    static Dictionary<string, object> Msg(string ev) { var d = new Dictionary<string, object>(); d["event"] = ev; return d; }

    public static void Run() {
        Native.SetProcessDPIAware();
        Application.EnableVisualStyles();
        json.MaxJsonLength = int.MaxValue;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) Look.S = Math.Max(1f, g.DpiX / 96f);
        canvas = new Canvas(); dock = new Dock(); buddy = new Buddy(); voice = new Voice(); box = new TypeBox(); keys = new Keys2();
        voice.Done = () => { buddy.Home(); idleAfter = DateTime.Now.AddSeconds(6); };   // keep the answer readable a little longer
        box.Submit = t => Ask(t);
        box.WhenClosed = () => { if (buddy.State == "idle") buddy.Set("idle", ""); };
        BuildTray();
        buddy.Set("idle", "");
        var host = new Control(); host.CreateControl();
        var reader = new Thread(() => {
            string line;
            while ((line = stdin.ReadLine()) != null) {
                Dictionary<string, object> m;
                try { m = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
                if (m == null) continue;
                try { host.BeginInvoke((Action)(() => { try { Handle(m); } catch { } })); } catch { }
            }
            try { host.BeginInvoke((Action)(() => { if (tray != null) tray.Visible = false; Application.Exit(); })); } catch { }
        });
        reader.IsBackground = true;
        reader.Start();
        var timer = new System.Windows.Forms.Timer(); timer.Interval = 16;
        timer.Tick += (s, e) => Tick();
        timer.Start();
        Out(Msg("ready"));
        Application.Run(new ApplicationContext());
    }

    static void BuildTray() {
        var menu = new ContextMenuStrip();
        statusLine = new ToolStripMenuItem("starting\u2026"); statusLine.Enabled = false; menu.Items.Add(statusLine);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Ask or give a job\u2026", null, (s, e) => OpenBox());
        menu.Items.Add("Clear drawings", null, (s, e) => { Out(Msg("dismiss")); Clear(); });
        menu.Items.Add("Stop the agents", null, (s, e) => Out(Msg("stop")));
        var hide = new ToolStripMenuItem("Hide the buddy when idle"); hide.CheckOnClick = true;
        hide.CheckedChanged += (s, e) => buddy.HiddenWhenIdle = hide.Checked;
        menu.Items.Add(hide);
        menu.Items.Add(new ToolStripSeparator());
        talkLine = new ToolStripMenuItem("Hold the talk keys to talk \u00b7 tap them to type"); talkLine.Enabled = false; menu.Items.Add(talkLine);
        var keysLine = new ToolStripMenuItem("Esc: stop talking (again: clear) \u00b7 Alt+\u2192 / Alt+\u2190: next / back"); keysLine.Enabled = false; menu.Items.Add(keysLine);
        menu.Items.Add("Quit Backstage Overlay", null, (s, e) => { Out(Msg("quit")); tray.Visible = false; Application.Exit(); });
        var icon = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(icon)) {
            g.SmoothingMode = SmoothingMode.AntiAlias; g.Clear(Color.Transparent);
            using (var b = new SolidBrush(Look.MINT)) g.FillEllipse(b, 5, 5, 22, 22);
            using (var p = new Pen(Color.White, 2.5f)) g.DrawEllipse(p, 5, 5, 22, 22);
        }
        tray = new NotifyIcon(); tray.Icon = Icon.FromHandle(icon.GetHicon()); tray.Text = "Backstage"; tray.ContextMenuStrip = menu; tray.Visible = true;
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) OpenBox(); };
    }

    static void Tick() {
        frame++;
        voice.Tick();
        buddy.Tick();
        canvas.Tick();
        if (frame % 3 == 0) dock.Tick();
        for (int i = pulses.Count - 1; i >= 0; i--) if (!pulses[i].Tick()) pulses.RemoveAt(i);
        // keys that exist only while they mean something
        keys.Set(1, 0x1B, 0, voice.Busy || DateTime.Now < escAgainUntil, Escape);
        keys.Set(2, 0x27, 0x1, lessonOn, () => LessonKey("next"));
        keys.Set(3, 0x25, 0x1, lessonOn, () => LessonKey("back"));
        if (idleAfter.HasValue && DateTime.Now > idleAfter.Value) { idleAfter = null; buddy.Set("idle", ""); }
        // the server is fetching a natural voice: if it doesn't arrive in time, the Windows voice says it
        if (waitingAudio && (DateTime.Now - answerAt).TotalSeconds > 6) { waitingAudio = false; if (answerSay != "") { var say = answerSay; answerSay = ""; voice.Speak(say); } }
    }

    static void Silence() { answerSay = ""; audioSeq = -1; waitingAudio = false; voice.Stop(); }
    static void Clear() { lessonOn = false; Silence(); canvas.Clear(); buddy.Home(); buddy.Set("idle", ""); }

    /** Esc: the first press silences the voice (drawings stay); a second press within 2 s clears them too */
    static void Escape() {
        if (voice.Busy) {
            var k = Msg("key"); k["what"] = "esc: stopped talking"; Out(k);
            Silence(); escAgainUntil = DateTime.Now.AddSeconds(2); buddy.Home(); idleAfter = DateTime.Now.AddSeconds(4);
        } else {
            escAgainUntil = DateTime.MinValue;
            var k = Msg("key"); k["what"] = "esc again: cleared"; Out(k);
            Out(Msg("dismiss")); Clear();
        }
    }

    /** Alt + Right / Left: the next or previous lesson step */
    static void LessonKey(string go) {
        var k = Msg("key"); k["what"] = "alt+" + (go == "next" ? "right" : "left") + ": " + go; Out(k);
        var s = Msg("step"); s["go"] = go; Out(s);
    }

    static void OpenBox() { Silence(); buddy.Home(); idleAfter = null; buddy.Set("idle", ""); box.Open(Cursor.Position); }

    static void Ask(string text) {
        canvas.Clear();                                                      // a new question: the old drawings go
        buddy.Set("thinking", "\u201c" + (text.Length > 60 ? text.Substring(0, 60) : text) + "\u201d \u2013 thinking");
        var m = Msg("ask"); m["text"] = text;
        var c = new Dictionary<string, object>(); c["x"] = Cursor.Position.X; c["y"] = Cursor.Position.Y; m["cursor"] = c;
        Out(m);
    }

    /** the screen under the cursor, as it is now (this app's windows are never in it), scaled for the model */
    static void Capture(Dictionary<string, object> m) {
        var r = Msg("captured"); r["id"] = J.S(m, "id");
        try {
            var at = Cursor.Position;
            var bounds = Screen.FromPoint(at).Bounds;
            r["cx"] = at.X; r["cy"] = at.Y;
            using (var full = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format24bppRgb)) {
                using (var g = Graphics.FromImage(full)) g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                double k = Math.Min(1.0, 1568.0 / Math.Max(bounds.Width, bounds.Height));
                int w = (int)Math.Round(bounds.Width * k), h = (int)Math.Round(bounds.Height * k);
                var dir = Path.Combine(Path.GetTempPath(), "backstage-explain"); Directory.CreateDirectory(dir);
                var path = Path.Combine(dir, "screen-" + DateTime.Now.Ticks + ".png");
                using (var small = new Bitmap(w, h, PixelFormat.Format24bppRgb)) {
                    using (var g = Graphics.FromImage(small)) { g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.DrawImage(full, 0, 0, w, h); }
                    small.Save(path, ImageFormat.Png);
                }
                r["path"] = path; r["imgW"] = w; r["imgH"] = h; r["x"] = bounds.X; r["y"] = bounds.Y; r["w"] = bounds.Width; r["h"] = bounds.Height;
            }
        } catch (Exception e) { r["error"] = e.Message; }
        Out(r);
    }

    static void Handle(Dictionary<string, object> m) {
        string cmd = J.S(m, "cmd");
        if (cmd == "hello") {
            statusLine.Text = "connected to Backstage";
            var key = J.S(m, "key");
            if (key != "") talkLine.Text = "Hold " + key + " to talk \u00b7 tap it to type";
        } else if (cmd == "capture") Capture(m);
        else if (cmd == "listening") { Silence(); buddy.Home(); idleAfter = null; buddy.Set("listening", "Listening\u2026"); }
        else if (cmd == "status") buddy.Set("thinking", J.S(m, "text").Replace("\u2026", ""));
        else if (cmd == "idle") buddy.Set("idle", "");
        else if (cmd == "typebox") { if (box.IsOpen) box.Close2(); else OpenBox(); }
        else if (cmd == "answer") {
            string say = J.S(m, "say");
            var shapes = new List<Shape>();
            foreach (var o in J.L(m, "shapes")) { var s = Shape.Of(o as Dictionary<string, object>); if (s != null) shapes.Add(s); }
            string text = say;
            lessonOn = false;
            var st = J.O(m, "step");
            if (st != null) {
                int i = J.I(st, "index", 0), n = J.I(st, "total", 1);
                text = string.Format("Step {0} of {1}: {2}\n\nAlt+\u2192 next  \u00b7  Alt+\u2190 back  \u00b7  Esc quiet", i + 1, n, say);
                lessonOn = true;
            }
            buddy.Set("answer", text);
            idleAfter = null;
            double fade = m.ContainsKey("fadeMs") ? J.F(m, "fadeMs") : 9000;
            canvas.Display(shapes, fade);
            if (shapes.Count > 0) buddy.Fly(shapes[0].Anchor); else buddy.Home();
            answerSeq = J.I(m, "seq", answerSeq + 1);
            answerSay = say; answerAt = DateTime.Now;
            voice.Stop();
            if (J.S(m, "audio") == "follows") waitingAudio = true;
            else { answerSay = ""; waitingAudio = false; voice.Speak(say); }
        } else if (cmd == "audio" || cmd == "speak") {
            // the parts of the spoken answer, in order; the first one cancels the Windows-voice fallback
            if (J.I(m, "seq", -2) != answerSeq) { if (cmd == "audio") Remove(J.S(m, "path")); return; }
            if (J.I(m, "part", 0) == 0) {
                if (answerSay == "") { if (cmd == "audio") Remove(J.S(m, "path")); return; }   // too late: the Windows voice is saying it
                answerSay = ""; waitingAudio = false; audioSeq = answerSeq;
            } else if (audioSeq != answerSeq) { if (cmd == "audio") Remove(J.S(m, "path")); return; }
            if (cmd == "audio") voice.Add("mp3", J.S(m, "path")); else voice.Add("text", J.S(m, "say"));
        } else if (cmd == "agents") dock.Apply(m);
        else if (cmd == "tap") {
            var p = new Pulse(new Rectangle((int)J.F(m, "x"), (int)J.F(m, "y"), Math.Max(4, (int)J.F(m, "w")), Math.Max(4, (int)J.F(m, "h"))), Look.Hex(J.S(m, "colour"), Look.MINT));
            pulses.Add(p);
        } else if (cmd == "clear") Clear();
        else if (cmd == "error") { buddy.Home(); buddy.Set("error", J.S(m, "text")); idleAfter = DateTime.Now.AddSeconds(6); }
    }
    static void Remove(string f) { try { if (f != "") File.Delete(f); } catch { } }
}
"@
[Overlay]::Run()

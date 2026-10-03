# On-screen overlay for the agent, Clicky-style: marks drawn around things (ring, box, arrow, underline, with a label)
# and a small answer bubble near the pointer. Never takes focus; marks are click-through; clicking the bubble closes it.
# One warm process: reads JSON lines on stdin, in physical screen pixels (the same space as Cua's window bounds):
#   {"cmd":"mark","shape":"ring","x":..,"y":..,"w":..,"h":..,"label":"zebra","color":0,"ms":6000}
#   {"cmd":"bubble","text":"...","title":"Answer","x":..,"y":..,"ms":9000}      (x,y = pointer; -1 = bottom right)
#   {"cmd":"hide"}
# Writes "bubble-closed" on stdout when the user clicks the bubble away. Exits when stdin closes.
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public static class Palette {
    public static readonly Color[] Colors = {
        Color.FromArgb(0, 120, 255), Color.FromArgb(255, 140, 0), Color.FromArgb(0, 170, 90),
        Color.FromArgb(220, 40, 140), Color.FromArgb(140, 70, 230), Color.FromArgb(0, 170, 200) };
    public static Color Of(int i) { return Colors[((i % Colors.Length) + Colors.Length) % Colors.Length]; }
}

public class OverlayForm : Form {
    protected bool clickThrough = true;
    protected int life, fade = 400; DateTime born = DateTime.Now;
    public OverlayForm(int ms) {
        life = ms; FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        StartPosition = FormStartPosition.Manual; DoubleBuffered = true;
        var t = new System.Windows.Forms.Timer { Interval = 40 };
        t.Tick += (s, e) => {
            var age = (DateTime.Now - born).TotalMilliseconds;
            if (age > life + fade) { t.Stop(); Close(); }
            else if (age > life) Opacity = Math.Max(0, 1 - (age - life) / fade);
        };
        t.Start();
    }
    public void Renew(int ms) { born = DateTime.Now; life = ms; Opacity = 1; }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x80 | 0x8 | 0x08000000;            // tool window, topmost, never activated
            if (clickThrough) cp.ExStyle |= 0x20 | 0x80000;    // + click-through, layered
            return cp;
        }
    }
}

public class Mark : OverlayForm {
    const int Pad = 14, LabelH = 30;
    string shape, label; Color color; Rectangle target; Point arrowFrom;
    public Mark(Rectangle r, string shape, string label, Color color, int ms) : base(ms) {
        this.shape = shape; this.label = label ?? ""; this.color = color; Text = "agent-mark";
        BackColor = Color.Magenta; TransparencyKey = Color.Magenta;
        var area = Rectangle.Inflate(r, Pad, Pad);
        if (shape == "arrow") {
            var tipBelow = r.Y < 140;                       // near the top of the screen: point up from below
            arrowFrom = tipBelow ? new Point(r.X - 110, r.Bottom + 110) : new Point(r.X - 110, r.Y - 110);
            area = Rectangle.Union(area, new Rectangle(arrowFrom.X - 10, arrowFrom.Y - 10, 20, 20));
        }
        if (this.label.Length > 0) area = Rectangle.Union(area, new Rectangle(area.X, area.Y - LabelH, Math.Max(area.Width, 40), LabelH));
        Bounds = area;
        target = new Rectangle(r.X - area.X, r.Y - area.Y, r.Width, r.Height);
        arrowFrom = new Point(arrowFrom.X - area.X, arrowFrom.Y - area.Y);
    }
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics; g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var glow = new Pen(Color.FromArgb(255, Color.White), 9))
        using (var pen = new Pen(color, 4)) {
            var ring = Rectangle.Inflate(target, 8, 8);
            if (shape == "box") { g.DrawRectangle(glow, ring); g.DrawRectangle(pen, ring); }
            else if (shape == "underline") {
                int y = target.Bottom + 4; g.DrawLine(glow, target.X, y, target.Right, y); g.DrawLine(pen, target.X, y, target.Right, y);
            } else if (shape == "arrow") {
                var tip = arrowFrom.Y > target.Bottom ? new Point(target.X + target.Width / 2, target.Bottom + 4) : new Point(target.X + target.Width / 2, target.Y - 4);
                pen.CustomEndCap = new AdjustableArrowCap(5, 5); pen.Width = 5;
                glow.Width = 10; g.DrawLine(glow, arrowFrom, tip); g.DrawLine(pen, arrowFrom, tip);
            } else { g.DrawEllipse(glow, ring); g.DrawEllipse(pen, ring); }
        }
        if (label.Length > 0) {
            using (var f = new Font("Segoe UI", 10f, FontStyle.Bold)) {
                var size = TextRenderer.MeasureText(label, f);
                var box = new Rectangle(Math.Max(0, target.X - 6), Math.Max(0, target.Y - 8 - 28), size.Width + 12, 26);
                if (shape == "arrow") box.Location = new Point(Math.Max(0, arrowFrom.X - box.Width / 2), Math.Max(0, arrowFrom.Y - 30));
                using (var b = new SolidBrush(color)) g.FillRectangle(b, box);
                TextRenderer.DrawText(g, label, f, box, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }
    }
}

public class Bubble : OverlayForm {
    string title, text; Font titleFont = new Font("Segoe UI", 9f, FontStyle.Bold), textFont = new Font("Segoe UI", 11f);
    const int W = 460, P = 14;
    public Bubble(int ms) : base(ms) { clickThrough = false; Text = "agent-bubble"; BackColor = Color.FromArgb(30, 34, 48); Opacity = 0.96; }
    public void Set(string title, string text, Point at, int ms) {
        this.title = title ?? "Agent"; this.text = text ?? ""; Renew(ms); Opacity = 0.96;
        var size = TextRenderer.MeasureText(this.text, textFont, new Size(W - 2 * P, 2000), TextFormatFlags.WordBreak);
        int h = Math.Min(P + 20 + size.Height + P, 520);
        var screen = at.X < 0 ? Screen.PrimaryScreen.WorkingArea : Screen.FromPoint(at).WorkingArea;
        int x = at.X < 0 ? screen.Right - W - 24 : at.X + 28, y = at.X < 0 ? screen.Bottom - h - 24 : at.Y + 28;
        if (x + W > screen.Right) x = Math.Max(screen.Left, at.X - W - 28);
        if (y + h > screen.Bottom) y = Math.Max(screen.Top, at.Y - h - 28);
        Bounds = new Rectangle(x, y, W, h);
        Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, W + 1, h + 1, 18, 18));
        Invalidate();
    }
    [DllImport("gdi32.dll")] static extern IntPtr CreateRoundRectRgn(int a, int b, int c, int d, int e, int f);
    // Tells the agent the user closed it, so progress updates do not bring it straight back.
    protected override void OnClick(EventArgs e) { try { Console.Out.WriteLine("bubble-closed"); Console.Out.Flush(); } catch { } Close(); }
    protected override void OnPaint(PaintEventArgs e) {
        var g = e.Graphics;
        using (var accent = new SolidBrush(Palette.Of(0))) g.FillRectangle(accent, 0, 0, 5, Height);
        TextRenderer.DrawText(g, title, titleFont, new Rectangle(P, P - 4, W - 2 * P, 20), Color.FromArgb(150, 190, 255), TextFormatFlags.Left);
        TextRenderer.DrawText(g, text, textFont, new Rectangle(P, P + 18, W - 2 * P, Height - P - 18), Color.White, TextFormatFlags.WordBreak);
    }
}

public static class Overlay {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    static Bubble bubble;
    static int I(Dictionary<string, object> m, string k, int d) { object v; return m.TryGetValue(k, out v) && v != null ? Convert.ToInt32(v) : d; }
    static string S(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? v.ToString() : ""; }
    public static void Run() {
        SetProcessDPIAware();
        var host = new Control(); host.CreateControl(); var h = host.Handle;
        var json = new JavaScriptSerializer();
        var reader = new Thread(() => {
            string line;
            while ((line = Console.In.ReadLine()) != null) {
                Dictionary<string, object> m;
                try { m = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
                var cmd = S(m, "cmd");
                host.BeginInvoke((Action)(() => {
                    try {
                        if (cmd == "mark") {
                            var r = new Rectangle(I(m, "x", 0), I(m, "y", 0), Math.Max(I(m, "w", 16), 16), Math.Max(I(m, "h", 16), 16));
                            new Mark(r, S(m, "shape"), S(m, "label"), Palette.Of(I(m, "color", 0)), I(m, "ms", 4000)).Show();
                        } else if (cmd == "bubble") {
                            if (bubble == null || bubble.IsDisposed) bubble = new Bubble(I(m, "ms", 8000));
                            bubble.Set(S(m, "title"), S(m, "text"), new Point(I(m, "x", -1), I(m, "y", -1)), I(m, "ms", 8000));
                            if (!bubble.Visible) bubble.Show();
                        } else if (cmd == "hide") { if (bubble != null && !bubble.IsDisposed) bubble.Close(); }
                    } catch { }
                }));
            }
            host.BeginInvoke((Action)(() => Application.Exit()));
        }) { IsBackground = true };
        reader.Start();
        Application.Run(new ApplicationContext());
    }
}
"@
Write-Output '{"event":"ready"}'
[Overlay]::Run()

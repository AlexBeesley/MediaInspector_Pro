using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class Win11Dwm {
    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    public const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    public const int DWMWA_BORDER_COLOR = 34;
    public const int DWMWA_CAPTION_COLOR = 35;
    public const int DWMWA_TEXT_COLOR = 36;
    public const int DWMWA_SYSTEMBACKDROP_TYPE = 38;

    public static void Apply(IntPtr hwnd) {
        try {
            int dark = 1;
            DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
            int corner = 2; // DWMWCP_ROUND
            DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref corner, sizeof(int));
            int backdrop = 3; // Acrylic
            DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, sizeof(int));
            int caption = ColorTranslator.ToWin32(Color.FromArgb(18, 18, 22));
            DwmSetWindowAttribute(hwnd, DWMWA_CAPTION_COLOR, ref caption, sizeof(int));
            int border = ColorTranslator.ToWin32(Color.FromArgb(46, 46, 56));
            DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR, ref border, sizeof(int));
        } catch {}
    }
}

public class Win11Form : Form {
    public Win11Form() {
        DoubleBuffered = true;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw, true);
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        Win11Dwm.Apply(Handle);
    }
}

public static class Win11Draw {
    public static GraphicsPath CreateRoundedRectangle(Rectangle rect, int radius) {
        GraphicsPath path = new GraphicsPath();
        if (radius <= 0) {
            path.AddRectangle(rect);
            return path;
        }
        int d = radius * 2;
        Rectangle arc = new Rectangle(rect.X, rect.Y, d, d);
        path.AddArc(arc, 180, 90);
        arc.X = rect.Right - d;
        path.AddArc(arc, 270, 90);
        arc.Y = rect.Bottom - d;
        path.AddArc(arc, 0, 90);
        arc.X = rect.Left;
        path.AddArc(arc, 90, 90);
        path.CloseFigure();
        return path;
    }
}

public class Win11Button : Button {
    private bool isHovered;
    private bool isPressed;
    public bool IsDanger { get; set; }
    public bool IsAccent { get; set; }
    public Color AccentColor { get; set; }
    public bool HasFlag { get; set; }
    public int CornerRadius { get; set; }

    public Win11Button() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        Cursor = Cursors.Hand;
        Font = new Font("Segoe UI", 9.0f);
        ForeColor = Color.White;
        Size = new Size(112, 32);
        AccentColor = Color.FromArgb(56, 152, 255);
        CornerRadius = 6;
    }

    protected override void OnMouseEnter(EventArgs e) { isHovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { isHovered = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left) { isPressed = true; Invalidate(); }
        base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        isPressed = false; Invalidate();
        base.OnMouseUp(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = Win11Draw.CreateRoundedRectangle(r, CornerRadius)) {
            Color bg, border, textCol;

            if (!Enabled) {
                bg = Color.FromArgb(24, 24, 28);
                border = Color.FromArgb(36, 36, 42);
                textCol = Color.FromArgb(90, 90, 98);
            } else if (IsAccent) {
                bg = isPressed ? Color.FromArgb(190, AccentColor) : (isHovered ? Color.FromArgb(235, AccentColor) : AccentColor);
                border = Color.FromArgb(120, 255, 255, 255);
                textCol = Color.FromArgb(16, 16, 20);
            } else if (IsDanger) {
                bg = isPressed ? Color.FromArgb(85, 26, 30) : (isHovered ? Color.FromArgb(130, 40, 46) : Color.FromArgb(95, 30, 35));
                border = Color.FromArgb(150, 48, 54);
                textCol = Color.White;
            } else {
                bg = isPressed ? Color.FromArgb(30, 30, 36) : (isHovered ? Color.FromArgb(48, 48, 58) : Color.FromArgb(36, 36, 44));
                border = isHovered ? Color.FromArgb(82, 82, 98) : Color.FromArgb(54, 54, 66);
                textCol = Color.White;
            }

            using (SolidBrush br = new SolidBrush(bg)) {
                g.FillPath(br, path);
            }
            using (Pen p = new Pen(border, 1f)) {
                g.DrawPath(p, path);
            }

            // Top subtle highlight on hover
            if (isHovered && Enabled && !IsAccent && !IsDanger) {
                using (Pen specPen = new Pen(Color.FromArgb(40, 255, 255, 255), 1f)) {
                    g.DrawLine(specPen, CornerRadius, 1, Width - CornerRadius, 1);
                }
            }

            TextRenderer.DrawText(g, Text, Font, r, textCol,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            if (HasFlag) {
                int dotSize = 8;
                Rectangle dotRect = new Rectangle(Width - dotSize - 6, 5, dotSize, dotSize);
                using (SolidBrush dotBr = new SolidBrush(Color.FromArgb(64, 218, 120))) {
                    g.FillEllipse(dotBr, dotRect);
                }
                using (Pen dotPen = new Pen(Color.FromArgb(18, 18, 22), 1f)) {
                    g.DrawEllipse(dotPen, dotRect);
                }
            }
        }
    }
}

public class Win11Slider : Control {
    private const int WM_MOUSEWHEEL = 0x020A;
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    public int Minimum { get; set; }
    public int Maximum { get; set; }
    public int DefaultValue { get; set; }
    public Color AccentColor { get; set; }

    private int _val;
    public int Value {
        get { return _val; }
        set {
            int clamped = Math.Max(Minimum, Math.Min(Maximum, value));
            if (_val != clamped) {
                _val = clamped;
                Invalidate();
                OnValueChanged(EventArgs.Empty);
            }
        }
    }

    public event EventHandler ValueChanged;
    protected virtual void OnValueChanged(EventArgs e) {
        if (ValueChanged != null) ValueChanged(this, e);
    }

    private bool isDragging;
    private bool isHovered;

    public Win11Slider() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        Cursor = Cursors.Hand;
        Size = new Size(200, 24);
        Minimum = -100;
        Maximum = 100;
        DefaultValue = 0;
        _val = 0;
        AccentColor = Color.FromArgb(56, 152, 255);
    }

    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_MOUSEWHEEL) {
            Control target = Parent;
            while (target != null) {
                ScrollableControl sc = target as ScrollableControl;
                if (sc != null && sc.AutoScroll) break;
                target = target.Parent;
            }
            if (target != null) SendMessage(target.Handle, m.Msg, m.WParam, m.LParam);
            return;
        }
        base.WndProc(ref m);
    }

    protected override void OnDoubleClick(EventArgs e) {
        Value = DefaultValue;
        base.OnDoubleClick(e);
    }

    protected override void OnMouseEnter(EventArgs e) { isHovered = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { isHovered = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e) {
        if (e.Button == MouseButtons.Left) {
            isDragging = true;
            UpdateFromMouse(e.X);
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e) {
        if (isDragging) {
            UpdateFromMouse(e.X);
        }
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e) {
        isDragging = false;
        Invalidate();
        base.OnMouseUp(e);
    }

    private void UpdateFromMouse(int mouseX) {
        int pad = 9;
        int trackW = Width - pad * 2;
        if (trackW <= 0) return;
        float pct = (float)(mouseX - pad) / (float)trackW;
        pct = Math.Max(0f, Math.Min(1f, pct));
        Value = Minimum + (int)Math.Round(pct * (Maximum - Minimum));
    }

    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        int pad = 9;
        int trackW = Width - pad * 2;
        int trackH = 4;
        int trackY = Height / 2 - trackH / 2;

        Rectangle fullTrack = new Rectangle(pad, trackY, trackW, trackH);
        using (GraphicsPath trackPath = Win11Draw.CreateRoundedRectangle(fullTrack, 2)) {
            using (SolidBrush br = new SolidBrush(Color.FromArgb(42, 42, 50))) {
                g.FillPath(br, trackPath);
            }
        }

        float pct = (float)(Value - Minimum) / (float)(Maximum - Minimum);
        int thumbX = pad + (int)(pct * trackW);

        if (Minimum < 0 && Maximum > 0) {
            float zeroPct = (float)(0 - Minimum) / (float)(Maximum - Minimum);
            int zeroX = pad + (int)(zeroPct * trackW);
            int fillLeft = Math.Min(zeroX, thumbX);
            int fillW = Math.Abs(thumbX - zeroX);
            if (fillW > 1) {
                Rectangle fillR = new Rectangle(fillLeft, trackY, fillW, trackH);
                using (GraphicsPath fillPath = Win11Draw.CreateRoundedRectangle(fillR, 2)) {
                    using (SolidBrush br = new SolidBrush(AccentColor)) {
                        g.FillPath(br, fillPath);
                    }
                }
            }
        } else {
            int fillW = thumbX - pad;
            if (fillW > 1) {
                Rectangle fillR = new Rectangle(pad, trackY, fillW, trackH);
                using (GraphicsPath fillPath = Win11Draw.CreateRoundedRectangle(fillR, 2)) {
                    using (SolidBrush br = new SolidBrush(AccentColor)) {
                        g.FillPath(br, fillPath);
                    }
                }
            }
        }

        int thumbR = (isDragging || isHovered) ? 8 : 7;
        Rectangle thumbRect = new Rectangle(thumbX - thumbR, Height / 2 - thumbR, thumbR * 2, thumbR * 2);
        using (SolidBrush thumbBr = new SolidBrush(Color.White)) {
            g.FillEllipse(thumbBr, thumbRect);
        }
        using (Pen p = new Pen(AccentColor, 2f)) {
            g.DrawEllipse(p, thumbRect);
        }
    }
}

public class Win11Toggle : Control {
    private bool _checked;
    public bool Checked {
        get { return _checked; }
        set {
            if (_checked != value) {
                _checked = value;
                Invalidate();
                OnCheckedChanged(EventArgs.Empty);
            }
        }
    }
    public Color AccentColor { get; set; }

    public event EventHandler CheckedChanged;
    protected virtual void OnCheckedChanged(EventArgs e) {
        if (CheckedChanged != null) CheckedChanged(this, e);
    }

    public Win11Toggle() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        Cursor = Cursors.Hand;
        Size = new Size(38, 20);
        _checked = false;
        AccentColor = Color.FromArgb(56, 152, 255);
    }

    protected override void OnClick(EventArgs e) {
        Checked = !Checked;
        base.OnClick(e);
    }

    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = Win11Draw.CreateRoundedRectangle(r, Height / 2)) {
            Color bg = Checked ? AccentColor : Color.FromArgb(44, 44, 52);
            Color border = Checked ? AccentColor : Color.FromArgb(75, 75, 88);
            using (SolidBrush br = new SolidBrush(bg)) {
                g.FillPath(br, path);
            }
            using (Pen p = new Pen(border, 1f)) {
                g.DrawPath(p, path);
            }
        }

        int thumbSize = Height - 6;
        int thumbX = Checked ? (Width - thumbSize - 3) : 3;
        int thumbY = 3;
        Rectangle thumbR = new Rectangle(thumbX, thumbY, thumbSize, thumbSize);
        using (SolidBrush br = new SolidBrush(Checked ? Color.FromArgb(18, 18, 22) : Color.FromArgb(220, 220, 230))) {
            g.FillEllipse(br, thumbR);
        }
    }
}

public class Win11Card : Panel {
    public int CornerRadius { get; set; }
    public Color BorderColor { get; set; }
    public Color CardBackColor { get; set; }

    public Win11Card() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
                 ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        Padding = new Padding(12, 10, 12, 12);
        Margin = new Padding(0, 0, 0, 10);
        CornerRadius = 8;
        BorderColor = Color.FromArgb(46, 46, 56);
        CardBackColor = Color.FromArgb(24, 24, 30);
    }

    protected override void OnPaint(PaintEventArgs e) {
        Graphics g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        Rectangle r = new Rectangle(0, 0, Width - 1, Height - 1);
        using (GraphicsPath path = Win11Draw.CreateRoundedRectangle(r, CornerRadius)) {
            using (SolidBrush br = new SolidBrush(CardBackColor)) {
                g.FillPath(br, path);
            }
            using (Pen p = new Pen(BorderColor, 1f)) {
                g.DrawPath(p, path);
            }
            // Specular top highlight line (Acrylic glass reflection)
            using (Pen specPen = new Pen(Color.FromArgb(32, 255, 255, 255), 1f)) {
                g.DrawLine(specPen, CornerRadius, 1, Width - CornerRadius, 1);
            }
        }
    }
}

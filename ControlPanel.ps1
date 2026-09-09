# ============================================================
# MediaInspector_Pro Control Panel (Windows 11 Fluent Acrylic Glass)
# A high-performance control window with authentic Win11 styling.
# Communicates with the player over mpv's JSON IPC socket, and
# dynamically adapts its accent colors and cards to the media kind.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# Compile Win11 Native DWM interop and custom Fluent controls
$Win11Source = @'
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
'@

Add-Type -TypeDefinition $Win11Source -ReferencedAssemblies System.Windows.Forms, System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PanelStateFile = Join-Path $Root "state_panel.json"
$ShaderDir = Join-Path $Root "config\shaders"
$PipeName = "mediainspector_pro"

# Modern vibrant Win11 Fluent Tier Palette
$TierPalette = @{
    yellow = [System.Drawing.Color]::FromArgb(255, 210, 30)
    blue   = [System.Drawing.Color]::FromArgb(60, 160, 255)
    green  = [System.Drawing.Color]::FromArgb(64, 218, 120)
    photo  = [System.Drawing.Color]::FromArgb(245, 170, 85)
    audio  = [System.Drawing.Color]::FromArgb(85, 205, 245)
    hdr    = [System.Drawing.Color]::FromArgb(215, 95, 255)
}

$ColFormBg = [System.Drawing.Color]::FromArgb(16, 16, 20)
$ColCardBg = [System.Drawing.Color]::FromArgb(24, 24, 30)
$ColInput  = [System.Drawing.Color]::FromArgb(13, 13, 17)
$ColBorder = [System.Drawing.Color]::FromArgb(46, 46, 56)
$ColTextMuted = [System.Drawing.Color]::FromArgb(160, 160, 172)

$script:client = $null; $script:writer = $null; $script:reader = $null
$script:connected = $false; $script:reqId = 1
$script:tierNow = "yellow"; $script:lastSeq = 0; $script:scaleNow = 0
$script:kindNow = ""
$script:settingsPushed = $false

# Detect GPU vendor
$script:gpuName = "unknown GPU"
$script:gpuVendor = "other"
try {
    $g = Get-CimInstance Win32_VideoController -ErrorAction Stop |
         Sort-Object -Property AdapterRAM -Descending | Select-Object -First 1
    if ($g) {
        $script:gpuName = $g.Name
        if ($g.Name -match 'NVIDIA|GeForce|RTX|Quadro') { $script:gpuVendor = "nvidia" }
        elseif ($g.Name -match 'Intel|Arc|UHD|Iris') { $script:gpuVendor = "intel" }
        elseif ($g.Name -match 'AMD|Radeon') { $script:gpuVendor = "amd" }
    }
} catch {}

function Disconnect-Mpv {
    try { if ($script:writer) { $script:writer.Dispose() } } catch {}
    try { if ($script:reader) { $script:reader.Dispose() } } catch {}
    try { if ($script:client) { $script:client.Dispose() } } catch {}
    $script:client = $null; $script:writer = $null; $script:reader = $null
    $script:connected = $false
    $script:settingsPushed = $false
}

function Connect-Mpv {
    try {
        $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
        $c.Connect(200)
        $script:client = $c
        $script:writer = New-Object System.IO.StreamWriter($c); $script:writer.AutoFlush = $true
        $script:reader = New-Object System.IO.StreamReader($c)
        $script:connected = $true
        $script:reqId++
        $script:writer.WriteLine('{"command":["disable_event","all"],"request_id":' + $script:reqId + '}')
        return $true
    } catch { Disconnect-Mpv; return $false }
}

function Send-Mpv {
    param([Parameter(Mandatory)][object[]]$Command)
    if (-not $script:connected) { return $null }
    try {
        $script:reqId++
        $id = $script:reqId
        $script:writer.WriteLine((@{ command = $Command; request_id = $id } | ConvertTo-Json -Compress -Depth 5))

        for ($i = 0; $i -lt 40; $i++) {
            $line = $script:reader.ReadLine()
            if ($null -eq $line) { Disconnect-Mpv; return $null }
            if ($line -match '"request_id"\s*:\s*(\d+)') {
                if ([int]$Matches[1] -eq $id) { return $line }
            }
        }
        return $null
    } catch { Disconnect-Mpv; return $null }
}

function Get-MpvProp {
    param([string]$Name)
    $r = Send-Mpv -Command @("get_property", $Name)
    if (-not $r) { return $null }
    try { return ($r | ConvertFrom-Json).data } catch { return $null }
}

function Set-MpvSetting {
    param([string]$Name, $Value)
    Send-Mpv -Command @("set_property", "user-data/mi/set_$Name", "$Value") | Out-Null
}

function Format-Time {
    param($Seconds)
    if ($null -eq $Seconds) { return "0:00" }
    $d = 0.0
    if (-not [double]::TryParse([string]$Seconds, [ref]$d)) { return "0:00" }
    $ts = [TimeSpan]::FromSeconds($d)
    if ($ts.TotalHours -ge 1) { return ('{0}:{1:00}:{2:00}' -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds) }
    return ('{0}:{1:00}' -f $ts.Minutes, $ts.Seconds)
}

# File dialog filters
$VideoExt = "*.mp4;*.mov;*.m4v;*.mkv;*.avi;*.webm;*.wmv;*.flv;*.mpg;*.mpeg;*.m2ts;*.mts;*.ts;*.m2v;*.vob;*.3gp;*.ogv;*.mxf;*.asf;*.divx;*.f4v;*.gif;*.av1;*.ivf"
$PhotoExt = "*.jpg;*.jpeg;*.jfif;*.png;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.heif;*.avif;*.jxl;*.jp2;*.tga;*.exr;*.hdr;*.dds;*.ppm;*.pgm;*.pnm;*.pcx;*.ico;*.qoi;*.dng;*.cr2;*.cr3;*.nef;*.arw;*.raf;*.orf;*.rw2"
$AudioExt = "*.mp3;*.wav;*.flac;*.aac;*.m4a;*.m4b;*.ogg;*.opus;*.wma;*.aiff;*.aif;*.alac;*.ape;*.wv;*.mka;*.dsf;*.dff;*.ac3;*.dts;*.mp2;*.caf;*.au;*.amr;*.mid"
$AllMediaFilter = "All media|$VideoExt;$PhotoExt;$AudioExt|Video|$VideoExt|Photos|$PhotoExt|Audio|$AudioExt|All files (*.*)|*.*"

# ---------- Main Form ----------
$form = New-Object Win11Form
$form.Text = "MediaInspector_Pro Controls"
$form.BackColor = $ColFormBg
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.MinimumSize = New-Object System.Drawing.Size(1080, 680)
$form.Size = New-Object System.Drawing.Size(1120, 980)
$form.StartPosition = "Manual"

$placed = $false
$script:panelState = $null
if (Test-Path $PanelStateFile) {
    try {
        $p = [IO.File]::ReadAllText($PanelStateFile).TrimStart([char]0xFEFF) | ConvertFrom-Json
        $script:panelState = $p
        if ($p.w -gt 300 -and $p.h -gt 400) {
            $r = New-Object System.Drawing.Rectangle([int]$p.x, [int]$p.y, [int]$p.w, [int]$p.h)
            foreach ($scr in [System.Windows.Forms.Screen]::AllScreens) {
                if ($scr.WorkingArea.IntersectsWith($r)) {
                    $form.Location = New-Object System.Drawing.Point([int]$p.x, [int]$p.y)
                    $form.Size = New-Object System.Drawing.Size([int]$p.w, [int]$p.h)
                    $placed = $true
                    break
                }
            }
        }
    } catch {}
}
if (-not $placed) { $form.StartPosition = "CenterScreen" }

function State-Or {
    param([string]$Key, $Default)
    if ($null -ne $script:panelState -and $null -ne $script:panelState.$Key -and "$($script:panelState.$Key)" -ne "") {
        return $script:panelState.$Key
    }
    return $Default
}

# ============================================================
# HERO HEADER (Acrylic Top Bar)
# ============================================================
$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"; $header.Height = 72; $header.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 26)
$header.Padding = New-Object System.Windows.Forms.Padding(16, 10, 16, 8)
$form.Controls.Add($header)

$accent = New-Object System.Windows.Forms.Panel
$accent.Dock = "Bottom"; $accent.Height = 3; $accent.BackColor = $TierPalette["yellow"]
$header.Controls.Add($accent)

# Top row: Transport status pill, filename, chips
$heroLeft = New-Object System.Windows.Forms.FlowLayoutPanel
$heroLeft.Dock = "Fill"; $heroLeft.FlowDirection = "LeftToRight"; $heroLeft.WrapContents = $false
$heroLeft.BackColor = [System.Drawing.Color]::Transparent
$header.Controls.Add($heroLeft)

# Status Pill Badge
$statusPill = New-Object System.Windows.Forms.Label
$statusPill.AutoSize = $true
$statusPill.Height = 24
$statusPill.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 4)
$statusPill.Margin = New-Object System.Windows.Forms.Padding(0, 2, 8, 2)
$statusPill.BackColor = [System.Drawing.Color]::FromArgb(40, 40, 50)
$statusPill.ForeColor = [System.Drawing.Color]::Orange
$statusPill.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$statusPill.Text = "WAITING"
$heroLeft.Controls.Add($statusPill)

# Kind Chip
$kindChip = New-Object System.Windows.Forms.Label
$kindChip.AutoSize = $true
$kindChip.Height = 24
$kindChip.Padding = New-Object System.Windows.Forms.Padding(8, 4, 8, 4)
$kindChip.Margin = New-Object System.Windows.Forms.Padding(0, 2, 10, 2)
$kindChip.BackColor = [System.Drawing.Color]::FromArgb(35, 35, 45)
$kindChip.ForeColor = $TierPalette["yellow"]
$kindChip.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$kindChip.Text = "MEDIA"
$heroLeft.Controls.Add($kindChip)

# Media Title Label
$mediaTitle = New-Object System.Windows.Forms.Label
$mediaTitle.AutoSize = $true
$mediaTitle.MaximumSize = New-Object System.Drawing.Size(380, 26)
$mediaTitle.Margin = New-Object System.Windows.Forms.Padding(0, 3, 12, 2)
$mediaTitle.ForeColor = [System.Drawing.Color]::White
$mediaTitle.Font = New-Object System.Drawing.Font("Segoe UI", 10.5, [System.Drawing.FontStyle]::Bold)
$mediaTitle.Text = "MediaInspector_Pro"
$heroLeft.Controls.Add($mediaTitle)

# Right meta chips panel
$heroRight = New-Object System.Windows.Forms.FlowLayoutPanel
$heroRight.Dock = "Right"; $heroRight.Width = 440; $heroRight.FlowDirection = "RightToLeft"; $heroRight.WrapContents = $false
$heroRight.BackColor = [System.Drawing.Color]::Transparent
$header.Controls.Add($heroRight)

function Add-HeroChip {
    param([string]$InitialText, [System.Drawing.Color]$FgColor = [System.Drawing.Color]::Gainsboro)
    $c = New-Object System.Windows.Forms.Label
    $c.AutoSize = $true
    $c.Height = 24
    $c.Padding = New-Object System.Windows.Forms.Padding(7, 4, 7, 4)
    $c.Margin = New-Object System.Windows.Forms.Padding(3, 2, 3, 2)
    $c.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 38)
    $c.ForeColor = $FgColor
    $c.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $c.Text = $InitialText
    $heroRight.Controls.Add($c)
    return $c
}

$chipVol  = Add-HeroChip "vol 100%"
$chipTime = Add-HeroChip "0:00 / 0:00"
$chipHdr  = Add-HeroChip "SDR"
$chipHw   = Add-HeroChip "SW"
$chipDims = Add-HeroChip ""

# Sub-bar details
$headerSub = New-Object System.Windows.Forms.Label
$headerSub.Dock = "Bottom"; $headerSub.Height = 22
$headerSub.ForeColor = $ColTextMuted
$headerSub.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$headerSub.Padding = New-Object System.Windows.Forms.Padding(2, 0, 0, 0)
$headerSub.Text = "Ready"
$header.Controls.Add($headerSub)

# ============================================================
# BOTTOM ACTIVITY LOG CARD
# ============================================================
$logContainer = New-Object System.Windows.Forms.Panel
$logContainer.Dock = "Bottom"; $logContainer.Height = 175
$logContainer.Padding = New-Object System.Windows.Forms.Padding(14, 4, 14, 12)
$logContainer.BackColor = $ColFormBg
$form.Controls.Add($logContainer)

$logCard = New-Object Win11Card
$logCard.Dock = "Fill"
$logCard.Padding = New-Object System.Windows.Forms.Padding(10, 8, 10, 8)
$logContainer.Controls.Add($logCard)

$logTop = New-Object System.Windows.Forms.Panel
$logTop.Dock = "Top"; $logTop.Height = 24; $logTop.BackColor = [System.Drawing.Color]::Transparent
$logCard.Controls.Add($logTop)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Dock = "Left"; $logLabel.AutoSize = $true
$logLabel.Text = "ACTIVITY LOG"
$logLabel.ForeColor = $TierPalette["yellow"]
$logLabel.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
$logTop.Controls.Add($logLabel)

$clearLogBtn = New-Object Win11Button
$clearLogBtn.Text = "Clear"
$clearLogBtn.Size = New-Object System.Drawing.Size(60, 22)
$clearLogBtn.Dock = "Right"
$clearLogBtn.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$clearLogBtn.Add_Click({ $logBox.Clear() })
$logTop.Controls.Add($clearLogBtn)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = "Vertical"
$logBox.Dock = "Fill"
$logBox.BackColor = $ColInput
$logBox.ForeColor = [System.Drawing.Color]::Gainsboro
$logBox.BorderStyle = "None"
$logBox.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$logCard.Controls.Add($logBox)

function Write-Log {
    param([string]$Text)
    $logBox.AppendText("$(Get-Date -Format 'HH:mm:ss')  $Text`r`n")
}

# ============================================================
# MAIN COLUMNS
# ============================================================
# One grid for every card. This used to be a fixed 510px column on the left
# plus a fixed 490px sidebar docked right, which left a large dead strip of
# window between them at any real width. A single wrapping flow instead packs
# the cards left-to-right and reflows them as the window is resized, so the
# column count follows the space available rather than being baked in.
#
# All cards share one width ($CardW) so the result reads as a grid rather
# than a ragged collage.
$CardW = 510

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = "Fill"
$panel.FlowDirection = "LeftToRight"
$panel.WrapContents = $true
$panel.AutoScroll = $true
$panel.Padding = New-Object System.Windows.Forms.Padding(14, 8, 14, 8)
$panel.BackColor = $ColFormBg
$form.Controls.Add($panel)

# Every Create-Card call site still names one of these two; they are now the
# same container, so cards land in the single grid wherever they are declared.
$sideFlow = $panel

$script:sectionLabels = @()
$script:allWin11Buttons = @()
$script:allWin11Sliders = @()
$script:allWin11Toggles = @()
$script:flagCtrls = @{}

function Register-Flag {
    param([string]$Name, $Control)
    if (-not $script:flagCtrls.ContainsKey($Name)) { $script:flagCtrls[$Name] = @() }
    $script:flagCtrls[$Name] += $Control
    if ($Control -is [Win11Button]) { $Control.HasFlag = $false }
    else {
        $Control.Tag = $false
        $Control.Add_Paint({
            param($s, $e)
            if ($s.Tag -eq $true) {
                $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
                $br = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(64, 218, 120))
                $e.Graphics.FillEllipse($br, $s.Width - 14, 5, 8, 8)
                $br.Dispose()
            }
        })
    }
}

function Set-FlagDots {
    param($Flags)
    foreach ($name in $script:flagCtrls.Keys) {
        $on = $false
        if ($null -ne $Flags -and $null -ne $Flags.$name) { $on = [bool]$Flags.$name }
        foreach ($c in $script:flagCtrls[$name]) {
            if ($c -is [Win11Button]) {
                if ($c.HasFlag -ne $on) { $c.HasFlag = $on; $c.Invalidate() }
            } else {
                if ($c.Tag -ne $on) { $c.Tag = $on; $c.Invalidate() }
            }
        }
    }
}

function Create-Card {
    param([System.Windows.Forms.Control]$Parent, [string]$Title, [int]$Width = 510, [int]$Height = 0)
    $card = New-Object Win11Card
    $card.Width = $Width
    if ($Height -gt 0) { $card.Height = $Height; $card.AutoSize = $false }
    else {
        # A Panel's AutoSize derives its preferred WIDTH from non-docked
        # children only. Both children added below are Dock=Top, so the
        # preferred width collapsed to the 12+12px padding: every card
        # rendered as an empty vertical sliver with its buttons wrapped out
        # of view, and the content flow - being width-constrained to nothing
        # - stacked one button per row and grew very tall.
        # Pinning min and max width (a 0 in the height slot means
        # "unconstrained") leaves AutoSize doing only the job it is wanted
        # for here: growing the card down to fit its content.
        $card.MinimumSize = New-Object System.Drawing.Size($Width, 0)
        $card.MaximumSize = New-Object System.Drawing.Size($Width, 0)
        $card.AutoSize = $true
        $card.AutoSizeMode = "GrowAndShrink"
    }
    $card.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 12)
    $Parent.Controls.Add($card)

    $headerPanel = New-Object System.Windows.Forms.Panel
    $headerPanel.Dock = "Top"; $headerPanel.Height = 24
    $headerPanel.BackColor = [System.Drawing.Color]::Transparent

    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Title.ToUpper()
    $l.Dock = "Fill"
    $l.TextAlign = "MiddleLeft"
    $l.ForeColor = $TierPalette["yellow"]
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
    $headerPanel.Controls.Add($l)
    $script:sectionLabels += $l

    $content = New-Object System.Windows.Forms.FlowLayoutPanel
    $content.Dock = "Top"; $content.AutoSize = $true; $content.AutoSizeMode = "GrowAndShrink"
    $content.FlowDirection = "LeftToRight"; $content.WrapContents = $true
    $content.BackColor = [System.Drawing.Color]::Transparent
    $content.Padding = New-Object System.Windows.Forms.Padding(0, 6, 0, 0)
    # Pin the flow to the card's client width. Without this its preferred size
    # is measured unconstrained - the buttons notionally fit two per row, so it
    # reported roughly half the height it really needs, and the card AutoSized
    # to that and clipped the bottom rows away. Docking set the *final* width
    # correctly but never triggered a re-measure of the height.
    $inner = $Width - ($card.Padding.Left + $card.Padding.Right)
    $content.MinimumSize = New-Object System.Drawing.Size($inner, 0)
    $content.MaximumSize = New-Object System.Drawing.Size($inner, 0)

    # Add order matters and is the reverse of the visual order: among siblings
    # that all Dock=Top, the one added LAST docks closest to the edge. Adding
    # the header first put every card's title underneath its own buttons.
    $card.Controls.Add($content)
    $card.Controls.Add($headerPanel)

    return $content
}

function Add-BtnCustom {
    param([System.Windows.Forms.Control]$Container, [string]$Label, [object[]]$Command, [int]$Width = 110,
          [scriptblock]$OnClick = $null, [switch]$Danger, [switch]$Accent, [switch]$Break, [string]$Flag = $null)
    $b = New-Object Win11Button
    $b.Text = $Label
    $b.Size = New-Object System.Drawing.Size($Width, 34)
    $b.Margin = New-Object System.Windows.Forms.Padding(3, 3, 3, 4)
    $b.IsDanger = [bool]$Danger
    $b.IsAccent = [bool]$Accent
    $b.AccentColor = $TierPalette[$script:tierNow]
    if ($OnClick) { $b.Add_Click($OnClick) }
    else { $cmd = $Command; $b.Add_Click({ Send-Mpv -Command $cmd | Out-Null }.GetNewClosure()) }
    $Container.Controls.Add($b)
    if ($Break) { $Container.SetFlowBreak($b, $true) }
    if ($Flag) { Register-Flag $Flag $b }
    $script:allWin11Buttons += $b
    return $b
}

# ============================================================
# LEFT COLUMN: CARDS & BUTTON GRIDS
# ============================================================
$W1 = 158   # 1 column
$W2 = 322   # 2 columns
$W3 = 486   # 3 columns / full row

# --- CARD 1: PLAYBACK & TRANSPORT ---
$playCard = Create-Card $panel "Playback & Transport" $CardW
$playBtn = Add-BtnCustom $playCard "⏵ Play / Pause" @("cycle", "pause") $W3 -Accent -Break
[void](Add-BtnCustom $playCard "« -10s" @("seek", -10, "exact") $W1)
[void](Add-BtnCustom $playCard "‹ -1s" @("seek", -1, "exact") $W1)
[void](Add-BtnCustom $playCard "‹ Frame" @("frame-back-step") $W1 -Break)
[void](Add-BtnCustom $playCard "+1s ›" @("seek", 1, "exact") $W1)
[void](Add-BtnCustom $playCard "+10s »" @("seek", 10, "exact") $W1)
[void](Add-BtnCustom $playCard "Frame ›" @("frame-step") $W1 -Break)

# Speed row
[void](Add-BtnCustom $playCard "0.25x" @("set_property", "speed", 0.25) 78)
[void](Add-BtnCustom $playCard "0.5x" @("set_property", "speed", 0.5) 78)
[void](Add-BtnCustom $playCard "1.0x" @("set_property", "speed", 1.0) 78)
[void](Add-BtnCustom $playCard "2.0x" @("set_property", "speed", 2.0) 78)
[void](Add-BtnCustom $playCard "Slower" @("multiply", "speed", 0.9090909) 81)
[void](Add-BtnCustom $playCard "Faster" @("multiply", "speed", 1.1) 81 -Break)

[void](Add-BtnCustom $playCard "Slow-mo Toggle (24fps Conform)" @("script-binding", "slowmo_toggle") $W2 -Flag "slowmo")
[void](Add-BtnCustom $playCard "Export Frame" @("script-binding", "export_frame") $W1 -Break)

# --- CARD 2: MEDIA NAVIGATION ---
$navCard = Create-Card $panel "Media & Navigation" $CardW
[void](Add-BtnCustom $navCard "Open Media..." $null $W2 -OnClick {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Filter = $AllMediaFilter
    if ($d.ShowDialog() -eq "OK") { Send-Mpv -Command @("loadfile", $d.FileName, "replace") | Out-Null }
})
[void](Add-BtnCustom $navCard "Media Info" @("script-binding", "show_info") $W1 -Break)
[void](Add-BtnCustom $navCard "« Previous Media" @("script-binding", "prev_media") $W1)
[void](Add-BtnCustom $navCard "Next Media »" @("script-binding", "next_media") $W1)
[void](Add-BtnCustom $navCard "Open Exports Folder" $null $W1 -Break -OnClick {
    $e = if ($expDir.Text) { $expDir.Text } else { Join-Path $Root "Exports" }
    if (-not (Test-Path $e)) { New-Item -ItemType Directory -Force -Path $e | Out-Null }
    Start-Process explorer.exe $e
})

# --- CARD 3: IMAGE INSPECTION & ZOOM ---
$zoomCard = Create-Card $panel "Image Inspection & Zoom" $CardW
[void](Add-BtnCustom $zoomCard "Fit to Window" @("script-binding", "zoom_fit") $W1)
[void](Add-BtnCustom $zoomCard "1:1 Actual Pixels" @("script-binding", "zoom_actual") $W1)
[void](Add-BtnCustom $zoomCard "Fit Window to Media" @("script-binding", "fit_window") $W1 -Break)
[void](Add-BtnCustom $zoomCard "Zoom In (+)" @("script-binding", "zoom_in") $W1)
[void](Add-BtnCustom $zoomCard "Zoom Out (-)" @("script-binding", "zoom_out") $W1)
[void](Add-BtnCustom $zoomCard "Reset Zoom" @("set_property", "video-zoom", 0) $W1 -Break)
[void](Add-BtnCustom $zoomCard "Rotate Left (↶)" @("script-binding", "rotate_ccw") $W1)
[void](Add-BtnCustom $zoomCard "Rotate Right (↷)" @("script-binding", "rotate_cw") $W1)
[void](Add-BtnCustom $zoomCard "Reset Pan" $null $W1 -Break -OnClick {
    Send-Mpv -Command @("set_property", "video-pan-x", 0) | Out-Null
    Send-Mpv -Command @("set_property", "video-pan-y", 0) | Out-Null
})

# --- CARD 4: DISPLAY, AUDIO & TOOLS ---
$toolsCard = Create-Card $panel "Display, Audio & Tools" $CardW
[void](Add-BtnCustom $toolsCard "Fullscreen" @("cycle", "fullscreen") $W1 -Flag "fullscreen")
[void](Add-BtnCustom $toolsCard "Always On Top" @("cycle", "ontop") $W1 -Flag "ontop")
[void](Add-BtnCustom $toolsCard "Shortcuts Overlay" @("script-binding", "toggle_help") $W1 -Break)
[void](Add-BtnCustom $toolsCard "UI Scale -" @("script-binding", "ui_scale_down") $W1)
[void](Add-BtnCustom $toolsCard "UI Scale +" @("script-binding", "ui_scale_up") $W1)
[void](Add-BtnCustom $toolsCard "UI Scale Reset" @("script-binding", "ui_scale_reset") $W1 -Break)

[void](Add-BtnCustom $toolsCard "Mute Audio" @("cycle", "mute") $W1 -Flag "mute")
[void](Add-BtnCustom $toolsCard "Vol -" @("add", "volume", -5) $W1)
[void](Add-BtnCustom $toolsCard "Vol +" @("add", "volume", 5) $W1 -Break)
[void](Add-BtnCustom $toolsCard "Sound Settings" @("script-binding", "audio_menu") $W1)
[void](Add-BtnCustom $toolsCard "Cycle Audio Track" @("cycle", "audio") $W1)
[void](Add-BtnCustom $toolsCard "Loop File" @("cycle-values", "loop-file", "inf", "no") $W1 -Break -Flag "loop")

[void](Add-BtnCustom $toolsCard "A-B Loop" @("ab-loop") $W1 -Flag "abloop")
[void](Add-BtnCustom $toolsCard "Toggle HDR" @("cycle-values", "target-colorspace-hint", "auto", "no") $W1 -Flag "hdr")
[void](Add-BtnCustom $toolsCard "Cycle GPU Upscale" @("script-binding", "upscale_cycle") $W1 -Break -Flag "upscale")
[void](Add-BtnCustom $toolsCard "Deband" @("cycle", "deband") $W1 -Flag "deband")

# Quit Card
$quitBtn = Add-BtnCustom $toolsCard "Quit Player" @("quit") $W2 -Danger -Break

# ============================================================
# RIGHT COLUMN: CARDS & SETTINGS
# ============================================================
function Add-CardText {
    param([System.Windows.Forms.Control]$Container, [string]$Text, [int]$Width = 430, [switch]$Break, [switch]$Dim)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text; $l.AutoSize = $false; $l.Size = New-Object System.Drawing.Size($Width, 20)
    $l.Margin = New-Object System.Windows.Forms.Padding(2, 2, 2, 2)
    $l.TextAlign = "MiddleLeft"
    $l.ForeColor = if ($Dim) { $ColTextMuted } else { [System.Drawing.Color]::Gainsboro }
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $Container.Controls.Add($l)
    if ($Break) { $Container.SetFlowBreak($l, $true) }
    return $l
}

function Add-CardCombo {
    param([System.Windows.Forms.Control]$Container, [string[]]$Items, [string]$Selected, [int]$Width = 150, [switch]$Break)
    $c = New-Object System.Windows.Forms.ComboBox
    $c.Items.AddRange($Items) | Out-Null
    $c.DropDownStyle = "DropDownList"
    $c.Width = $Width; $c.Height = 26
    $c.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 3)
    $c.BackColor = $ColInput; $c.ForeColor = [System.Drawing.Color]::Gainsboro
    $c.FlatStyle = "Flat"
    $c.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $idx = $c.Items.IndexOf($Selected)
    $c.SelectedIndex = if ($idx -ge 0) { $idx } else { 0 }
    $Container.Controls.Add($c)
    if ($Break) { $Container.SetFlowBreak($c, $true) }
    return $c
}

function Add-CardBox {
    param([System.Windows.Forms.Control]$Container, [string]$Value, [int]$Width = 150, [switch]$Break)
    $t = New-Object System.Windows.Forms.TextBox
    $t.Text = $Value; $t.Width = $Width
    $t.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 3)
    $t.BackColor = $ColInput; $t.ForeColor = [System.Drawing.Color]::Gainsboro
    $t.BorderStyle = "FixedSingle"
    $t.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $Container.Controls.Add($t)
    if ($Break) { $Container.SetFlowBreak($t, $true) }
    return $t
}

# --- RIGHT CARD 1: VISUAL ADJUSTMENTS (COLOR GRADING) ---
$lookCard = Create-Card $sideFlow "Visual Adjustments (Look)" $CardW
$script:adjCtl = @{}
$script:lookHasFilter = $false

function Add-SliderCustom {
    param([System.Windows.Forms.Control]$Container, [string]$Key, [string]$Label,
          [int]$Min = -100, [int]$Max = 100, [int]$Default = 0)

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $Label; $lbl.AutoSize = $false; $lbl.Size = New-Object System.Drawing.Size(95, 22)
    $lbl.TextAlign = "MiddleLeft"; $lbl.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 0)
    $lbl.ForeColor = [System.Drawing.Color]::Gainsboro; $lbl.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $Container.Controls.Add($lbl)

    $tb = New-Object Win11Slider
    $tb.Minimum = $Min; $tb.Maximum = $Max; $tb.DefaultValue = $Default; $tb.Value = $Default
    $tb.AccentColor = $TierPalette[$script:tierNow]
    $tb.Width = 270; $tb.Height = 22
    $tb.Margin = New-Object System.Windows.Forms.Padding(0, 0, 2, 0)
    $tb.Tag = $Key
    $Container.Controls.Add($tb)
    $script:allWin11Sliders += $tb

    $val = New-Object System.Windows.Forms.Label
    $val.Text = "$Default"; $val.AutoSize = $false; $val.Size = New-Object System.Drawing.Size(46, 22)
    $val.TextAlign = "MiddleCenter"; $val.Margin = New-Object System.Windows.Forms.Padding(2, 2, 2, 0)
    $val.ForeColor = $ColTextMuted; $val.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $Container.Controls.Add($val); $Container.SetFlowBreak($val, $true)

    $tb.Add_ValueChanged({
        param($sender, $e)
        $k = [string]$sender.Tag
        if ($script:adjCtl.Contains($k)) { $script:adjCtl[$k].Value.Text = "$($sender.Value)" }
        Request-Look
    })

    $script:adjCtl[$Key] = @{ Slider = $tb; Value = $val; Default = $Default }
}

$script:lookPending = $false
$lookTimer = New-Object System.Windows.Forms.Timer
$lookTimer.Interval = 90

function Request-Look {
    $script:lookPending = $true
    $lookTimer.Stop(); $lookTimer.Start()
}

function Apply-Look {
    if (-not $script:connected) { return }
    $a = @{}
    foreach ($k in @($script:adjCtl.Keys)) { $a[$k] = [int]$script:adjCtl[$k].Slider.Value }

    Send-Mpv -Command @("set_property", "brightness", [int]$a["brightness"]) | Out-Null
    Send-Mpv -Command @("set_property", "contrast",   [int]$a["contrast"])   | Out-Null
    Send-Mpv -Command @("set_property", "saturation", [int]$a["saturation"]) | Out-Null
    Send-Mpv -Command @("set_property", "gamma",      [int]$a["gamma"])      | Out-Null
    Send-Mpv -Command @("set_property", "hue",        [int]$a["hue"])        | Out-Null

    $f = @()
    if ($a["temp"] -ne 0) {
        $k = 6500 - ($a["temp"] * 30)
        $f += "colortemperature=temperature=$k"
    }
    if ($a["tint"] -ne 0) {
        $gm = [math]::Round($a["tint"] / 200.0, 3)
        $f += "colorbalance=gm=$gm"
    }
    if ($a["vibrance"] -ne 0) {
        $v = [math]::Round($a["vibrance"] / 100.0, 3)
        $f += "vibrance=intensity=$v"
    }
    if ($a["shadows"] -ne 0 -or $a["highlights"] -ne 0) {
        $s = [math]::Round(0.25 + ($a["shadows"] / 500.0), 3)
        $h = [math]::Round(0.75 + ($a["highlights"] / 500.0), 3)
        $s = [math]::Max(0.02, [math]::Min($s, 0.48))
        $h = [math]::Max(0.52, [math]::Min($h, 0.98))
        $f += "curves=all='0/0 0.25/$s 0.75/$h 1/1'"
    }
    if ($a["sharpness"] -gt 0) {
        $amt = [math]::Round($a["sharpness"] / 50.0, 3)
        $f += "unsharp=5:5:${amt}:5:5:0"
    } elseif ($a["sharpness"] -lt 0) {
        $sig = [math]::Round([math]::Abs($a["sharpness"]) / 50.0, 3)
        $f += "gblur=sigma=$sig"
    }
    if ($a["vignette"] -gt 0) {
        $ang = [math]::Round((3.14159 / 5) * ($a["vignette"] / 100.0), 4)
        $f += "vignette=angle=$ang"
    }

    if ($script:lookHasFilter) {
        Send-Mpv -Command @("vf", "remove", "@milook") | Out-Null
        $script:lookHasFilter = $false
    }
    if ($f.Count -gt 0) {
        $r = Send-Mpv -Command @("vf", "add", "@milook:lavfi=[" + ($f -join ",") + "]")
        if ($r -and $r -match '"error"\s*:\s*"success"') {
            $script:lookHasFilter = $true
        } else {
            Write-Log "Filter rejected: $($f -join ',')"
        }
    }
}

$lookTimer.Add_Tick({
    $lookTimer.Stop()
    if ($script:lookPending) { $script:lookPending = $false; Apply-Look }
})

[void](Add-CardText $lookCard "WHITE BALANCE" 420 -Break)
Add-SliderCustom $lookCard "temp" "Temperature"
Add-SliderCustom $lookCard "tint" "Tint"

[void](Add-CardText $lookCard "LIGHT" 420 -Break)
Add-SliderCustom $lookCard "brightness" "Brightness"
Add-SliderCustom $lookCard "contrast" "Contrast"
Add-SliderCustom $lookCard "highlights" "Highlights"
Add-SliderCustom $lookCard "shadows" "Shadows"
Add-SliderCustom $lookCard "gamma" "Gamma"

[void](Add-CardText $lookCard "COLOUR" 420 -Break)
Add-SliderCustom $lookCard "vibrance" "Vibrance"
Add-SliderCustom $lookCard "saturation" "Saturation"
Add-SliderCustom $lookCard "hue" "Hue"

[void](Add-CardText $lookCard "TEXTURE" 420 -Break)
Add-SliderCustom $lookCard "sharpness" "Sharpness"
Add-SliderCustom $lookCard "vignette" "Vignette"

[void](Add-BtnCustom $lookCard "Reset All Adjustments" $null 180 -Break -OnClick {
    foreach ($k in @($script:adjCtl.Keys)) {
        $c = $script:adjCtl[$k]
        $c.Slider.Value = $c.Default
    }
    Request-Look
})
[void](Add-CardText $lookCard "Double-click any slider to reset to 0. Applies to playback, export and trim." 420 -Dim -Break)

# --- RIGHT CARD 2: AI UPSCALE & ENHANCEMENTS ---
$upCard = Create-Card $sideFlow "AI Upscale & Enhancements" $CardW
[void](Add-CardText $upCard "GPU: $($script:gpuName)" 420 -Dim -Break)

[void](Add-CardText $upCard "Mode" 50)
$upMode = Add-CardCombo $upCard @(
    "Off",
    "CNN 2x (ArtCNN)",
    "FSR (spatial)",
    "RTX Video Super Resolution"
) (State-Or "upscaleMode" "Off") 240

$upDot = New-Object System.Windows.Forms.Label
$upDot.AutoSize = $false; $upDot.Size = New-Object System.Drawing.Size(18, 22); $upDot.Margin = New-Object System.Windows.Forms.Padding(2, 6, 2, 3)
$upCard.Controls.Add($upDot); $upCard.SetFlowBreak($upDot, $true)
Register-Flag "upscale" $upDot

[void](Add-CardText $upCard "Factor" 50)
$upFactor = Add-CardCombo $upCard @("1.5", "2", "3", "4") (State-Or "upscaleFactor" "2") 70

$upHdrToggle = New-Object Win11Toggle
$upHdrToggle.Checked = [bool](State-Or "rtxHdr" $false)
$upHdrToggle.Margin = New-Object System.Windows.Forms.Padding(16, 5, 6, 2)
$upCard.Controls.Add($upHdrToggle)
$script:allWin11Toggles += $upHdrToggle

[void](Add-CardText $upCard "RTX Video HDR (SDR to HDR)" 240 -Break)

if ($script:gpuVendor -ne "nvidia") {
    $upHdrToggle.Enabled = $false
    [void](Add-CardText $upCard "RTX needs NVIDIA - CNN 2x & FSR available." 420 -Dim -Break)
}

function Upscale-ModeKey {
    switch ($upMode.SelectedItem) {
        "CNN 2x (ArtCNN)" { return "cnn" }
        "FSR (spatial)" { return "fsr" }
        "RTX Video Super Resolution" { return "rtx" }
        default { return "off" }
    }
}

function Push-Upscale {
    if (-not $script:connected) { return }
    $mode = Upscale-ModeKey
    if ($mode -eq "rtx" -and $script:gpuVendor -ne "nvidia") {
        Write-Log "RTX needs an NVIDIA GPU - left off"
        $mode = "off"
    }
    Set-MpvSetting "upscale" $mode
    Set-MpvSetting "upscale_factor" $upFactor.SelectedItem
    Set-MpvSetting "rtx_hdr" $(if ($upHdrToggle.Checked) { "yes" } else { "no" })
    Set-MpvSetting "shaders" (Get-CheckedShaders)
    Send-Mpv -Command @("script-binding", "apply_upscale") | Out-Null
}

$upMode.Add_SelectedIndexChanged({ Push-Upscale; Invoke-AutoRescan "upscale mode" })
$upFactor.Add_SelectedIndexChanged({ Push-Upscale; Invoke-AutoRescan "upscale factor" })
$upHdrToggle.Add_CheckedChanged({ Push-Upscale; Invoke-AutoRescan "RTX HDR" })

# Shaders
[void](Add-CardText $upCard "GLSL Shaders (config\shaders)" 420 -Break)
$shaderList = New-Object System.Windows.Forms.CheckedListBox
$shaderList.Width = 330; $shaderList.Height = 140
$shaderList.CheckOnClick = $true
$shaderList.BackColor = $ColInput; $shaderList.ForeColor = [System.Drawing.Color]::Gainsboro
$shaderList.BorderStyle = "FixedSingle"; $shaderList.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
$shaderList.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 3)
$upCard.Controls.Add($shaderList)

$shDot = New-Object System.Windows.Forms.Label
$shDot.AutoSize = $false; $shDot.Size = New-Object System.Drawing.Size(18, 22); $shDot.Margin = New-Object System.Windows.Forms.Padding(2, 6, 2, 3)
$upCard.Controls.Add($shDot); $upCard.SetFlowBreak($shDot, $true)
Register-Flag "shaders" $shDot

$script:shaderPaths = @{}

function Get-CheckedShaders {
    $out = @()
    foreach ($item in $shaderList.CheckedItems) { $out += $script:shaderPaths[[string]$item] }
    return ($out -join ",")
}

function Load-Shaders {
    param([string[]]$PreCheck = @())
    $shaderList.Items.Clear()
    $script:shaderPaths = @{}
    if (Test-Path $ShaderDir) {
        foreach ($f in (Get-ChildItem -Path $ShaderDir -Filter *.glsl -File | Sort-Object Name)) {
            if ($f.Name -like "Upscale-*") { continue }
            $script:shaderPaths[$f.Name] = $f.FullName
            $shaderList.Items.Add($f.Name, ($PreCheck -contains $f.FullName)) | Out-Null
        }
    }
    if ($shaderList.Items.Count -eq 0) { Write-Log "No .glsl shaders found in config\shaders" }
}

$savedShaders = @()
$sv = State-Or "shaders" ""
if ($sv) { $savedShaders = ([string]$sv) -split "," | Where-Object { $_ } }
Load-Shaders -PreCheck $savedShaders

$script:rescan = @{ busy = $false }
function Invoke-AutoRescan {
    param([string]$Because = "setting change")
    if ($script:rescan.busy) { return }
    if ($upMode.SelectedItem -eq "Off") { return }
    if (-not $form.IsHandleCreated) { return }
    $script:rescan.busy = $true
    $guard = $script:rescan
    $work = {
        try {
            $before = Get-CheckedShaders
            Load-Shaders -PreCheck (($before -split ",") | Where-Object { $_ })
            $after = Get-CheckedShaders
            Write-Log "Auto-rescan ($Because): $($shaderList.Items.Count) shader(s) found"
            if ($after -ne $before) {
                Set-MpvSetting "shaders" $after
                Send-Mpv -Command @("script-binding", "apply_upscale") | Out-Null
                Write-Log "Shader set changed on rescan - reapplied"
            }
        } catch {
            Write-Log "Auto-rescan failed: $($_.Exception.Message)"
        } finally {
            $guard.busy = $false
        }
    }.GetNewClosure()
    $form.BeginInvoke([Action]$work) | Out-Null
}

$shaderList.Add_ItemCheck({
    param($sender, $e)
    $paths = @()
    for ($i = 0; $i -lt $shaderList.Items.Count; $i++) {
        $on = if ($i -eq $e.Index) { $e.NewValue -eq "Checked" } else { $shaderList.GetItemChecked($i) }
        if ($on) { $paths += $script:shaderPaths[[string]$shaderList.Items[$i]] }
    }
    Set-MpvSetting "shaders" ($paths -join ",")
    Send-Mpv -Command @("script-binding", "apply_upscale") | Out-Null
    $names = if ($paths.Count) { ($paths | ForEach-Object { Split-Path $_ -Leaf }) -join ", " } else { "none" }
    Write-Log "Shaders: $names"
    Invoke-AutoRescan "shader selection"
})

[void](Add-BtnCustom $upCard "Rescan" $null 76 -OnClick {
    Load-Shaders -PreCheck ((Get-CheckedShaders) -split "," | Where-Object { $_ })
    Write-Log "Rescanned $ShaderDir"
})
[void](Add-BtnCustom $upCard "Open Folder" $null 96 -Break -OnClick {
    if (-not (Test-Path $ShaderDir)) { New-Item -ItemType Directory -Force -Path $ShaderDir | Out-Null }
    Start-Process explorer.exe $ShaderDir
})

# Scalers & API
[void](Add-CardText $upCard "Renderer Scaler" 120)
$scalers = @("ewa_lanczos4sharpest", "ewa_lanczossharp", "ewa_lanczos", "lanczos",
             "spline36", "spline64", "mitchell", "catmull_rom", "bicubic", "bilinear", "nearest")
$scaleSel = Add-CardCombo $upCard $scalers (State-Or "scaler" "ewa_lanczos4sharpest") 170 -Break
$scaleSel.Add_SelectedIndexChanged({
    Send-Mpv -Command @("set_property", "scale", $scaleSel.SelectedItem) | Out-Null
    Send-Mpv -Command @("set_property", "cscale", $scaleSel.SelectedItem) | Out-Null
    Write-Log "Renderer scaler: $($scaleSel.SelectedItem)"
    Invoke-AutoRescan "renderer scaler"
})

[void](Add-CardText $upCard "Downscale" 120)
$dscaleSel = Add-CardCombo $upCard @("mitchell", "catmull_rom", "lanczos", "spline36", "box", "bilinear") (State-Or "dscaler" "mitchell") 170 -Break
$dscaleSel.Add_SelectedIndexChanged({
    Send-Mpv -Command @("set_property", "dscale", $dscaleSel.SelectedItem) | Out-Null
    Write-Log "Downscaler: $($dscaleSel.SelectedItem)"
    Invoke-AutoRescan "downscaler"
})

[void](Add-CardText $upCard "Renderer API" 120)
$apiSel = Add-CardCombo $upCard @("D3D11 (RTX VSR)", "Vulkan") (State-Or "renderApi" "D3D11 (RTX VSR)") 150
[void](Add-BtnCustom $upCard "Apply & Restart" $null 120 -Break -OnClick {
    $vulkan = $apiSel.SelectedItem -eq "Vulkan"
    $conf = if ($vulkan) { "gpu-api=vulkan`r`ngpu-context=winvk`r`n" } else { "gpu-api=d3d11`r`ngpu-context=d3d11`r`n" }
    [IO.File]::WriteAllText((Join-Path $Root "config\render.conf"), $conf, (New-Object System.Text.UTF8Encoding($false)))
    $launch = Join-Path $Root "Launch.ps1"; $panelScript = Join-Path $Root "ControlPanel.ps1"
    $inner = "Start-Sleep -Seconds 2; Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','$launch'; Start-Sleep -Seconds 3; Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File','$panelScript'"
    Start-Process powershell -WindowStyle Hidden -ArgumentList @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $inner)
    Write-Log "Renderer set to $($apiSel.SelectedItem) - restarting player"
    Send-Mpv -Command @("quit") | Out-Null
})

# --- RIGHT CARD 3: CROP ASPECT RATIO ---
$cropCard = Create-Card $sideFlow "Crop Aspect Ratio" $CardW
$script:cropRatioBtns = @()
function Add-CropRatioCustom {
    param([string]$Label, [int]$Rw, [int]$Rh, [int]$Width = 72, [switch]$Break)
    $flag = "crop_" + ($Label -replace ":", "_")
    $b = Add-BtnCustom $cropCard $Label $null $Width -Flag $flag -Break:$Break -OnClick {
        Send-Mpv -Command @("script-message", "mi-crop-aspect", "$Rw", "$Rh", $Label) | Out-Null
    }.GetNewClosure()
    $script:cropRatioBtns += $b
    return $b
}
[void](Add-CropRatioCustom "1:1" 1 1)
[void](Add-CropRatioCustom "4:3" 4 3)
[void](Add-CropRatioCustom "3:4" 3 4)
[void](Add-CropRatioCustom "16:9" 16 9)
[void](Add-CropRatioCustom "9:16" 9 16 -Break)
[void](Add-CropRatioCustom "3:2" 3 2)
[void](Add-CropRatioCustom "2:3" 2 3)
[void](Add-CropRatioCustom "5:4" 5 4)
[void](Add-CropRatioCustom "4:5" 4 5)
[void](Add-CropRatioCustom "21:9" 21 9 -Break)

[void](Add-BtnCustom $cropCard "Center Crop" $null 110 -OnClick { Send-Mpv -Command @("script-message", "mi-crop-center") | Out-Null })
[void](Add-BtnCustom $cropCard "Clear Crop" $null 100 -Flag "crop" -Break -OnClick { Send-Mpv -Command @("script-message", "mi-crop-clear") | Out-Null })

[void](Add-CardText $cropCard "W" 18)
$cropW = Add-CardBox $cropCard "" 65
[void](Add-CardText $cropCard "H" 18)
$cropH = Add-CardBox $cropCard "" 65
[void](Add-CardText $cropCard "X" 18)
$cropX = Add-CardBox $cropCard "0" 55
[void](Add-CardText $cropCard "Y" 18)
$cropY = Add-CardBox $cropCard "0" 55 -Break
[void](Add-CardText $cropCard "Drag image inside crop. Alt+Arrows nudge." 420 -Dim -Break)

# --- RIGHT CARD 4: TRIM & CLIP EXPORT ---
$trimCard = Create-Card $sideFlow "Trim & Clip Export" $CardW
[void](Add-CardText $trimCard "In" 26)
$trimIn = Add-CardBox $trimCard "0" 95
[void](Add-CardText $trimCard "Out" 30)
$trimOut = Add-CardBox $trimCard "" 95 -Break
[void](Add-BtnCustom $trimCard "Set In = now" $null 108 -OnClick {
    $p = Get-MpvProp "time-pos"; if ($null -ne $p) { $trimIn.Text = ("{0:N3}" -f [double]$p) }
})
[void](Add-BtnCustom $trimCard "Set Out = now" $null 114 -OnClick {
    $p = Get-MpvProp "time-pos"; if ($null -ne $p) { $trimOut.Text = ("{0:N3}" -f [double]$p) }
})
[void](Add-BtnCustom $trimCard "Export Trimmed Clip" $null 180 -Break -OnClick {
    $src = Get-MpvProp "path"
    if (-not $src) { return }
    $outDir = if ($expDir.Text) { $expDir.Text } else { Join-Path $Root "Exports" }
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    $base = [IO.Path]::GetFileNameWithoutExtension($src)
    $out = Join-Path $outDir ("{0}_trim_{1}.mp4" -f $base, (Get-Date -Format "HHmmss"))

    $mpv = "C:\Program Files\MPV Player\mpv.exe"
    if (-not (Test-Path $mpv)) { $mpv = (Get-Command mpv -ErrorAction SilentlyContinue).Source }
    if (-not $mpv) { return }

    $a = @("--start=$($trimIn.Text)")
    if ($trimOut.Text) { $a += "--end=$($trimOut.Text)" }
    $vf = @()
    $cropSpec = Get-MpvProp "user-data/mi/crop"
    if ($cropSpec -and "$cropSpec" -match "^\d+:\d+:\d+:\d+$") {
        $vf += "crop=$cropSpec"
    } elseif ($cropW.Text -and $cropH.Text) {
        $vf += "crop=$($cropW.Text):$($cropH.Text):$($cropX.Text):$($cropY.Text)"
    }
    $sc = 100; [void][int]::TryParse($expScale.Text, [ref]$sc)
    if ($sc -ne 100 -and $sc -gt 0) {
        $vf += "scale=w=iw*$($sc/100):h=ih*$($sc/100):flags=$($expScaler.SelectedItem)+accurate_rnd"
    }
    if ($vf.Count) { $a += "--vf=" + ($vf -join ",") }
    $a += @("--ovc=libx264", "--oac=aac", "-o=$out", "--no-config", $src)

    Start-Process -FilePath $mpv -ArgumentList $a -WindowStyle Hidden
    Write-Log "Encoding clip -> $([IO.Path]::GetFileName($out))"
})

# --- RIGHT CARD 5: WINDOW & EXPORT SETTINGS ---
$setCard = Create-Card $sideFlow "Window & Export Settings" $CardW

$fitWinToggle = New-Object Win11Toggle
$fitWinToggle.Checked = [bool](State-Or "fitWindow" $true)
$fitWinToggle.Margin = New-Object System.Windows.Forms.Padding(2, 4, 8, 2)
$setCard.Controls.Add($fitWinToggle)
$script:allWin11Toggles += $fitWinToggle

[void](Add-CardText $setCard "Fit window to each media as it opens" 360 -Break)
$fitWinToggle.Add_CheckedChanged({
    Set-MpvSetting "fit_window" $(if ($fitWinToggle.Checked) { "yes" } else { "no" })
    if ($fitWinToggle.Checked) { Send-Mpv -Command @("script-binding", "fit_window") | Out-Null }
    Invoke-AutoRescan "fit window"
})

[void](Add-CardText $setCard "Export Folder" 85)
$expDir = Add-CardBox $setCard (State-Or "exportDir" (Join-Path $Root "Exports")) 245
[void](Add-BtnCustom $setCard "Browse" $null 75 -Break -OnClick {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($d.ShowDialog() -eq "OK") {
        $expDir.Text = $d.SelectedPath
        Set-MpvSetting "export_dir" $d.SelectedPath
    }
})
$expDir.Add_TextChanged({ Set-MpvSetting "export_dir" $expDir.Text })
$expDir.Add_Leave({ Invoke-AutoRescan "export folder" })

[void](Add-CardText $setCard "Format" 60)
$expFmt = Add-CardCombo $setCard @("jpg", "png", "webp") (State-Or "exportFormat" "jpg") 80
[void](Add-CardText $setCard "Scale %" 60)
$expScale = Add-CardBox $setCard (State-Or "exportScale" "100") 55
[void](Add-CardText $setCard "Scaler" 50)
$expScaler = Add-CardCombo $setCard @("lanczos", "spline", "bicubic", "neighbor") (State-Or "exportScaler" "lanczos") 100 -Break

$expFmt.Add_SelectedIndexChanged({ Set-MpvSetting "export_format" $expFmt.SelectedItem; Invoke-AutoRescan "export format" })
$expScale.Add_TextChanged({ Set-MpvSetting "export_scale" $expScale.Text })
$expScale.Add_Leave({ Invoke-AutoRescan "export scale" })
$expScaler.Add_SelectedIndexChanged({ Set-MpvSetting "export_scaler" $expScaler.SelectedItem; Invoke-AutoRescan "export resampler" })

# --- RIGHT CARD 6: KEYBOARD SHORTCUTS ---
$scCard = Create-Card $sideFlow "Keyboard Shortcuts" $CardW
$shortcuts = @(
    @("Left / Right or < >", "Prev / next file"),
    @("Shift+Left / Right", "Step one frame"),
    @("s", "Slow-mo conform"),
    @("e", "Export frame / image"),
    @("i", "Media info"),
    @("u", "Cycle GPU upscaler"),
    @("z / x", "Zoom fit / 1:1"),
    @("r / Shift+R", "Rotate right / left"),
    @("w", "Refit window to media"),
    @("Ctrl+H", "Toggle HDR"),
    @("Ctrl+A", "Sound settings"),
    @("9 / 0, m, a", "Volume, mute, track"),
    @("[ / ], Backspace", "Speed, reset speed"),
    @("Space, f", "Play/pause, fullscreen"),
    @("Ctrl+= / - / 0", "UI scale up/down/reset"),
    @("Ctrl+P", "Toggle this panel"),
    @("Wheel", "Shuttle (video) / zoom (photo)")
)
foreach ($s in $shortcuts) {
    [void](Add-CardText $scCard $s[0] 170)
    [void](Add-CardText $scCard $s[1] 240 -Dim -Break)
}

# ============================================================
# TIER COLOR & ENABLEMENT DYNAMICS
# ============================================================
function Set-Tier {
    param([string]$Name)
    $c = $TierPalette[$Name]; if (-not $c) { $c = $TierPalette["yellow"] }
    $accent.BackColor = $c
    $logLabel.ForeColor = $c
    $kindChip.ForeColor = $c
    foreach ($l in $script:sectionLabels) { $l.ForeColor = $c }
    foreach ($b in $script:allWin11Buttons) {
        $b.AccentColor = $c
        if ($b.IsAccent) { $b.Invalidate() }
    }
    foreach ($sl in $script:allWin11Sliders) {
        $sl.AccentColor = $c
        $sl.Invalidate()
    }
    foreach ($tg in $script:allWin11Toggles) {
        $tg.AccentColor = $c
        $tg.Invalidate()
    }
}

$script:baseFonts = @{}
foreach ($c in @($panel.Controls)) { $script:baseFonts[$c] = $c.Font.Size }
$script:baseStatusFont = $headerSub.Font.Size
$script:baseLogFont = $logBox.Font.Size

function Set-PanelScale {
    param([double]$Scale)
    $f = [math]::Max(0.85, [math]::Min($Scale / 2.0, 1.9))
    foreach ($c in $script:baseFonts.Keys) {
        $sz = [math]::Max(7.0, [math]::Min($script:baseFonts[$c] * $f, 20.0))
        $style = $c.Font.Style
        try { $c.Font = New-Object System.Drawing.Font($c.Font.FontFamily, $sz, $style) } catch {}
    }
    try {
        $headerSub.Font = New-Object System.Drawing.Font("Segoe UI",
            [math]::Max(8.0, [math]::Min($script:baseStatusFont * $f, 18.0)))
        $logBox.Font = New-Object System.Drawing.Font("Consolas",
            [math]::Max(7.5, [math]::Min($script:baseLogFont * $f, 16.0)))
    } catch {}
}

$script:kindGroups = @{
    time  = @("⏵ Play / Pause", "« -10s", "‹ -1s", "+1s ›", "+10s »", "‹ Frame", "Frame ›",
              "Slow-mo Toggle (24fps Conform)", "A-B Loop", "0.25x", "0.5x", "1.0x", "2.0x", "Slower", "Faster")
    image = @("Fit to Window", "1:1 Actual Pixels", "Zoom In (+)", "Zoom Out (-)", "Reset Zoom",
              "Rotate Left (↶)", "Rotate Right (↷)", "Reset Pan", "Export Frame")
    sound = @("Mute Audio", "Vol -", "Vol +", "Sound Settings", "Cycle Audio Track")
}

function Set-KindEnablement {
    param([string]$Kind)
    foreach ($b in $script:allWin11Buttons) {
        $on = $true
        if ($script:kindGroups.time -contains $b.Text)  { $on = ($Kind -ne "photo") }
        if ($script:kindGroups.image -contains $b.Text) { $on = ($Kind -ne "audio") }
        if ($script:kindGroups.sound -contains $b.Text) { $on = ($Kind -ne "photo") }
        $b.Enabled = $on
    }
}

# ============================================================
# POLL TIMER (IPC & METADATA TICK)
# ============================================================
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if (-not $script:connected -and -not (Connect-Mpv)) {
        $statusPill.Text = "WAITING"
        $statusPill.ForeColor = [System.Drawing.Color]::Orange
        $headerSub.Text = "Waiting for MediaInspector_Pro..."
        return
    }
    $paused = Get-MpvProp "pause"
    if ($null -eq $paused) {
        $statusPill.Text = "DISCONNECTED"
        $statusPill.ForeColor = [System.Drawing.Color]::Gray
        $headerSub.Text = "MediaInspector_Pro disconnected"
        return
    }

    # Heartbeat
    Send-Mpv -Command @("set_property", "user-data/mi/panel_open", $true) | Out-Null

    if (-not $script:settingsPushed) {
        Set-MpvSetting "export_dir" $expDir.Text
        Set-MpvSetting "export_format" $expFmt.SelectedItem
        Set-MpvSetting "export_scale" $expScale.Text
        Set-MpvSetting "export_scaler" $expScaler.SelectedItem
        Set-MpvSetting "fit_window" $(if ($fitWinToggle.Checked) { "yes" } else { "no" })
        Send-Mpv -Command @("set_property", "deband", $true) | Out-Null
        Send-Mpv -Command @("set_property", "scale", $scaleSel.SelectedItem) | Out-Null
        Send-Mpv -Command @("set_property", "cscale", $scaleSel.SelectedItem) | Out-Null
        Send-Mpv -Command @("set_property", "dscale", $dscaleSel.SelectedItem) | Out-Null
        Push-Upscale
        $script:settingsPushed = $true
        Request-Look
    }

    # Logs
    $logJson = Get-MpvProp "user-data/mi/log"
    if ($logJson) {
        try {
            foreach ($e in @($logJson | ConvertFrom-Json)) {
                if ($e.seq -gt $script:lastSeq) {
                    $logBox.AppendText("$($e.text)`r`n")
                    $script:lastSeq = $e.seq
                }
            }
            if ($logBox.TextLength -gt 10000) {
                $logBox.Text = $logBox.Text.Substring($logBox.TextLength - 8000)
                $logBox.SelectionStart = $logBox.TextLength
                $logBox.ScrollToCaret()
            }
        } catch {}
    }

    # Active flags
    $flagJson = Get-MpvProp "user-data/mi/flags"
    if ($flagJson) {
        try { Set-FlagDots ($flagJson | ConvertFrom-Json) } catch {}
    }

    # Crop
    $cropSpec = Get-MpvProp "user-data/mi/crop"
    if ($cropSpec -and "$cropSpec" -match "^(\d+):(\d+):(\d+):(\d+)$") {
        if ($cropW.Text -ne $Matches[1]) { $cropW.Text = $Matches[1] }
        if ($cropH.Text -ne $Matches[2]) { $cropH.Text = $Matches[2] }
        if ($cropX.Text -ne $Matches[3]) { $cropX.Text = $Matches[3] }
        if ($cropY.Text -ne $Matches[4]) { $cropY.Text = $Matches[4] }
    }

    $tierNew = Get-MpvProp "user-data/mi/tier"
    if ($tierNew -and $tierNew -ne $script:tierNow) { $script:tierNow = $tierNew; Set-Tier $tierNew }

    $kindNew = Get-MpvProp "user-data/mi/kind"
    if ($kindNew -and $kindNew -ne $script:kindNow) {
        $script:kindNow = $kindNew
        $kindChip.Text = $kindNew.ToUpper()
        Set-KindEnablement $kindNew
    }

    $scale = Get-MpvProp "user-data/mi/ui_scale"
    if ($scale -and [math]::Abs([double]$scale - $script:scaleNow) -gt 0.02) {
        $script:scaleNow = [double]$scale
        Set-PanelScale $script:scaleNow
    }

    $name = Get-MpvProp "filename"
    if ($name) { $mediaTitle.Text = $name }

    $w = Get-MpvProp "width"; $h = Get-MpvProp "height"
    $gamma = Get-MpvProp "video-params/gamma"; $csHint = Get-MpvProp "target-colorspace-hint"
    $hdrLive = ($gamma -eq "pq" -or $gamma -eq "hlg") -and $csHint -ne "no"

    if ($w -and $h) { $chipDims.Text = "${w}×${h}" }
    else { $chipDims.Text = "" }

    $hwdec = Get-MpvProp "hwdec-current"
    $chipHw.Text = if ($hwdec -and $hwdec -ne "no") { "HW ($hwdec)" } else { "SW (CPU)" }

    if ($hdrLive) {
        $chipHdr.Text = "HDR"
        $chipHdr.ForeColor = $TierPalette["hdr"]
        $chipHdr.BackColor = [System.Drawing.Color]::FromArgb(60, 20, 75)
    } else {
        $chipHdr.Text = "SDR"
        $chipHdr.ForeColor = $ColTextMuted
        $chipHdr.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 38)
    }

    $muted = Get-MpvProp "mute"; $vol = Get-MpvProp "volume"
    if ($muted) {
        $chipVol.Text = "MUTED"
        $chipVol.ForeColor = [System.Drawing.Color]::FromArgb(255, 90, 90)
    } else {
        $chipVol.Text = "vol $([math]::Round($vol))%"
        $chipVol.ForeColor = [System.Drawing.Color]::Gainsboro
    }

    if ($script:kindNow -eq "photo") {
        $statusPill.Text = "PHOTO"
        $statusPill.ForeColor = $TierPalette["photo"]
        $zoom = Get-MpvProp "video-zoom"
        $zVal = if ($null -ne $zoom) { [math]::Pow(2, [double]$zoom) } else { 1.0 }
        $chipTime.Text = "Zoom {0:N2}x" -f $zVal
        $headerSub.Text = "Photo inspection: $($chipDims.Text)"
    } else {
        $pos = Get-MpvProp "time-pos"; $dur = Get-MpvProp "duration"
        $speed = Get-MpvProp "speed"
        $sp = ""
        if ($speed -and [math]::Abs([double]$speed - 1.0) -gt 0.01) { $sp = "  ({0:N2}x)" -f [double]$speed }
        $chipTime.Text = "{0} / {1}" -f (Format-Time $pos), (Format-Time $dur)

        if ($paused) {
            $statusPill.Text = "❚❚ PAUSED"
            $statusPill.ForeColor = [System.Drawing.Color]::FromArgb(245, 170, 85)
            $playBtn.Text = "⏵ Play"
        } else {
            $statusPill.Text = "● PLAYING"
            $statusPill.ForeColor = $TierPalette[$script:tierNow]
            $playBtn.Text = "❚❚ Pause"
        }

        $headerSub.Text = "{0} / {1}{2}  •  {3}  •  {4}" -f (Format-Time $pos), (Format-Time $dur), $sp, $chipHw.Text, $chipDims.Text
    }
})
$timer.Start()

$form.Add_FormClosing({
    $timer.Stop()
    try {
        $b = if ($form.WindowState -eq "Normal") { $form.Bounds } else { $form.RestoreBounds }
        $state = @{
            x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height
            exportDir = $expDir.Text; exportFormat = $expFmt.SelectedItem
            exportScale = $expScale.Text; exportScaler = $expScaler.SelectedItem
            upscaleMode = $upMode.SelectedItem; upscaleFactor = $upFactor.SelectedItem
            rtxHdr = $upHdrToggle.Checked; shaders = (Get-CheckedShaders)
            scaler = $scaleSel.SelectedItem; dscaler = $dscaleSel.SelectedItem
            renderApi = $apiSel.SelectedItem; fitWindow = $fitWinToggle.Checked
        }
        [IO.File]::WriteAllText($PanelStateFile,
            ($state | ConvertTo-Json -Compress),
            (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    if ($script:connected) {
        Send-Mpv -Command @("set_property", "user-data/mi/panel_open", $false) | Out-Null
        Send-Mpv -Command @("quit") | Out-Null
    }
    Disconnect-Mpv
})

[System.Windows.Forms.Application]::Run($form)



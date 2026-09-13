using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

namespace MediaInspector {

public static class Theme {
    public static readonly Color FormBg  = Color.FromArgb(18, 18, 22);
    public static readonly Color CardBg  = Color.FromArgb(24, 24, 30);
    public static readonly Color Input   = Color.FromArgb(14, 14, 18);
    public static readonly Color Border  = Color.FromArgb(46, 46, 56);
    public static readonly Color Text    = Color.Gainsboro;
    public static readonly Color Dim     = Color.FromArgb(140, 140, 150);

    public static readonly Color Yellow = Color.FromArgb(255, 208, 0);
    public static readonly Color Blue   = Color.FromArgb(56, 152, 255);
    public static readonly Color Green  = Color.FromArgb(64, 208, 120);
    public static readonly Color Photo  = Color.FromArgb(240, 168, 88);
    public static readonly Color Audio  = Color.FromArgb(88, 200, 240);
    public static readonly Color Hdr    = Color.FromArgb(210, 90, 255);

    public static Color Tier(string name) {
        switch (name) {
            case "blue":  return Blue;
            case "green": return Green;
            case "photo": return Photo;
            case "audio": return Audio;
            default:      return Yellow;
        }
    }
}

public partial class MainForm : Win11Form {

    public const int CardW = 470;

    // Exposed so --dump-layout can measure the grid without a screenshot.
    public FlowLayoutPanel CardGrid { get { return _grid; } }

    private readonly string _root;
    private readonly string _configDir;
    private readonly string _shaderDir;
    private readonly string _statePath;

    private readonly MpvIpc _ipc = new MpvIpc(MpvPlayer.PipeName);
    private readonly MpvPlayer _player = new MpvPlayer();
    private readonly string _startFile;

    private Panel _videoHost;
    private SplitContainer _split;
    private FlowLayoutPanel _grid;
    private Label _status;
    private Panel _accent;

    private Timer _poll;
    private bool _pushedSettings;
    private readonly List<string> _recent = new List<string>();
    private string _tierNow = "yellow";
    private string _kindNow = "";
    private string _lastPath = "";
    private bool _fittedForCurrent;
    private int _mediaW, _mediaH;
    private bool _syncingSplit;

    private readonly List<Label> _sectionLabels = new List<Label>();
    private readonly List<Win11Button> _buttons = new List<Win11Button>();

    public MainForm(string root, string startFile) {
        _root = root;
        _configDir = Path.Combine(root, "config");
        _shaderDir = Path.Combine(_configDir, "shaders");
        _statePath = Path.Combine(root, "state_panel.json");
        _startFile = startFile;

        Text = "MediaInspector_Pro";
        BackColor = Theme.FormBg;
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 9f);
        MinimumSize = new Size(980, 620);
        Size = new Size(1600, 1000);
        StartPosition = FormStartPosition.CenterScreen;
        AllowDrop = true;

        BuildHeader();
        BuildBody();
        BuildCards();

        DragEnter += OnDragEnter;
        DragDrop += OnDragDrop;
        Shown += OnShown;
        FormClosing += OnClosing;
        Resize += delegate { SyncSplitForMedia(); SyncVideoChild(); };
    }

    // ---------------- chrome ----------------

    private void BuildHeader() {
        var header = new Panel();
        header.Dock = DockStyle.Top;
        header.Height = 58;
        header.BackColor = Color.FromArgb(20, 20, 26);

        _accent = new Panel();
        _accent.Dock = DockStyle.Bottom;
        _accent.Height = 3;
        _accent.BackColor = Theme.Yellow;
        header.Controls.Add(_accent);

        _status = new Label();
        _status.Dock = DockStyle.Fill;
        _status.Padding = new Padding(14, 8, 12, 0);
        _status.ForeColor = Color.Orange;
        _status.Font = new Font("Consolas", 10f);
        _status.Text = "Starting player...";
        header.Controls.Add(_status);

        Controls.Add(header);
    }

    private void BuildBody() {
        _split = new SplitContainer();
        // Give it a real size BEFORE the min sizes: SplitContainer validates
        // SplitterDistance against its current width as each is assigned, and
        // at the default 150px width a 500px Panel2MinSize throws outright.
        _split.Size = new Size(Math.Max(1200, Width), Math.Max(600, Height));
        _split.Orientation = Orientation.Vertical;
        _split.BackColor = Theme.Border;
        _split.SplitterWidth = 6;
        // Controls left, picture right.
        _split.Panel1MinSize = CardW + 34;
        _split.Panel2MinSize = 320;
        // Widening the window should give the extra room to the picture, not
        // silently re-proportion the controls. Dragging the splitter is what
        // changes the control pane - and with it the number of card columns.
        _split.FixedPanel = FixedPanel.Panel1;
        try { _split.SplitterDistance = CardW + 34; } catch { }
        _split.Dock = DockStyle.Fill;

        // The controls live in one wrapping grid; the splitter makes the
        // divide draggable, so the number of card columns follows whatever
        // width it is given.
        _grid = new FlowLayoutPanel();
        _grid.Dock = DockStyle.Fill;
        _grid.FlowDirection = FlowDirection.LeftToRight;
        _grid.WrapContents = true;
        _grid.AutoScroll = true;
        _grid.Padding = new Padding(10, 8, 10, 8);
        _grid.BackColor = Theme.FormBg;
        _split.Panel1.Controls.Add(_grid);
        _split.Panel1.BackColor = Theme.FormBg;

        _videoHost = new Panel();
        _videoHost.Dock = DockStyle.Fill;
        _videoHost.BackColor = Color.Black;
        _split.Panel2.Controls.Add(_videoHost);
        _split.Panel2.BackColor = Color.Black;

        Controls.Add(_split);
        _split.BringToFront();
    }

    // ---------------- lifecycle ----------------

    private void OnShown(object sender, EventArgs e) {
        // Give the split a sane starting divide once real dimensions exist.
        try { _split.SplitterDistance = CardW + 34; } catch { }

        if (!_player.Start(_videoHost.Handle, _configDir, _startFile)) {
            MessageBox.Show(
                "mpv.exe not found. Install it with:\r\n\r\nwinget install --id shinchiro.mpv -e",
                "MediaInspector_Pro");
            Close();
            return;
        }

        _poll = new Timer();
        _poll.Interval = 500;
        _poll.Tick += OnPoll;
        _poll.Start();

        _look = new Timer();
        _look.Interval = 90;
        _look.Tick += delegate { _look.Stop(); ApplyLook(); };
    }

    private void OnClosing(object sender, FormClosingEventArgs e) {
        if (_poll != null) _poll.Stop();
        SaveState();
        _player.Quit(_ipc);
        _ipc.Disconnect();
    }

    private void OnDragEnter(object sender, DragEventArgs e) {
        if (e.Data.GetDataPresent(DataFormats.FileDrop)) e.Effect = DragDropEffects.Copy;
    }

    private void OnDragDrop(object sender, DragEventArgs e) {
        var files = e.Data.GetData(DataFormats.FileDrop) as string[];
        if (files != null && files.Length > 0) _ipc.Command("loadfile", files[0], "replace");
    }

    private void SyncVideoChild() {
        if (_videoHost == null) return;
        _player.ResizeChildTo(_videoHost.Handle, _videoHost.ClientSize.Width, _videoHost.ClientSize.Height);
    }

    // There is no log pane any more. Feedback goes where the eye already is:
    // on the picture, via mpv's own OSD - the same place the player's own
    // messages appear, so there is one channel rather than two.
    public void Log(string text) {
        _recent.Add(DateTime.Now.ToString("HH:mm:ss") + "  " + text);
        if (_recent.Count > 80) _recent.RemoveAt(0);
        if (_ipc.Connected) _ipc.Command("show-text", text, 2600);
    }

    // ---------------- polling ----------------

    private void OnPoll(object sender, EventArgs e) {
        if (!_ipc.Connected && !_ipc.Connect(200)) {
            if (!_player.Alive) {
                _status.Text = "Player exited.";
                _status.ForeColor = Color.OrangeRed;
            } else {
                _status.Text = "Connecting to player...";
                _status.ForeColor = Color.Orange;
            }
            return;
        }

        bool? paused = _ipc.GetBool("pause");
        if (paused == null) {
            _status.Text = "Waiting for player...";
            _status.ForeColor = Color.Orange;
            return;
        }
        // No log pane now, so the script keeps showing its own messages as
        // OSD over the picture rather than routing them to us.
        _ipc.SetUserData("embedded", "yes");

        if (!_pushedSettings) {
            PushAllSettings();
            _pushedSettings = true;
            RequestLook();
            // The picture is live now, so give it the keyboard: the player's
            // own bindings are the ones a viewer reaches for first, and the
            // control cards take focus back the moment one is clicked.
            _player.FocusVideo(_videoHost.Handle);
        }

        string tier = _ipc.GetString("user-data/mi/tier");
        if (!string.IsNullOrEmpty(tier) && tier != _tierNow) {
            _tierNow = tier;
            ApplyTier(Theme.Tier(tier));
        }

        string kind = _ipc.GetString("user-data/mi/kind");
        if (!string.IsNullOrEmpty(kind) && kind != _kindNow) {
            _kindNow = kind;
            ApplyKindEnablement(kind);
        }

        SyncBrowseScope();
        SyncCropBoxes();

        string path = _ipc.GetString("path");
        if (!string.IsNullOrEmpty(path) && path != _lastPath) {
            _lastPath = path;
            _fittedForCurrent = false;
        }
        if (!_fittedForCurrent) FitWindowToMedia();

        UpdateStatus(paused.Value);
        SyncVideoChild();
    }

    private void UpdateStatus(bool paused) {
        string name = _ipc.GetString("filename");
        int dw, dh;
        if (DisplayShape(out dw, out dh)) {
            int nw = dw, nh = dh;
            if (nw != _mediaW || nh != _mediaH) {
                _mediaW = nw;
                _mediaH = nh;
                // The shape changed - another file, a rotation, or a crop
                // applied or cleared - so the divide between the cards and the
                // picture is stale.
                SyncSplitForMedia();
            }
        }
        double? w = _mediaW > 0 ? (double?)_mediaW : null;
        double? h = _mediaH > 0 ? (double?)_mediaH : null;
        string gamma = _ipc.GetString("video-params/gamma");
        string hint = _ipc.GetString("target-colorspace-hint");
        bool hdrLive = (gamma == "pq" || gamma == "hlg") && hint != "no";
        string hw = _ipc.GetString("hwdec-current");
        bool? muted = _ipc.GetBool("mute");
        double? vol = _ipc.GetNumber("volume");

        string line1;
        if (_kindNow == "photo") {
            double? zoom = _ipc.GetNumber("video-zoom");
            double factor = zoom.HasValue ? Math.Pow(2, zoom.Value) : 1.0;
            line1 = "PHOTO   " + Dim(w, h) + "   zoom " + factor.ToString("0.00", CultureInfo.InvariantCulture);
        } else {
            double? pos = _ipc.GetNumber("time-pos");
            double? dur = _ipc.GetNumber("duration");
            double? speed = _ipc.GetNumber("speed");
            string sp = "";
            if (speed.HasValue && Math.Abs(speed.Value - 1.0) > 0.01)
                sp = "   " + speed.Value.ToString("0.00", CultureInfo.InvariantCulture) + "x";
            line1 = (paused ? "PAUSED " : "PLAYING") + "   " + Time(pos) + " / " + Time(dur) + sp;
        }
        if (hdrLive) line1 += "   HDR";

        string line2 = (muted.HasValue && muted.Value ? "muted" : "vol " + (vol.HasValue ? Math.Round(vol.Value).ToString() : "?") + "%")
                     + "   " + (string.IsNullOrEmpty(hw) || hw == "no" ? "SW (CPU)" : "HW (" + hw + ")")
                     + "   " + Dim(w, h)
                     + "   " + (name == null ? "" : (name.Length > 46 ? name.Substring(0, 45) + "~" : name));

        _status.Text = line1 + "\r\n" + line2;
        _status.ForeColor = hdrLive ? Theme.Hdr : Theme.Tier(_tierNow);
    }

    private static string Dim(double? w, double? h) {
        if (!w.HasValue || !h.HasValue) return "";
        return ((int)w.Value) + "x" + ((int)h.Value);
    }

    private static string Time(double? t) {
        if (!t.HasValue || double.IsNaN(t.Value)) return "0:00";
        double v = Math.Max(0, t.Value);
        int hh = (int)(v / 3600), mm = (int)((v % 3600) / 60), ss = (int)(v % 60);
        if (hh > 0) return hh + ":" + mm.ToString("00") + ":" + ss.ToString("00");
        return mm + ":" + ss.ToString("00");
    }

    private void ApplyTier(Color c) {
        _accent.BackColor = c;
        foreach (Label l in _sectionLabels) l.ForeColor = c;
        foreach (Win11Button b in _buttons) b.AccentColor = c;
        Invalidate(true);
    }

    // The picture's shape as displayed. Neither the decoded size nor mpv's
    // reported one will do: a crop makes dwidth/dheight differ from
    // width/height, and a phone shoots 3840x2160 with a rotate-90 flag that
    // every one of mpv's size properties reports unrotated - which is why
    // portrait clips were being laid out as landscape.
    private bool DisplayShape(out int w, out int h) {
        w = 0; h = 0;
        double? dw = _ipc.GetNumber("dwidth") ?? _ipc.GetNumber("width");
        double? dh = _ipc.GetNumber("dheight") ?? _ipc.GetNumber("height");
        if (!dw.HasValue || !dh.HasValue || dw.Value < 1 || dh.Value < 1) return false;

        double container = _ipc.GetNumber("video-params/rotate") ?? 0;
        double user = _ipc.GetNumber("video-rotate") ?? 0;
        bool quarter = (((int)(container + user) % 180) + 180) % 180 == 90;
        w = (int)(quarter ? dh.Value : dw.Value);
        h = (int)(quarter ? dw.Value : dh.Value);
        return true;
    }

    // Give the picture the shape it actually wants and hand whatever is left
    // over to the cards. A portrait clip in a landscape window would otherwise
    // sit in a wide letterbox with a one-column menu beside it; widening the
    // menu instead lets the video fill its side and buys a second card column.
    // Clamped both ways: never below one card column, never below the picture's
    // own minimum. Dragging the splitter still wins until the window is resized
    // or another file is loaded.
    private void SyncSplitForMedia() {
        if (_split == null || _syncingSplit) return;
        if (_mediaW < 1 || _mediaH < 1) return;

        int total = _split.ClientSize.Width - _split.SplitterWidth;
        int paneH = _split.ClientSize.Height;
        if (total < 10 || paneH < 10) return;

        int wantVideo = (int)Math.Round(paneH * (double)_mediaW / _mediaH);
        int min = CardW + 34;
        int max = total - _split.Panel2MinSize;
        if (max < min) return;

        int left = Math.Max(min, Math.Min(total - wantVideo, max));
        if (Math.Abs(_split.SplitterDistance - left) < 2) return;

        _syncingSplit = true;
        try { _split.SplitterDistance = left; } catch { } finally { _syncingSplit = false; }
        SyncVideoChild();
    }

    // Fit the WINDOW so the video area lands at the media's own size - the
    // same behaviour the standalone player had, but done here because mpv is
    // now a child window and cannot resize the frame around it.
    private void FitWindowToMedia() {
        if (!_fitWindow) { _fittedForCurrent = true; return; }
        if (WindowState != FormWindowState.Normal) return;
        int dw, dh;
        if (!DisplayShape(out dw, out dh)) return;
        double? w = dw, h = dh;

        _fittedForCurrent = true;
        _mediaW = dw;
        _mediaH = dh;

        Rectangle wa = Screen.FromControl(this).WorkingArea;
        int chromeW = Width - _videoHost.ClientSize.Width;
        int chromeH = Height - _videoHost.ClientSize.Height;

        double maxW = wa.Width * 0.96 - chromeW;
        double maxH = wa.Height * 0.94 - chromeH;
        if (maxW < 200 || maxH < 200) return;

        double scale = Math.Min(1.0, Math.Min(maxW / w.Value, maxH / h.Value));
        int newW = (int)Math.Round(w.Value * scale) + chromeW;
        int newH = (int)Math.Round(h.Value * scale) + chromeH;

        newW = Math.Max(MinimumSize.Width, Math.Min(newW, wa.Width));
        newH = Math.Max(MinimumSize.Height, Math.Min(newH, wa.Height));
        Size = new Size(newW, newH);

        if (Left + newW > wa.Right) Left = Math.Max(wa.Left, wa.Right - newW);
        if (Top + newH > wa.Bottom) Top = Math.Max(wa.Top, wa.Bottom - newH);

        SyncVideoChild();
        Log("Window fitted to " + ((int)w.Value) + "x" + ((int)h.Value) + " source");
    }
}
}


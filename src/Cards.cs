using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace MediaInspector {

public partial class MainForm {

    // Card inner width is CardW minus the card's 12+12 padding; the button
    // widths below tile that exactly three, two and one across.
    private const int W1 = 140;
    private const int W2 = 286;
    private const int W3 = 434;

    private Timer _look;
    private bool _fitWindow = true;

    private readonly Dictionary<string, int> _adj = new Dictionary<string, int>();
    private readonly Dictionary<string, Win11Slider> _adjCtl = new Dictionary<string, Win11Slider>();
    private readonly Dictionary<string, string> _state = new Dictionary<string, string>();

    private CheckedListBox _shaderList;
    private readonly Dictionary<string, string> _shaderPaths = new Dictionary<string, string>();
    private ComboBox _upMode, _upFactor, _scaleSel, _dscaleSel, _apiSel, _expFmt, _expScaler;
    private Win11Toggle _rtxHdr, _fitToggle, _videoOnly;
    private bool _syncingScope;
    private string _cropShown = "";
    private TextBox _expDir, _expScale, _cropW, _cropH, _cropX, _cropY, _trimIn, _trimOut;
    private readonly List<Win11Button> _timeBtns = new List<Win11Button>();
    private readonly List<Win11Button> _imageBtns = new List<Win11Button>();
    private readonly List<Win11Button> _soundBtns = new List<Win11Button>();

    private FormWindowState _preFsState = FormWindowState.Normal;
    private FormBorderStyle _preFsBorder = FormBorderStyle.Sizable;
    private bool _isFullscreen;

    // ---------------- small builders ----------------

    private void Cmd(params object[] c) { _ipc.Command(c); }

    private FlowLayoutPanel Card(string title) {
        var card = new Win11Card();
        card.Width = CardW;
        card.MinimumSize = new Size(CardW, 0);
        card.MaximumSize = new Size(CardW, 0);
        card.AutoSize = true;
        card.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        card.Margin = new Padding(0, 0, 10, 10);

        var head = new Panel();
        head.Dock = DockStyle.Top;
        head.Height = 22;
        head.BackColor = Color.Transparent;

        var l = new Label();
        l.Text = title.ToUpperInvariant();
        l.Dock = DockStyle.Fill;
        l.TextAlign = ContentAlignment.MiddleLeft;
        l.ForeColor = Theme.Yellow;
        l.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
        head.Controls.Add(l);
        _sectionLabels.Add(l);

        var content = new FlowLayoutPanel();
        content.Dock = DockStyle.Top;
        content.AutoSize = true;
        content.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        content.FlowDirection = FlowDirection.LeftToRight;
        content.WrapContents = true;
        content.BackColor = Color.Transparent;
        content.Padding = new Padding(0, 4, 0, 0);
        int inner = CardW - (card.Padding.Left + card.Padding.Right);
        content.MinimumSize = new Size(inner, 0);
        content.MaximumSize = new Size(inner, 0);

        // Reverse visual order: the last Dock=Top child sits closest to the edge.
        card.Controls.Add(content);
        card.Controls.Add(head);
        _grid.Controls.Add(card);
        return content;
    }

    private Win11Button Btn(Control p, string text, int w, EventHandler onClick,
                            bool brk = false, bool danger = false, bool accent = false) {
        var b = new Win11Button();
        b.Text = text;
        b.Size = new Size(w, 32);
        b.Margin = new Padding(3, 3, 3, 3);
        b.IsDanger = danger;
        b.IsAccent = accent;
        b.AccentColor = Theme.Tier(_tierNow);
        if (onClick != null) b.Click += onClick;
        p.Controls.Add(b);
        if (brk) ((FlowLayoutPanel)p).SetFlowBreak(b, true);
        _buttons.Add(b);
        return b;
    }

    private Win11Button Send(Control p, string text, int w, bool brk, params object[] cmd) {
        object[] c = cmd;
        return Btn(p, text, w, delegate { Cmd(c); }, brk);
    }

    private Win11Button Bind(Control p, string text, int w, bool brk, string binding) {
        string bn = binding;
        return Btn(p, text, w, delegate { _ipc.ScriptBinding(bn); }, brk);
    }

    private Label Txt(Control p, string s, int w, bool dim = false, bool brk = false) {
        var l = new Label();
        l.Text = s;
        l.AutoSize = false;
        l.Size = new Size(w, 18);
        l.Margin = new Padding(3, 4, 3, 1);
        l.TextAlign = ContentAlignment.MiddleLeft;
        l.ForeColor = dim ? Theme.Dim : Theme.Text;
        l.Font = new Font("Segoe UI", 8.5f);
        p.Controls.Add(l);
        if (brk) ((FlowLayoutPanel)p).SetFlowBreak(l, true);
        return l;
    }

    private ComboBox Combo(Control p, string[] items, string sel, int w, bool brk, EventHandler onChange) {
        var c = new ComboBox();
        c.Items.AddRange(items);
        c.DropDownStyle = ComboBoxStyle.DropDownList;
        c.Width = w;
        c.Margin = new Padding(3, 3, 3, 3);
        c.BackColor = Theme.Input;
        c.ForeColor = Theme.Text;
        c.FlatStyle = FlatStyle.Flat;
        c.Font = new Font("Segoe UI", 8.5f);
        int i = c.Items.IndexOf(sel);
        c.SelectedIndex = i >= 0 ? i : 0;
        if (onChange != null) c.SelectedIndexChanged += onChange;
        p.Controls.Add(c);
        if (brk) ((FlowLayoutPanel)p).SetFlowBreak(c, true);
        return c;
    }

    private TextBox Box(Control p, string val, int w, bool brk, EventHandler onChange = null) {
        var t = new TextBox();
        t.Text = val;
        t.Width = w;
        t.Margin = new Padding(3, 3, 3, 3);
        t.BackColor = Theme.Input;
        t.ForeColor = Theme.Text;
        t.BorderStyle = BorderStyle.FixedSingle;
        t.Font = new Font("Consolas", 8.5f);
        if (onChange != null) t.TextChanged += onChange;
        p.Controls.Add(t);
        if (brk) ((FlowLayoutPanel)p).SetFlowBreak(t, true);
        return t;
    }

    private Win11Slider Slid(Control p, string key, string label, int min, int max, int def) {
        _adj[key] = def;
        Txt(p, label, 92);
        var s = new Win11Slider();
        s.Minimum = min; s.Maximum = max; s.DefaultValue = def; s.Value = def;
        s.Width = 250; s.Height = 22;
        s.Margin = new Padding(3, 3, 3, 2);
        s.AccentColor = Theme.Tier(_tierNow);
        var val = Txt(p, def.ToString(), 40, true, true);
        string k = key;
        s.ValueChanged += delegate {
            _adj[k] = s.Value;
            val.Text = s.Value.ToString();
            RequestLook();
        };
        p.Controls.Add(s);
        // Put the slider between its label and its readout.
        p.Controls.SetChildIndex(s, p.Controls.GetChildIndex(val));
        _adjCtl[key] = s;
        return s;
    }

    private Win11Toggle Tog(Control p, bool init, EventHandler onChange, bool brk = false) {
        var t = new Win11Toggle();
        t.Checked = init;
        t.Margin = new Padding(3, 4, 3, 3);
        t.AccentColor = Theme.Tier(_tierNow);
        if (onChange != null) t.CheckedChanged += onChange;
        p.Controls.Add(t);
        if (brk) ((FlowLayoutPanel)p).SetFlowBreak(t, true);
        return t;
    }

    private string S(string key, string fallback) {
        string v;
        if (_state.TryGetValue(key, out v) && !string.IsNullOrEmpty(v)) return v;
        return fallback;
    }

    // ---------------- the cards ----------------

    private void BuildCards() {
        LoadState();

        // --- playback ---
        var c = Card("Playback & Transport");
        Btn(c, "⏵  Play / Pause", W3, delegate { Cmd("cycle", "pause"); }, true, false, true);
        _timeBtns.Add(Send(c, "« -10s", W1, false, "seek", -10, "exact"));
        _timeBtns.Add(Send(c, "‹ -1s", W1, false, "seek", -1, "exact"));
        _timeBtns.Add(Send(c, "‹ Frame", W1, true, "frame-back-step"));
        _timeBtns.Add(Send(c, "+1s ›", W1, false, "seek", 1, "exact"));
        _timeBtns.Add(Send(c, "+10s »", W1, false, "seek", 10, "exact"));
        _timeBtns.Add(Send(c, "Frame ›", W1, true, "frame-step"));
        _timeBtns.Add(Send(c, "0.25x", 84, false, "set_property", "speed", 0.25));
        _timeBtns.Add(Send(c, "0.5x", 84, false, "set_property", "speed", 0.5));
        _timeBtns.Add(Send(c, "1.0x", 84, false, "set_property", "speed", 1.0));
        _timeBtns.Add(Send(c, "2.0x", 84, false, "set_property", "speed", 2.0));
        _timeBtns.Add(Bind(c, "Slow-mo", 84, true, "slowmo_toggle"));

        // --- media ---
        c = Card("Media & Navigation");
        Btn(c, "Open Media...", W2, delegate { OpenMedia(); });
        Bind(c, "Media Info", W1, true, "show_info");
        Bind(c, "« Previous", W1, false, "prev_media");
        Bind(c, "Next »", W1, false, "next_media");
        Btn(c, "Open Exports", W1, delegate { OpenExports(); }, true);
        Txt(c, "Browse videos only", 190);
        _videoOnly = Tog(c, true, delegate {
            if (_syncingScope) return;
            _ipc.SetSetting("browse_all", _videoOnly.Checked ? "no" : "yes");
        }, true);
        Txt(c, "Off also steps through photos and audio in the folder.", W3, true, true);

        // --- image ---
        c = Card("Image Inspection & Zoom");
        _imageBtns.Add(Bind(c, "Fit to Window", W1, false, "zoom_fit"));
        _imageBtns.Add(Bind(c, "1:1 Actual Pixels", W1, false, "zoom_actual"));
        _imageBtns.Add(Btn(c, "Fit Window to Media", W1, delegate { _fittedForCurrent = false; FitWindowToMedia(); }, true));
        _imageBtns.Add(Bind(c, "Zoom In (+)", W1, false, "zoom_in"));
        _imageBtns.Add(Bind(c, "Zoom Out (-)", W1, false, "zoom_out"));
        _imageBtns.Add(Send(c, "Reset Zoom", W1, true, "set_property", "video-zoom", 0));
        _imageBtns.Add(Bind(c, "Rotate Left", W1, false, "rotate_ccw"));
        _imageBtns.Add(Bind(c, "Rotate Right", W1, false, "rotate_cw"));
        _imageBtns.Add(Btn(c, "Reset Pan", W1, delegate {
            Cmd("set_property", "video-pan-x", 0);
            Cmd("set_property", "video-pan-y", 0);
        }, true));
        _imageBtns.Add(Bind(c, "Export Frame", W2, false, "export_frame"));

        // --- display / audio / tools ---
        c = Card("Display, Audio & Tools");
        // Fullscreen and always-on-top belong to the host now: mpv's own
        // fullscreen cannot work on a child window.
        Btn(c, "Fullscreen", W1, delegate { ToggleFullscreen(); });
        Btn(c, "Always On Top", W1, delegate { TopMost = !TopMost; Log("Always on top: " + (TopMost ? "on" : "off")); });
        Bind(c, "Shortcuts Overlay", W1, true, "toggle_help");
        Bind(c, "UI Scale -", W1, false, "ui_scale_down");
        Bind(c, "UI Scale +", W1, false, "ui_scale_up");
        Bind(c, "UI Scale Reset", W1, true, "ui_scale_reset");
        _soundBtns.Add(Send(c, "Mute Audio", W1, false, "cycle", "mute"));
        _soundBtns.Add(Send(c, "Vol -", W1, false, "add", "volume", -5));
        _soundBtns.Add(Send(c, "Vol +", W1, true, "add", "volume", 5));
        _soundBtns.Add(Bind(c, "Sound Settings", W1, false, "audio_menu"));
        _soundBtns.Add(Send(c, "Cycle Audio Track", W1, false, "cycle", "audio"));
        Send(c, "Loop File", W1, true, "cycle-values", "loop-file", "inf", "no");
        Send(c, "A-B Loop", W1, false, "ab-loop");
        Bind(c, "Toggle HDR", W1, false, "hdr_toggle");
        Send(c, "Deband", W1, true, "cycle", "deband");
        Btn(c, "Quit", W3, delegate { Close(); }, true, true);

        // --- look ---
        c = Card("Visual Adjustments (Look)");
        Txt(c, "WHITE BALANCE", W3, true, true);
        Slid(c, "temp", "Temperature", -100, 100, 0);
        Slid(c, "tint", "Tint", -100, 100, 0);
        Txt(c, "LIGHT", W3, true, true);
        Slid(c, "brightness", "Brightness", -100, 100, 0);
        Slid(c, "contrast", "Contrast", -100, 100, 0);
        Slid(c, "highlights", "Highlights", -100, 100, 0);
        Slid(c, "shadows", "Shadows", -100, 100, 0);
        Slid(c, "gamma", "Gamma", -100, 100, 0);
        Txt(c, "COLOUR", W3, true, true);
        Slid(c, "vibrance", "Vibrance", -100, 100, 0);
        Slid(c, "saturation", "Saturation", -100, 100, 0);
        Slid(c, "hue", "Hue", -100, 100, 0);
        Txt(c, "TEXTURE", W3, true, true);
        Slid(c, "sharpness", "Sharpness", -100, 100, 0);
        Slid(c, "vignette", "Vignette", 0, 100, 0);
        Btn(c, "Reset All Adjustments", W2, delegate {
            foreach (var kv in _adjCtl) kv.Value.Value = kv.Value.DefaultValue;
            RequestLook();
        }, true);
        Txt(c, "Applies to playback, exported frames and trimmed clips.", W3, true, true);

        BuildUpscaleCard();
        BuildCropCard();
        BuildTrimCard();
        BuildSettingsCard();
        BuildShortcutsCard();
    }

    private void BuildUpscaleCard() {
        var c = Card("GPU Upscale & Enhancements");
        Txt(c, "GPU: " + GpuName(), W3, true, true);

        Txt(c, "Mode", 60);
        _upMode = Combo(c, new[] { "Off", "RTX Video Super Resolution" }, S("upscaleMode", "Off"), 250, true,
            delegate { PushUpscale(); });
        Txt(c, "Factor", 60);
        _upFactor = Combo(c, new[] { "1.5", "2", "3", "4" }, S("upscaleFactor", "2"), 70, false,
            delegate { PushUpscale(); });
        Txt(c, "RTX Video HDR", 110);
        _rtxHdr = Tog(c, S("rtxHdr", "no") == "yes", delegate { PushUpscale(); }, true);

        Txt(c, "GPU shaders (config\\shaders)", W3, true, true);
        _shaderList = new CheckedListBox();
        _shaderList.Width = W3;
        _shaderList.Height = 96;
        _shaderList.CheckOnClick = true;
        _shaderList.BackColor = Theme.Input;
        _shaderList.ForeColor = Theme.Text;
        _shaderList.BorderStyle = BorderStyle.FixedSingle;
        _shaderList.Font = new Font("Segoe UI", 8.5f);
        _shaderList.Margin = new Padding(3, 3, 3, 3);
        _shaderList.ItemCheck += OnShaderCheck;
        c.Controls.Add(_shaderList);
        ((FlowLayoutPanel)c).SetFlowBreak(_shaderList, true);
        LoadShaders(S("shaders", "").Split(','));

        Btn(c, "Rescan", W1, delegate {
            LoadShaders(CheckedShaders().Split(','));
            Log("Rescanned " + _shaderDir);
        });
        Btn(c, "Open Folder", W1, delegate {
            Directory.CreateDirectory(_shaderDir);
            System.Diagnostics.Process.Start("explorer.exe", _shaderDir);
        }, true);

        Txt(c, "Renderer scaler", 120);
        _scaleSel = Combo(c, new[] { "ewa_lanczos4sharpest", "ewa_lanczossharp", "ewa_lanczos", "lanczos",
                                     "spline36", "spline64", "mitchell", "catmull_rom", "bicubic", "bilinear", "nearest" },
            S("scaler", "ewa_lanczos4sharpest"), 290, true, delegate {
                Cmd("set_property", "scale", _scaleSel.SelectedItem);
                Cmd("set_property", "cscale", _scaleSel.SelectedItem);
                Log("Renderer scaler: " + _scaleSel.SelectedItem);
            });

        Txt(c, "Downscale", 120);
        _dscaleSel = Combo(c, new[] { "mitchell", "catmull_rom", "lanczos", "spline36", "box", "bilinear" },
            S("dscaler", "mitchell"), 290, true, delegate {
                Cmd("set_property", "dscale", _dscaleSel.SelectedItem);
                Log("Downscaler: " + _dscaleSel.SelectedItem);
            });

        Txt(c, "Renderer API", 120);
        _apiSel = Combo(c, new[] { "D3D11 (RTX VSR)", "Vulkan" }, S("renderApi", "D3D11 (RTX VSR)"), 170, false, null);
        Btn(c, "Apply", 128, delegate { ApplyRendererApi(); }, true);
        Txt(c, "Shaders apply everywhere. RTX needs hardware-decoded video on D3D11.", W3, true, true);
    }

    // Every control here goes through the player's script messages rather
    // than setting the filter itself: the player owns one crop rectangle, and
    // the box you drag on the picture and these numbers have to be that same
    // rectangle or the two quietly disagree about what is cropped.
    private void BuildCropCard() {
        var c = Card("Crop Aspect Ratio");
        Btn(c, "Adjust on the Picture  (c)", W3, delegate {
            Cmd("script-message", "mi-crop-edit");
        }, true, false, true);
        Txt(c, "Drag the box or its handles over the video. Enter applies, Esc cancels.", W3, true, true);

        string[] ratios = { "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "5:4", "4:5", "21:9" };
        for (int i = 0; i < ratios.Length; i++) {
            string r = ratios[i];
            Btn(c, r, 82, delegate { ApplyAspectCrop(r); }, (i % 5) == 4);
        }
        Txt(c, "W", 18); _cropW = Box(c, "", 74, false);
        Txt(c, "H", 18); _cropH = Box(c, "", 74, false);
        Txt(c, "X", 18); _cropX = Box(c, "0", 60, false);
        Txt(c, "Y", 18); _cropY = Box(c, "0", 60, true);
        Btn(c, "Apply Crop", W1, delegate {
            if (_cropW.Text.Length > 0 && _cropH.Text.Length > 0) {
                Cmd("script-message", "mi-crop-rect", _cropW.Text, _cropH.Text,
                    _cropX.Text.Length > 0 ? _cropX.Text : "0",
                    _cropY.Text.Length > 0 ? _cropY.Text : "0");
                Log("Crop " + _cropW.Text + "x" + _cropH.Text);
            }
        });
        Btn(c, "Clear Crop", W1, delegate { Cmd("script-message", "mi-crop-clear"); Log("Crop cleared"); });
        Btn(c, "Fill from Media", W1, delegate {
            double? w = _ipc.GetNumber("width"); double? h = _ipc.GetNumber("height");
            if (w.HasValue && h.HasValue) {
                _cropW.Text = ((int)w.Value).ToString(); _cropH.Text = ((int)h.Value).ToString();
                _cropX.Text = "0"; _cropY.Text = "0";
            }
        }, true);
    }

    private void BuildTrimCard() {
        var c = Card("Trim & Clip Export");
        Txt(c, "In", 24); _trimIn = Box(c, "0", 100, false);
        Txt(c, "Out", 30); _trimOut = Box(c, "", 100, true);
        Btn(c, "Set In = now", W1, delegate {
            double? p = _ipc.GetNumber("time-pos");
            if (p.HasValue) _trimIn.Text = p.Value.ToString("0.000", CultureInfo.InvariantCulture);
        });
        Btn(c, "Set Out = now", W1, delegate {
            double? p = _ipc.GetNumber("time-pos");
            if (p.HasValue) _trimOut.Text = p.Value.ToString("0.000", CultureInfo.InvariantCulture);
        }, true);
        Btn(c, "Export Trimmed Clip", W2, delegate { ExportTrim(); }, true);
        Txt(c, "Times in seconds. Blank Out = end of file.", W3, true, true);
    }

    private void BuildSettingsCard() {
        var c = Card("Window & Export Settings");
        _fitWindow = S("fitWindow", "yes") == "yes";
        Txt(c, "Fit window to each file", 190);
        _fitToggle = Tog(c, _fitWindow, delegate {
            _fitWindow = _fitToggle.Checked;
            if (_fitWindow) { _fittedForCurrent = false; FitWindowToMedia(); }
        }, true);

        Txt(c, "Export folder", 100);
        _expDir = Box(c, S("exportDir", Path.Combine(_root, "Exports")), 230, false,
            delegate { _ipc.SetSetting("export_dir", _expDir.Text); });
        Btn(c, "...", 60, delegate {
            var d = new FolderBrowserDialog();
            if (d.ShowDialog() == DialogResult.OK) {
                _expDir.Text = d.SelectedPath;
                _ipc.SetSetting("export_dir", d.SelectedPath);
            }
        }, true);

        Txt(c, "Format", 60);
        _expFmt = Combo(c, new[] { "jpg", "png", "webp" }, S("exportFormat", "jpg"), 80, false,
            delegate { _ipc.SetSetting("export_format", (string)_expFmt.SelectedItem); });
        Txt(c, "Scale %", 60);
        _expScale = Box(c, S("exportScale", "100"), 60, true,
            delegate { _ipc.SetSetting("export_scale", _expScale.Text); });
        Txt(c, "Resampler", 80);
        _expScaler = Combo(c, new[] { "lanczos", "spline", "bicubic", "neighbor" }, S("exportScaler", "lanczos"), 130, true,
            delegate { _ipc.SetSetting("export_scaler", (string)_expScaler.SelectedItem); });
        Txt(c, "Above 100% upscales on export through the chosen resampler.", W3, true, true);
    }

    private void BuildShortcutsCard() {
        var c = Card("Keyboard Shortcuts");
        string[,] keys = {
            { "Left / Right", "Previous / next file" },
            { "Shift+Left / Right", "Step one frame" },
            { "s", "Slow-mo conform" },
            { "e", "Export frame / image" },
            { "i", "Media info" },
            { "u", "Toggle RTX upscaling" },
            { "z / x", "Zoom fit / 1:1" },
            { "r / Shift+R", "Rotate right / left" },
            { "w", "Refit window to media" },
            { "Ctrl+H", "Toggle HDR" },
            { "9 / 0, m, a", "Volume, mute, track" },
            { "Space", "Play / pause" },
            { "b", "Browse videos only / all media" },
            { "c", "Adjust the crop on the picture" },
            { "Wheel", "Shuttle (video) / zoom (photo)" },
            { "Ctrl+Wheel, drag", "Zoom / pan" }
        };
        for (int i = 0; i < keys.GetLength(0); i++) {
            Txt(c, keys[i, 0], 150);
            Txt(c, keys[i, 1], 274, true, true);
        }
    }

    // ---------------- behaviour ----------------

    private void ToggleFullscreen() {
        if (!_isFullscreen) {
            _preFsState = WindowState;
            _preFsBorder = FormBorderStyle;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Normal;
            Bounds = Screen.FromControl(this).Bounds;
            _isFullscreen = true;
        } else {
            FormBorderStyle = _preFsBorder;
            WindowState = _preFsState;
            _isFullscreen = false;
        }
        SyncVideoChild();
    }

    private void OpenMedia() {
        var d = new OpenFileDialog();
        d.Filter =
            "All media|*.mp4;*.mov;*.m4v;*.mkv;*.avi;*.webm;*.wmv;*.flv;*.mpg;*.mpeg;*.m2ts;*.mts;*.ts;*.gif;" +
            "*.jpg;*.jpeg;*.png;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.avif;*.jxl;*.exr;*.hdr;*.dng;*.cr2;*.nef;*.arw;" +
            "*.mp3;*.wav;*.flac;*.aac;*.m4a;*.ogg;*.opus;*.wma;*.aiff;*.ape;*.mka" +
            "|Video|*.mp4;*.mov;*.m4v;*.mkv;*.avi;*.webm;*.wmv;*.flv;*.mpg;*.mpeg;*.m2ts;*.mts;*.ts;*.gif" +
            "|Photos|*.jpg;*.jpeg;*.png;*.bmp;*.webp;*.tif;*.tiff;*.heic;*.avif;*.jxl;*.exr;*.hdr;*.dng;*.cr2;*.nef;*.arw" +
            "|Audio|*.mp3;*.wav;*.flac;*.aac;*.m4a;*.ogg;*.opus;*.wma;*.aiff;*.ape;*.mka" +
            "|All files (*.*)|*.*";
        if (d.ShowDialog() == DialogResult.OK) Cmd("loadfile", d.FileName, "replace");
    }

    private void OpenExports() {
        string dir = _expDir != null && _expDir.Text.Length > 0 ? _expDir.Text : Path.Combine(_root, "Exports");
        Directory.CreateDirectory(dir);
        System.Diagnostics.Process.Start("explorer.exe", dir);
    }

    // The player sizes the ratio window against the decoded frame and hands
    // the numbers back through user-data, so the boxes fill themselves in.
    private void ApplyAspectCrop(string ratio) {
        string[] parts = ratio.Split(':');
        Cmd("script-message", "mi-crop-aspect", parts[0], parts[1], ratio);
        Log("Crop " + ratio);
    }

    // Mirror the player's crop rectangle into the boxes - including while it
    // is being dragged on the picture - but never while one is being typed in.
    private void SyncCropBoxes() {
        if (_cropW == null) return;
        if (_cropW.Focused || _cropH.Focused || _cropX.Focused || _cropY.Focused) return;
        string v = _ipc.GetString("user-data/mi/crop") ?? "";
        if (v == _cropShown) return;
        _cropShown = v;
        string[] p = v.Split(':');
        if (p.Length == 4) {
            _cropW.Text = p[0]; _cropH.Text = p[1]; _cropX.Text = p[2]; _cropY.Text = p[3];
        } else {
            _cropW.Text = ""; _cropH.Text = ""; _cropX.Text = "0"; _cropY.Text = "0";
        }
    }

    private void ExportTrim() {
        string src = _ipc.GetString("path");
        if (string.IsNullOrEmpty(src)) { Log("Nothing loaded to trim"); return; }
        string outDir = _expDir.Text.Length > 0 ? _expDir.Text : Path.Combine(_root, "Exports");
        Directory.CreateDirectory(outDir);
        string outFile = Path.Combine(outDir,
            Path.GetFileNameWithoutExtension(src) + "_trim_" + DateTime.Now.ToString("HHmmss") + ".mp4");

        string mpv = MpvPlayer.FindMpv();
        if (mpv == null) { Log("mpv.exe not found"); return; }

        var a = new StringBuilder();
        a.Append("--start=").Append(_trimIn.Text).Append(' ');
        if (_trimOut.Text.Length > 0) a.Append("--end=").Append(_trimOut.Text).Append(' ');
        var vf = new List<string>();
        if (_cropW.Text.Length > 0 && _cropH.Text.Length > 0)
            vf.Add("crop=" + _cropW.Text + ":" + _cropH.Text + ":" + _cropX.Text + ":" + _cropY.Text);
        int sc;
        if (int.TryParse(_expScale.Text, out sc) && sc != 100 && sc > 0) {
            string f = (sc / 100.0).ToString("0.####", CultureInfo.InvariantCulture);
            vf.Add("scale=w=iw*" + f + ":h=ih*" + f + ":flags=" + _expScaler.SelectedItem + "+accurate_rnd");
        }
        if (vf.Count > 0) a.Append("--vf=").Append(string.Join(",", vf.ToArray())).Append(' ');
        a.Append("--ovc=libx264 --oac=aac --no-config ");
        a.Append("-o=\"").Append(outFile).Append("\" \"").Append(src).Append('"');

        var si = new System.Diagnostics.ProcessStartInfo(mpv, a.ToString());
        si.UseShellExecute = false; si.CreateNoWindow = true;
        System.Diagnostics.Process.Start(si);
        Log("Encoding clip -> " + Path.GetFileName(outFile));
    }

    private void ApplyRendererApi() {
        bool vulkan = (string)_apiSel.SelectedItem == "Vulkan";
        string conf = vulkan ? "gpu-api=vulkan\r\ngpu-context=winvk\r\n" : "gpu-api=d3d11\r\ngpu-context=d3d11\r\n";
        try { File.WriteAllText(Path.Combine(_configDir, "render.conf"), conf, new UTF8Encoding(false)); }
        catch (Exception ex) { Log("Could not write render.conf: " + ex.Message); return; }

        // gpu-api cannot change on a running player, so the player is
        // restarted in place - the window and every control stay put.
        string current = _ipc.GetString("path");
        Log("Renderer -> " + _apiSel.SelectedItem + ", restarting player");
        _player.Quit(_ipc);
        _ipc.Disconnect();
        _pushedSettings = false;
        System.Threading.Thread.Sleep(600);
        _player.Start(_videoHost.Handle, _configDir, current);
    }

    // ---------------- shaders / upscale ----------------

    private static string GpuName() {
        try {
            using (var s = new System.Management.ManagementObjectSearcher("SELECT Name FROM Win32_VideoController")) {
                foreach (System.Management.ManagementObject o in s.Get()) {
                    object n = o["Name"];
                    if (n != null) return n.ToString();
                }
            }
        } catch { }
        return "unknown GPU";
    }

    private void LoadShaders(string[] preCheck) {
        _shaderList.ItemCheck -= OnShaderCheck;
        _shaderList.Items.Clear();
        _shaderPaths.Clear();
        var pre = new List<string>(preCheck);
        try {
            if (Directory.Exists(_shaderDir)) {
                string[] files = Directory.GetFiles(_shaderDir, "*.glsl");
                Array.Sort(files);
                foreach (string f in files) {
                    string name = Path.GetFileName(f);
                    _shaderPaths[name] = f;
                    _shaderList.Items.Add(name, pre.Contains(f));
                }
            }
        } catch { }
        _shaderList.ItemCheck += OnShaderCheck;
        if (_shaderList.Items.Count == 0) Log("No .glsl shaders in " + _shaderDir);
    }

    private string CheckedShaders() {
        var list = new List<string>();
        foreach (object o in _shaderList.CheckedItems) {
            string p;
            if (_shaderPaths.TryGetValue(o.ToString(), out p)) list.Add(p);
        }
        return string.Join(",", list.ToArray());
    }

    // ItemCheck runs BEFORE the item flips, so the new state has to come from
    // the event args or the applied set is always one click behind.
    private void OnShaderCheck(object sender, ItemCheckEventArgs e) {
        var list = new List<string>();
        for (int i = 0; i < _shaderList.Items.Count; i++) {
            bool on = (i == e.Index) ? (e.NewValue == CheckState.Checked) : _shaderList.GetItemChecked(i);
            if (!on) continue;
            string p;
            if (_shaderPaths.TryGetValue(_shaderList.Items[i].ToString(), out p)) list.Add(p);
        }
        _ipc.SetSetting("shaders", string.Join(",", list.ToArray()));
        _ipc.ScriptBinding("apply_upscale");
        Log("Shaders: " + (list.Count == 0 ? "none" : string.Join(", ", list.ConvertAll(Path.GetFileName).ToArray())));
    }

    private void PushUpscale() {
        if (!_ipc.Connected) return;
        string mode = (string)_upMode.SelectedItem == "RTX Video Super Resolution" ? "rtx" : "off";
        _ipc.SetSetting("upscale", mode);
        _ipc.SetSetting("upscale_factor", (string)_upFactor.SelectedItem);
        _ipc.SetSetting("rtx_hdr", _rtxHdr.Checked ? "yes" : "no");
        _ipc.SetSetting("shaders", CheckedShaders());
        _ipc.ScriptBinding("apply_upscale");
    }

    private void PushAllSettings() {
        _ipc.SetSetting("export_dir", _expDir.Text);
        _ipc.SetSetting("export_format", (string)_expFmt.SelectedItem);
        _ipc.SetSetting("export_scale", _expScale.Text);
        _ipc.SetSetting("export_scaler", (string)_expScaler.SelectedItem);
        _ipc.SetSetting("fit_window", "no");   // the host owns window sizing
        _ipc.SetUserData("embedded", "yes");
        Cmd("set_property", "scale", _scaleSel.SelectedItem);
        Cmd("set_property", "cscale", _scaleSel.SelectedItem);
        Cmd("set_property", "dscale", _dscaleSel.SelectedItem);
        PushUpscale();
    }

    // ---------------- look ----------------

    private void RequestLook() { if (_look != null) { _look.Stop(); _look.Start(); } }

    private int A(string k) { int v; return _adj.TryGetValue(k, out v) ? v : 0; }

    private void ApplyLook() {
        if (!_ipc.Connected) return;
        Cmd("set_property", "brightness", A("brightness"));
        Cmd("set_property", "contrast", A("contrast"));
        Cmd("set_property", "saturation", A("saturation"));
        Cmd("set_property", "gamma", A("gamma"));
        Cmd("set_property", "hue", A("hue"));

        var f = new List<string>();
        if (A("temp") != 0) f.Add("colortemperature=temperature=" + (6500 - A("temp") * 30));
        if (A("tint") != 0) f.Add("colorbalance=gm=" + (A("tint") / 200.0).ToString("0.###", CultureInfo.InvariantCulture));
        if (A("vibrance") != 0) f.Add("vibrance=intensity=" + (A("vibrance") / 100.0).ToString("0.###", CultureInfo.InvariantCulture));
        if (A("shadows") != 0 || A("highlights") != 0) {
            double s = Math.Max(0.02, Math.Min(0.25 + A("shadows") / 500.0, 0.48));
            double h = Math.Max(0.52, Math.Min(0.75 + A("highlights") / 500.0, 0.98));
            f.Add("curves=all='0/0 0.25/" + s.ToString("0.###", CultureInfo.InvariantCulture) +
                  " 0.75/" + h.ToString("0.###", CultureInfo.InvariantCulture) + " 1/1'");
        }
        if (A("sharpness") > 0) f.Add("unsharp=5:5:" + (A("sharpness") / 50.0).ToString("0.###", CultureInfo.InvariantCulture) + ":5:5:0");
        else if (A("sharpness") < 0) f.Add("gblur=sigma=" + (Math.Abs(A("sharpness")) / 50.0).ToString("0.###", CultureInfo.InvariantCulture));
        if (A("vignette") > 0) f.Add("vignette=angle=" + ((Math.PI / 5) * (A("vignette") / 100.0)).ToString("0.####", CultureInfo.InvariantCulture));

        Cmd("vf", "remove", "@milook");
        if (f.Count > 0) {
            // The whole graph must sit inside lavfi=[...]; passing the filters
            // bare lets mpv's own vf parser eat the ':' separators and quoted
            // args, and one rejected stage silently kills every adjustment.
            string r = _ipc.Command("vf", "add", "@milook:lavfi=[" + string.Join(",", f.ToArray()) + "]");
            if (r != null && r.IndexOf("\"error\":\"success\"", StringComparison.Ordinal) < 0)
                Log("Filter rejected: " + string.Join(",", f.ToArray()));
        }
    }

    // The player owns the browse scope: it persists it with the rest of the
    // session state, and its own bar button and the b key change it too, so
    // this toggle follows the player rather than the other way round.
    private void SyncBrowseScope() {
        if (_videoOnly == null) return;
        string v = _ipc.GetString("user-data/mi/set_browse_all");
        if (string.IsNullOrEmpty(v)) return;
        bool videoOnly = v != "yes";
        if (_videoOnly.Checked == videoOnly) return;
        _syncingScope = true;
        try { _videoOnly.Checked = videoOnly; } finally { _syncingScope = false; }
    }

    private void ApplyKindEnablement(string kind) {
        foreach (Win11Button b in _timeBtns)  SetEnabled(b, kind != "photo");
        foreach (Win11Button b in _imageBtns) SetEnabled(b, kind != "audio");
        foreach (Win11Button b in _soundBtns) SetEnabled(b, kind != "photo");
    }

    private static void SetEnabled(Win11Button b, bool on) {
        b.Enabled = on;
        b.ForeColor = on ? Color.White : Color.FromArgb(110, 110, 118);
    }

    // ---------------- state ----------------
    // Flat key=value rather than JSON: nothing else reads this file, and a
    // hand-rolled JSON parser here would be all risk and no benefit.

    private void LoadState() {
        try {
            string p = Path.ChangeExtension(_statePath, ".ini");
            if (!File.Exists(p)) return;
            foreach (string line in File.ReadAllLines(p)) {
                int i = line.IndexOf('=');
                if (i <= 0) continue;
                _state[line.Substring(0, i)] = line.Substring(i + 1);
            }
            int x, y, w, h;
            if (int.TryParse(S("winX", ""), out x) && int.TryParse(S("winY", ""), out y) &&
                int.TryParse(S("winW", ""), out w) && int.TryParse(S("winH", ""), out h) &&
                w > 400 && h > 300) {
                var r = new Rectangle(x, y, w, h);
                foreach (Screen sc in Screen.AllScreens) {
                    if (sc.WorkingArea.IntersectsWith(r)) {
                        StartPosition = FormStartPosition.Manual;
                        Location = new Point(x, y);
                        Size = new Size(w, h);
                        break;
                    }
                }
            }
        } catch { }
    }

    private void SaveState() {
        try {
            Rectangle b = (WindowState == FormWindowState.Normal) ? Bounds : RestoreBounds;
            var sb = new StringBuilder();
            sb.AppendLine("winX=" + b.X);
            sb.AppendLine("winY=" + b.Y);
            sb.AppendLine("winW=" + b.Width);
            sb.AppendLine("winH=" + b.Height);
            if (_expDir != null) sb.AppendLine("exportDir=" + _expDir.Text);
            if (_expFmt != null) sb.AppendLine("exportFormat=" + _expFmt.SelectedItem);
            if (_expScale != null) sb.AppendLine("exportScale=" + _expScale.Text);
            if (_expScaler != null) sb.AppendLine("exportScaler=" + _expScaler.SelectedItem);
            if (_upMode != null) sb.AppendLine("upscaleMode=" + _upMode.SelectedItem);
            if (_upFactor != null) sb.AppendLine("upscaleFactor=" + _upFactor.SelectedItem);
            if (_rtxHdr != null) sb.AppendLine("rtxHdr=" + (_rtxHdr.Checked ? "yes" : "no"));
            if (_scaleSel != null) sb.AppendLine("scaler=" + _scaleSel.SelectedItem);
            if (_dscaleSel != null) sb.AppendLine("dscaler=" + _dscaleSel.SelectedItem);
            if (_apiSel != null) sb.AppendLine("renderApi=" + _apiSel.SelectedItem);
            sb.AppendLine("fitWindow=" + (_fitWindow ? "yes" : "no"));
            if (_shaderList != null) sb.AppendLine("shaders=" + CheckedShaders());
            File.WriteAllText(Path.ChangeExtension(_statePath, ".ini"), sb.ToString(), new UTF8Encoding(false));
        } catch { }
    }
}
}


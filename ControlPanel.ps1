# ============================================================
# SlowmoPlayer Control Panel
# A separate window (put it on a second monitor) with a button for
# every action. Talks to the player over mpv's JSON IPC socket, and
# mirrors its fps-tier accent colour. Remembers its own position.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PanelStateFile = Join-Path $Root "state_panel.json"
$PipeName = "slowmoplayer"

$TierPalette = @{
    yellow = [System.Drawing.Color]::FromArgb(255, 208, 0)
    blue   = [System.Drawing.Color]::FromArgb(56, 152, 255)
    green  = [System.Drawing.Color]::FromArgb(64, 208, 120)
}
$ColBg     = [System.Drawing.Color]::FromArgb(24, 24, 26)
$ColBtn    = [System.Drawing.Color]::FromArgb(48, 48, 52)
$ColHover  = [System.Drawing.Color]::FromArgb(68, 68, 74)
$ColBorder = [System.Drawing.Color]::FromArgb(72, 72, 78)

$script:client = $null; $script:writer = $null; $script:reader = $null
$script:connected = $false; $script:reqId = 1
$script:tierNow = "yellow"; $script:lastSeq = 0; $script:scaleNow = 0

$script:settingsPushed = $false

function Disconnect-Mpv {
    try { if ($script:client) { $script:client.Dispose() } } catch {}
    $script:client = $null; $script:connected = $false
    $script:settingsPushed = $false  # re-push after a reconnect
}

function Connect-Mpv {
    try {
        $c = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
        $c.Connect(200)
        $script:client = $c
        $script:writer = New-Object System.IO.StreamWriter($c); $script:writer.AutoFlush = $true
        $script:reader = New-Object System.IO.StreamReader($c)
        $script:connected = $true
        # mpv pushes async events down the same pipe as command replies.
        # Turning them off leaves a clean request/response stream (the
        # request_id match below is still the real guarantee).
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

        # Read until the reply carrying OUR request_id arrives, discarding
        # anything else. Without this, an interleaved event line gets
        # returned as the answer and every subsequent read is off by one -
        # which silently pairs each property with the wrong value.
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

function Format-Time {
    param($Seconds)
    if ($null -eq $Seconds) { return "0:00" }
    $d = 0.0
    if (-not [double]::TryParse([string]$Seconds, [ref]$d)) { return "0:00" }
    $ts = [TimeSpan]::FromSeconds($d)
    if ($ts.TotalHours -ge 1) { return ('{0}:{1:00}:{2:00}' -f [int]$ts.TotalHours, $ts.Minutes, $ts.Seconds) }
    return ('{0}:{1:00}' -f $ts.Minutes, $ts.Seconds)
}

# ---------- Window ----------
$form = New-Object System.Windows.Forms.Form
$form.Text = "SlowmoPlayer Controls"
$form.BackColor = $ColBg
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.MinimumSize = New-Object System.Drawing.Size(1020, 600)
$form.Size = New-Object System.Drawing.Size(1060, 940)
$form.StartPosition = "Manual"

# Restore saved position, clamped to a currently-visible screen so the
# window can't come back off-screen if the monitor layout changed.
$placed = $false
if (Test-Path $PanelStateFile) {
    try {
        $p = [IO.File]::ReadAllText($PanelStateFile).TrimStart([char]0xFEFF) | ConvertFrom-Json
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

# Dock layout: header top, log bottom, buttons fill the rest - so the
# button area tracks the window size instead of leaving a dead gap.
$header = New-Object System.Windows.Forms.Panel
$header.Dock = "Top"; $header.Height = 58; $header.BackColor = $ColBg
$form.Controls.Add($header)

$accent = New-Object System.Windows.Forms.Panel
$accent.Dock = "Top"; $accent.Height = 3; $accent.BackColor = $TierPalette["yellow"]
$header.Controls.Add($accent)

$status = New-Object System.Windows.Forms.Label
$status.Dock = "Fill"; $status.AutoSize = $false
$status.Padding = New-Object System.Windows.Forms.Padding(14, 9, 12, 0)
$status.ForeColor = [System.Drawing.Color]::Orange
$status.Font = New-Object System.Drawing.Font("Consolas", 10)
$status.Text = "Connecting..."
$header.Controls.Add($status)

$logPanel = New-Object System.Windows.Forms.Panel
$logPanel.Dock = "Bottom"; $logPanel.Height = 170
$logPanel.Padding = New-Object System.Windows.Forms.Padding(12, 4, 12, 12)
$logPanel.BackColor = $ColBg
$form.Controls.Add($logPanel)

$logLabel = New-Object System.Windows.Forms.Label
$logLabel.Dock = "Top"; $logLabel.Height = 20; $logLabel.AutoSize = $false
$logLabel.Text = "Activity"
$logLabel.ForeColor = $TierPalette["yellow"]
$logLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
$logPanel.Controls.Add($logLabel)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = "Vertical"
$logBox.Dock = "Fill"
$logBox.BackColor = [System.Drawing.Color]::FromArgb(14, 14, 16)
$logBox.ForeColor = [System.Drawing.Color]::Gainsboro
$logBox.BorderStyle = "FixedSingle"
$logBox.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$logPanel.Controls.Add($logBox)

# Right column: shortcuts + settings, filling the space the button grid
# doesn't use. Docked Right so it keeps a fixed width while the button
# grid reflows into whatever is left.
$side = New-Object System.Windows.Forms.Panel
$side.Dock = "Right"
$side.Width = 450
$side.Padding = New-Object System.Windows.Forms.Padding(10, 6, 12, 6)
$side.BackColor = $ColBg
$side.AutoScroll = $true
$form.Controls.Add($side)

$sideFlow = New-Object System.Windows.Forms.FlowLayoutPanel
$sideFlow.Dock = "Fill"
$sideFlow.FlowDirection = "LeftToRight"
$sideFlow.WrapContents = $true
$sideFlow.AutoScroll = $true
$sideFlow.BackColor = $ColBg
$side.Controls.Add($sideFlow)

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = "Fill"
$panel.Padding = New-Object System.Windows.Forms.Padding(12, 6, 12, 6)
$panel.FlowDirection = "LeftToRight"
$panel.WrapContents = $true
$panel.AutoScroll = $true
$panel.BackColor = $ColBg
$form.Controls.Add($panel)

$script:sectionLabels = @()

function Add-Section {
    param([string]$Title)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Title.ToUpper()
    $l.AutoSize = $false
    $l.Size = New-Object System.Drawing.Size(500, 22)
    $l.Margin = New-Object System.Windows.Forms.Padding(2, 10, 2, 2)
    $l.TextAlign = "BottomLeft"
    $l.ForeColor = $TierPalette["yellow"]
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
    $panel.Controls.Add($l)
    # Force the row to break after a heading, otherwise headings sit inline
    # between buttons and the whole grid reads as a ragged mess.
    $panel.SetFlowBreak($l, $true)
    $script:sectionLabels += $l
}

function Add-Btn {
    param([string]$Label, [object[]]$Command, [int]$Width = 112,
          [scriptblock]$OnClick = $null, [switch]$Danger, [switch]$Break)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Label
    $b.Size = New-Object System.Drawing.Size($Width, 34)
    $b.Margin = New-Object System.Windows.Forms.Padding(2, 2, 2, 3)
    $b.BackColor = if ($Danger) { [System.Drawing.Color]::FromArgb(112, 40, 44) } else { $ColBtn }
    $b.ForeColor = [System.Drawing.Color]::White
    $b.FlatStyle = "Flat"
    $b.FlatAppearance.BorderColor = $ColBorder
    $b.FlatAppearance.MouseOverBackColor = if ($Danger) { [System.Drawing.Color]::FromArgb(148, 52, 56) } else { $ColHover }
    $b.FlatAppearance.MouseDownBackColor = [System.Drawing.Color]::FromArgb(96, 96, 104)
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    if ($OnClick) { $b.Add_Click($OnClick) }
    else { $cmd = $Command; $b.Add_Click({ Send-Mpv -Command $cmd | Out-Null }.GetNewClosure()) }
    $panel.Controls.Add($b)
    if ($Break) { $panel.SetFlowBreak($b, $true) }
}

# Uniform grid: one column width, three per row, so every section lines up
# instead of each row being a different ragged set of button widths.
$W1 = 164   # one cell
$W2 = 332   # two cells (spans a pair)
$W3 = 500   # full row

Add-Section "File"
Add-Btn "Open File..." $null $W3 -Break -OnClick {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Filter = "Video (*.mp4;*.mov;*.m4v;*.mkv)|*.mp4;*.mov;*.m4v;*.mkv|All files (*.*)|*.*"
    if ($d.ShowDialog() -eq "OK") { Send-Mpv -Command @("loadfile", $d.FileName, "replace") | Out-Null }
}
Add-Btn "<< Prev Video" @("script-binding", "prev_video") $W1
Add-Btn "Next Video >>" @("script-binding", "next_video") $W1
Add-Btn "Open Exports" $null $W1 -Break -OnClick {
    $e = if ($expDir.Text) { $expDir.Text } else { Join-Path $Root "Exports" }
    if (-not (Test-Path $e)) { New-Item -ItemType Directory -Force -Path $e | Out-Null }
    Start-Process explorer.exe $e
}

Add-Section "Playback"
Add-Btn "Play / Pause" @("cycle", "pause") $W3 -Break
Add-Btn "-10s" @("seek", -10, "exact") $W1
Add-Btn "-1s" @("seek", -1, "exact") $W1
Add-Btn "< Frame" @("frame-back-step") $W1 -Break
Add-Btn "+10s" @("seek", 10, "exact") $W1
Add-Btn "+1s" @("seek", 1, "exact") $W1
Add-Btn "Frame >" @("frame-step") $W1 -Break

Add-Section "Slow-mo / Export"
Add-Btn "Slow-mo Toggle" @("script-binding", "slowmo_toggle") $W2
Add-Btn "Export Frame" @("script-binding", "export_frame") $W1 -Break

Add-Section "Speed"
Add-Btn "0.25x" @("set_property", "speed", 0.25) $W1
Add-Btn "0.5x" @("set_property", "speed", 0.5) $W1
Add-Btn "1x" @("set_property", "speed", 1) $W1 -Break
Add-Btn "2x" @("set_property", "speed", 2) $W1
Add-Btn "Slower" @("multiply", "speed", 0.9090909) $W1
Add-Btn "Faster" @("multiply", "speed", 1.1) $W1 -Break

Add-Section "Sound"
Add-Btn "Mute" @("cycle", "mute") $W1
Add-Btn "Vol -" @("add", "volume", -5) $W1
Add-Btn "Vol +" @("add", "volume", 5) $W1 -Break
Add-Btn "Sound Settings" @("script-binding", "audio_menu") $W1
Add-Btn "Cycle Track" @("cycle", "audio") $W1 -Break

Add-Section "Zoom"
Add-Btn "Zoom In" @("add", "video-zoom", 0.1) $W1
Add-Btn "Zoom Out" @("add", "video-zoom", -0.1) $W1
Add-Btn "Reset Zoom" @("set_property", "video-zoom", 0) $W1 -Break

Add-Section "View"
Add-Btn "Fullscreen" @("cycle", "fullscreen") $W1
Add-Btn "On Top" @("cycle", "ontop") $W1
Add-Btn "Shortcuts" @("script-binding", "toggle_help") $W1 -Break
Add-Btn "UI Scale -" @("script-binding", "ui_scale_down") $W1
Add-Btn "UI Scale +" @("script-binding", "ui_scale_up") $W1
Add-Btn "UI Scale Reset" @("script-binding", "ui_scale_reset") $W1 -Break

Add-Section "Tools"
Add-Btn "Loop" @("cycle-values", "loop-file", "inf", "no") $W1
Add-Btn "A-B Loop" @("ab-loop") $W1
Add-Btn "HW Decode" @("cycle-values", "hwdec", "no", "auto") $W1 -Break

Add-Section "Quit"
Add-Btn "Quit Player" @("quit") $W3 -Break -Danger

# ============================================================
# Right column - shortcuts and settings
# ============================================================

function Add-SideHeading {
    param([string]$Text)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text.ToUpper()
    $l.AutoSize = $false
    $l.Size = New-Object System.Drawing.Size(400, 22)
    $l.Margin = New-Object System.Windows.Forms.Padding(2, 10, 2, 2)
    $l.TextAlign = "BottomLeft"
    $l.ForeColor = $TierPalette["yellow"]
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
    $sideFlow.Controls.Add($l); $sideFlow.SetFlowBreak($l, $true)
    $script:sectionLabels += $l
}

function Add-SideText {
    param([string]$Text, [int]$Width = 400, [switch]$Break, [switch]$Dim)
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text
    $l.AutoSize = $false
    $l.Size = New-Object System.Drawing.Size($Width, 19)
    $l.Margin = New-Object System.Windows.Forms.Padding(2, 1, 2, 1)
    $l.TextAlign = "MiddleLeft"
    $l.ForeColor = if ($Dim) { [System.Drawing.Color]::Gray } else { [System.Drawing.Color]::Gainsboro }
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $sideFlow.Controls.Add($l)
    if ($Break) { $sideFlow.SetFlowBreak($l, $true) }
    return $l
}

function Add-SideBtn {
    param([string]$Label, [int]$Width = 128, [scriptblock]$OnClick, [switch]$Break)
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Label
    $b.Size = New-Object System.Drawing.Size($Width, 28)
    $b.Margin = New-Object System.Windows.Forms.Padding(2, 2, 2, 3)
    $b.BackColor = $ColBtn; $b.ForeColor = [System.Drawing.Color]::White
    $b.FlatStyle = "Flat"; $b.FlatAppearance.BorderColor = $ColBorder
    $b.FlatAppearance.MouseOverBackColor = $ColHover
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $b.Add_Click($OnClick)
    $sideFlow.Controls.Add($b)
    if ($Break) { $sideFlow.SetFlowBreak($b, $true) }
    return $b
}

function Add-SideBox {
    param([string]$Value, [int]$Width = 150, [switch]$Break)
    $t = New-Object System.Windows.Forms.TextBox
    $t.Text = $Value
    $t.Width = $Width
    $t.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 3)
    $t.BackColor = [System.Drawing.Color]::FromArgb(14, 14, 16)
    $t.ForeColor = [System.Drawing.Color]::Gainsboro
    $t.BorderStyle = "FixedSingle"
    $t.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $sideFlow.Controls.Add($t)
    if ($Break) { $sideFlow.SetFlowBreak($t, $true) }
    return $t
}

# ---- Shortcuts (moved off the video and into this window) ----
Add-SideHeading "Shortcuts"
$shortcuts = @(
    @("Left / Right", "Seek 1 second"),
    @("Shift+Left / Right", "Step one frame"),
    @("s", "Slow-mo conform"),
    @("e / right-click", "Export frame"),
    @("< > or PgUp/PgDn", "Prev / next video"),
    @("Ctrl+A", "Sound settings"),
    @("9 / 0, m, a", "Volume, mute, track"),
    @("[ / ], Backspace", "Speed, reset speed"),
    @("Space, f", "Play/pause, fullscreen"),
    @("Ctrl+= / - / 0", "UI scale up/down/reset"),
    @("Ctrl+P", "Toggle this panel"),
    @("Wheel / side-scroll", "Zoom / scrub")
)
foreach ($s in $shortcuts) {
    Add-SideText $s[0] 150 | Out-Null
    Add-SideText $s[1] 240 -Dim -Break | Out-Null
}

# ---- Slow-mo target ----
Add-SideHeading "Slow-mo target fps"
$slowLabel = Add-SideText "24 fps" 90
$slowSlider = New-Object System.Windows.Forms.TrackBar
$slowSlider.Minimum = 4; $slowSlider.Maximum = 60; $slowSlider.Value = 24
$slowSlider.TickFrequency = 4; $slowSlider.Width = 300
$slowSlider.Margin = New-Object System.Windows.Forms.Padding(2, 0, 2, 2)
$slowSlider.BackColor = $ColBg
$slowSlider.Add_ValueChanged({
    $slowLabel.Text = "$($slowSlider.Value) fps"
    Send-Mpv -Command @("set_property", "user-data/slowmo/set_target_fps", "$($slowSlider.Value)") | Out-Null
})
$sideFlow.Controls.Add($slowSlider); $sideFlow.SetFlowBreak($slowSlider, $true)
Add-SideText "Lower target = slower playback. Applies next time Slow-mo is toggled on." 400 -Dim -Break | Out-Null

# ---- Export settings ----
Add-SideHeading "Export"
Add-SideText "Folder" 60 | Out-Null
$expDir = Add-SideBox (Join-Path $Root "Exports") 250
Add-SideBtn "Browse" 70 -Break -OnClick {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($d.ShowDialog() -eq "OK") {
        $expDir.Text = $d.SelectedPath
        Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_dir", $d.SelectedPath) | Out-Null
    }
} | Out-Null
$expDir.Add_TextChanged({
    Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_dir", $expDir.Text) | Out-Null
})

Add-SideText "Format" 60 | Out-Null
$expFmt = New-Object System.Windows.Forms.ComboBox
$expFmt.Items.AddRange(@("png", "jpg", "webp")) | Out-Null
$expFmt.SelectedIndex = 0
$expFmt.DropDownStyle = "DropDownList"; $expFmt.Width = 90
$expFmt.Margin = New-Object System.Windows.Forms.Padding(2, 3, 2, 3)
$expFmt.BackColor = [System.Drawing.Color]::FromArgb(14, 14, 16)
$expFmt.ForeColor = [System.Drawing.Color]::Gainsboro
$expFmt.Add_SelectedIndexChanged({
    Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_format", $expFmt.SelectedItem) | Out-Null
})
$sideFlow.Controls.Add($expFmt)

Add-SideText "Scale %" 60 | Out-Null
$expScale = Add-SideBox "100" 60 -Break
$expScale.Add_TextChanged({
    Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_scale", $expScale.Text) | Out-Null
})
Add-SideText "100% = native source resolution (lossless for png)." 400 -Dim -Break | Out-Null

# ---- Crop ----
Add-SideHeading "Crop (w:h:x:y)"
$cropW = Add-SideBox "" 74
$cropH = Add-SideBox "" 74
$cropX = Add-SideBox "0" 60
$cropY = Add-SideBox "0" 60
Add-SideBtn "Apply" 68 -Break -OnClick {
    if ($cropW.Text -and $cropH.Text) {
        $f = "crop=$($cropW.Text):$($cropH.Text):$($cropX.Text):$($cropY.Text)"
        Send-Mpv -Command @("vf", "set", "@slowmocrop:$f") | Out-Null
    }
} | Out-Null
Add-SideBtn "Clear Crop" 100 -OnClick {
    Send-Mpv -Command @("vf", "remove", "@slowmocrop") | Out-Null
} | Out-Null
Add-SideBtn "Fill from video" 120 -Break -OnClick {
    $w = Get-MpvProp "width"; $h = Get-MpvProp "height"
    if ($w) { $cropW.Text = "$w"; $cropH.Text = "$h"; $cropX.Text = "0"; $cropY.Text = "0" }
} | Out-Null
Add-SideText "Crop affects playback and exported frames." 400 -Dim -Break | Out-Null

# ---- Trim ----
Add-SideHeading "Trim / clip export"
Add-SideText "In" 30 | Out-Null
$trimIn = Add-SideBox "0" 90
Add-SideText "Out" 34 | Out-Null
$trimOut = Add-SideBox "" 90 -Break
Add-SideBtn "Set In = now" 110 -OnClick {
    $p = Get-MpvProp "time-pos"; if ($null -ne $p) { $trimIn.Text = ("{0:N3}" -f [double]$p) }
} | Out-Null
Add-SideBtn "Set Out = now" 118 -Break -OnClick {
    $p = Get-MpvProp "time-pos"; if ($null -ne $p) { $trimOut.Text = ("{0:N3}" -f [double]$p) }
} | Out-Null

Add-SideBtn "Export trimmed clip" 200 -Break -OnClick {
    $src = Get-MpvProp "path"
    if (-not $src) { return }
    $outDir = if ($expDir.Text) { $expDir.Text } else { Join-Path $Root "Exports" }
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
    $base = [IO.Path]::GetFileNameWithoutExtension($src)
    $out = Join-Path $outDir ("{0}_trim_{1}.mp4" -f $base, (Get-Date -Format "HHmmss"))

    $mpv = "C:\Program Files\MPV Player\mpv.exe"
    if (-not (Test-Path $mpv)) { $mpv = (Get-Command mpv -ErrorAction SilentlyContinue).Source }
    if (-not $mpv) { return }

    # Re-encode with mpv's own CLI so crop/scale settings apply to the clip
    # exactly as they do on screen.
    $a = @("--start=$($trimIn.Text)")
    if ($trimOut.Text) { $a += "--end=$($trimOut.Text)" }
    $vf = @()
    if ($cropW.Text -and $cropH.Text) { $vf += "crop=$($cropW.Text):$($cropH.Text):$($cropX.Text):$($cropY.Text)" }
    $sc = 100; [void][int]::TryParse($expScale.Text, [ref]$sc)
    if ($sc -ne 100 -and $sc -gt 0) { $vf += "scale=iw*$($sc/100):ih*$($sc/100)" }
    if ($vf.Count) { $a += "--vf=" + ($vf -join ",") }
    $a += @("--ovc=libx264", "--oac=aac", "-o=$out", "--no-config", $src)

    Start-Process -FilePath $mpv -ArgumentList $a -WindowStyle Hidden
    $logBox.AppendText("$(Get-Date -Format 'HH:mm:ss')  Encoding clip -> $([IO.Path]::GetFileName($out))`r`n")
} | Out-Null
Add-SideText "Times in seconds. Blank Out = end of file." 400 -Dim -Break | Out-Null

# ============================================================
# Visual adjustments
#   Brightness/Contrast/Saturation/Gamma/Hue are native mpv properties -
#   applied on the GPU with no filter-chain rebuild, so they stay smooth
#   while dragging. The rest are libavfilter stages rebuilt as one labelled
#   chain (@slowmolook) that sits alongside the crop filter (@slowmocrop).
#   Because all of it runs on the decoded frame, exported frames and
#   trimmed clips inherit the look automatically.
# ============================================================

$script:adj = @{}
$script:adjCtl = @{}

function Add-Slider {
    param([string]$Key, [string]$Label, [int]$Min = -100, [int]$Max = 100, [int]$Default = 0)
    $script:adj[$Key] = $Default

    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Label; $l.AutoSize = $false
    $l.Size = New-Object System.Drawing.Size(96, 22)
    $l.TextAlign = "MiddleLeft"
    $l.Margin = New-Object System.Windows.Forms.Padding(2, 4, 2, 0)
    $l.ForeColor = [System.Drawing.Color]::Gainsboro
    $l.Font = New-Object System.Drawing.Font("Segoe UI", 8.5)
    $sideFlow.Controls.Add($l)

    $tb = New-Object System.Windows.Forms.TrackBar
    $tb.Minimum = $Min; $tb.Maximum = $Max; $tb.Value = $Default
    $tb.TickStyle = "None"; $tb.Width = 232; $tb.Height = 30
    $tb.Margin = New-Object System.Windows.Forms.Padding(0, 0, 2, 0)
    $tb.BackColor = $ColBg
    $sideFlow.Controls.Add($tb)

    $val = New-Object System.Windows.Forms.Label
    $val.Text = "$Default"; $val.AutoSize = $false
    $val.Size = New-Object System.Drawing.Size(44, 22)
    $val.TextAlign = "MiddleCenter"
    $val.Margin = New-Object System.Windows.Forms.Padding(2, 4, 2, 0)
    $val.ForeColor = [System.Drawing.Color]::Gray
    $val.Font = New-Object System.Drawing.Font("Consolas", 8.5)
    $sideFlow.Controls.Add($val); $sideFlow.SetFlowBreak($val, $true)

    $k = $Key
    $tb.Add_ValueChanged({
        $script:adj[$k] = $tb.Value
        $val.Text = "$($tb.Value)"
        Request-Look
    }.GetNewClosure())

    $script:adjCtl[$Key] = @{ Slider = $tb; Value = $val; Default = $Default }
}

# Coalesce rapid slider movement into one update, so dragging doesn't
# queue up dozens of filter-chain rebuilds over IPC.
$script:lookPending = $false
$lookTimer = New-Object System.Windows.Forms.Timer
$lookTimer.Interval = 90

function Request-Look {
    $script:lookPending = $true
    $lookTimer.Stop(); $lookTimer.Start()
}

function Apply-Look {
    if (-not $script:connected) { return }
    $a = $script:adj

    # --- Native mpv properties (no chain rebuild) ---
    Send-Mpv -Command @("set_property", "brightness", [int]$a["brightness"]) | Out-Null
    Send-Mpv -Command @("set_property", "contrast",   [int]$a["contrast"])   | Out-Null
    Send-Mpv -Command @("set_property", "saturation", [int]$a["saturation"]) | Out-Null
    Send-Mpv -Command @("set_property", "gamma",      [int]$a["gamma"])      | Out-Null
    Send-Mpv -Command @("set_property", "hue",        [int]$a["hue"])        | Out-Null

    # --- libavfilter stages ---
    $f = @()
    if ($a["temp"] -ne 0) {
        # -100..100 maps to a warm/cool swing around 6500K daylight
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
        # PI/5 (max darkening) down to ~0 as the slider approaches zero
        $ang = [math]::Round((3.14159 / 5) * ($a["vignette"] / 100.0), 4)
        $f += "vignette=angle=$ang"
    }

    Send-Mpv -Command @("vf", "remove", "@slowmolook") | Out-Null
    if ($f.Count -gt 0) {
        # The whole graph must go inside lavfi=[...]. Passing filters bare
        # lets mpv's own vf parser eat the ':' separators and quoted args -
        # 'curves' in particular is rejected outright, and because these are
        # one comma-joined chain, a single rejected filter silently killed
        # every adjustment. Verified against a live player.
        $r = Send-Mpv -Command @("vf", "add", "@slowmolook:lavfi=[" + ($f -join ",") + "]")
        if ($r -and $r -notmatch '"error"\s*:\s*"success"') {
            $logBox.AppendText("$(Get-Date -Format 'HH:mm:ss')  Filter rejected: $($f -join ',')`r`n")
        }
    }
}

$lookTimer.Add_Tick({
    $lookTimer.Stop()
    if ($script:lookPending) { $script:lookPending = $false; Apply-Look }
})

Add-SideHeading "White balance"
Add-Slider "temp" "Temperature"
Add-Slider "tint" "Tint"

Add-SideHeading "Light"
Add-Slider "brightness" "Brightness"
Add-Slider "contrast" "Contrast"
Add-Slider "highlights" "Highlights"
Add-Slider "shadows" "Shadows"
Add-Slider "gamma" "Gamma"

Add-SideHeading "Colour"
Add-Slider "vibrance" "Vibrance"
Add-Slider "saturation" "Saturation"
Add-Slider "hue" "Hue"

Add-SideHeading "Texture"
Add-Slider "sharpness" "Sharpness"
Add-Slider "vignette" "Vignette"

Add-SideBtn "Reset adjustments" 200 -Break -OnClick {
    foreach ($k in @($script:adjCtl.Keys)) {
        $c = $script:adjCtl[$k]
        $c.Slider.Value = $c.Default   # fires ValueChanged -> Request-Look
    }
    Request-Look
} | Out-Null
Add-SideText "Adjustments apply to playback, exported frames and trimmed clips." 400 -Dim -Break | Out-Null

function Set-Tier {
    param([string]$Name)
    $c = $TierPalette[$Name]; if (-not $c) { $c = $TierPalette["yellow"] }
    $accent.BackColor = $c
    $logLabel.ForeColor = $c
    foreach ($l in $script:sectionLabels) { $l.ForeColor = $c }
}

# Font-only scaling: button/label sizes stay put so the grid keeps its
# layout, while text tracks the player's UI scale. Scaling the control
# boxes too would reflow the whole panel on every nudge.
$script:baseFonts = @{}
foreach ($c in @($panel.Controls) + @($sideFlow.Controls)) { $script:baseFonts[$c] = $c.Font.Size }
$script:baseStatusFont = $status.Font.Size
$script:baseLogFont = $logBox.Font.Size

function Set-PanelScale {
    param([double]$Scale)
    # The player's scale is height-derived and starts near 2x on a 4K
    # screen; normalise so 1.0 here means "the panel's designed size".
    $f = [math]::Max(0.85, [math]::Min($Scale / 2.0, 1.9))
    foreach ($c in $script:baseFonts.Keys) {
        $sz = [math]::Max(7.0, [math]::Min($script:baseFonts[$c] * $f, 20.0))
        $style = $c.Font.Style
        try { $c.Font = New-Object System.Drawing.Font($c.Font.FontFamily, $sz, $style) } catch {}
    }
    try {
        $status.Font = New-Object System.Drawing.Font("Consolas",
            [math]::Max(8.0, [math]::Min($script:baseStatusFont * $f, 18.0)))
        $logBox.Font = New-Object System.Drawing.Font("Consolas",
            [math]::Max(7.5, [math]::Min($script:baseLogFont * $f, 16.0)))
    } catch {}
}

# ---------- Poll ----------
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if (-not $script:connected -and -not (Connect-Mpv)) {
        $status.Text = "Waiting for SlowmoPlayer..."
        $status.ForeColor = [System.Drawing.Color]::Orange
        return
    }
    $paused = Get-MpvProp "pause"
    if ($null -eq $paused) {
        $status.Text = "Waiting for SlowmoPlayer..."
        $status.ForeColor = [System.Drawing.Color]::Orange
        return
    }

    # Heartbeat: tells the player to route its messages to the log below.
    Send-Mpv -Command @("set_property", "user-data/slowmo/panel_open", $true) | Out-Null

    # Push settings once per connection - user-data lives in the player
    # process, so a player restart would otherwise silently drop them.
    if (-not $script:settingsPushed) {
        Send-Mpv -Command @("set_property", "user-data/slowmo/set_target_fps", "$($slowSlider.Value)") | Out-Null
        Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_dir", $expDir.Text) | Out-Null
        Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_format", $expFmt.SelectedItem) | Out-Null
        Send-Mpv -Command @("set_property", "user-data/slowmo/set_export_scale", $expScale.Text) | Out-Null
        $script:settingsPushed = $true
        Request-Look   # re-apply the current look to a freshly started player
    }

    $logJson = Get-MpvProp "user-data/slowmo/log"
    if ($logJson) {
        try {
            foreach ($e in @($logJson | ConvertFrom-Json)) {
                if ($e.seq -gt $script:lastSeq) {
                    $logBox.AppendText("$($e.text)`r`n")
                    $script:lastSeq = $e.seq
                }
            }
        } catch {}
    }

    $tierNew = Get-MpvProp "user-data/slowmo/fps_tier"
    if ($tierNew -and $tierNew -ne $script:tierNow) { $script:tierNow = $tierNew; Set-Tier $tierNew }

    # Mirror the player's UI scale so Ctrl+= / Ctrl+- (or the UI Scale
    # buttons) resize both windows together instead of only the video's bar.
    $scale = Get-MpvProp "user-data/slowmo/ui_scale"
    if ($scale -and [math]::Abs([double]$scale - $script:scaleNow) -gt 0.02) {
        $script:scaleNow = [double]$scale
        Set-PanelScale $script:scaleNow
    }

    $pos = Get-MpvProp "time-pos"; $dur = Get-MpvProp "duration"
    $speed = Get-MpvProp "speed"; $muted = Get-MpvProp "mute"; $vol = Get-MpvProp "volume"
    $name = Get-MpvProp "filename"

    $sp = ""
    if ($speed -and [math]::Abs([double]$speed - 1.0) -gt 0.01) {
        $sp = "  {0:N2}x" -f [double]$speed
    }
    $line1 = "{0}  {1} / {2}{3}" -f $(if ($paused) { "PAUSED " } else { "PLAYING" }),
        (Format-Time $pos), (Format-Time $dur), $sp
    $line2 = "{0}   {1}" -f $(if ($muted) { "muted" } else { "vol $([math]::Round($vol))%" }),
        $(if ($name) { if ($name.Length -gt 34) { $name.Substring(0, 33) + "~" } else { $name } } else { "" })
    $status.Text = "$line1`r`n$line2"
    $status.ForeColor = $TierPalette[$script:tierNow]
})
$timer.Start()

$form.Add_FormClosing({
    $timer.Stop()
    try {
        $b = if ($form.WindowState -eq "Normal") { $form.Bounds } else { $form.RestoreBounds }
        # BOM-free: ConvertFrom-Json fails on a leading BOM, which would
        # make this position silently never restore.
        [IO.File]::WriteAllText($PanelStateFile,
            "{""x"":$($b.X),""y"":$($b.Y),""w"":$($b.Width),""h"":$($b.Height)}",
            (New-Object System.Text.UTF8Encoding($false)))
    } catch {}
    if ($script:connected) {
        Send-Mpv -Command @("set_property", "user-data/slowmo/panel_open", $false) | Out-Null
        Send-Mpv -Command @("quit") | Out-Null
    }
    Disconnect-Mpv
})

[System.Windows.Forms.Application]::Run($form)

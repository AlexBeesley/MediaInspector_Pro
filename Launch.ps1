# ============================================================
# MediaInspector_Pro launcher
#   * restores the last opened media and the window POSITION
#   * the window SIZE comes from the media itself - the Lua script fits the
#     window to each file as it loads, so a 1080p clip opens as a 1080p
#     window and a 6000px photo opens as large as the display allows
#   * saves the window position periodically while the player runs
# mpv has no window-position property, so the rect is read from the
# Win32 window handle here rather than from inside the Lua script.
# ============================================================

param([string[]]$Files)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeomFile = Join-Path $Root "state_geometry.json"
$StateFile = Join-Path $Root "state_player.json"
$PipeName = "mediainspector_pro"

$mpv = "C:\Program Files\MPV Player\mpv.exe"
if (-not (Test-Path $mpv)) {
    $found = (Get-Command mpv -ErrorAction SilentlyContinue).Source
    if ($found) { $mpv = $found }
}
if (-not (Test-Path $mpv)) {
    [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
        "mpv.exe not found. Install it with:`n`nwinget install --id shinchiro.mpv -e",
        "MediaInspector_Pro") | Out-Null
    exit 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win32 {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@

# Windows PowerShell's -Encoding utf8 writes a BOM, and ConvertFrom-Json
# chokes on a leading BOM - which silently broke every restore. Write
# without one, and strip it defensively when reading.
function Write-Json {
    param([string]$Path, [string]$Json)
    [IO.File]::WriteAllText($Path, $Json, (New-Object System.Text.UTF8Encoding($false)))
}

function Read-Json {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        $raw = [IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF, ' ', "`t", "`r", "`n")
        if (-not $raw) { return $null }
        return $raw | ConvertFrom-Json
    } catch { return $null }
}

# If a player is already running, hand the file to it instead of starting a
# second instance - two would fight over the same IPC pipe. This is what
# makes "open with" from Explorer behave like a normal app.
if ($Files -and $Files.Count -gt 0) {
    try {
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
        $pipe.Connect(300)
        $w = New-Object System.IO.StreamWriter($pipe); $w.AutoFlush = $true
        $full = (Resolve-Path -LiteralPath $Files[0]).Path
        $w.WriteLine((@{ command = @("loadfile", $full, "replace") } | ConvertTo-Json -Compress))
        Start-Sleep -Milliseconds 150
        $pipe.Dispose()
        exit 0
    } catch { }   # not running - fall through and start one
}

$mpvArgs = @("--config-dir=$Root\config")

# The control panel writes config\render.conf when the renderer API is
# switched. gpu-api cannot change on a running player, so it is applied here
# instead - --include is parsed after mpv.conf, so it overrides it.
$RenderConf = Join-Path $Root "config\render.conf"
if (Test-Path $RenderConf) { $mpvArgs += "--include=$RenderConf" }

# Only the POSITION is restored. The size is deliberately left to the Lua
# script's fit-to-media pass, which runs on the first file-loaded event -
# restoring a saved size here would flash the old window dimensions and,
# worse, would be the size that wins for whatever the file turns out to be.
$g = Read-Json $GeomFile
if ($g -and $null -ne $g.x -and $null -ne $g.y) {
    $sign = { param($n) if ($n -lt 0) { "$n" } else { "+$n" } }
    $mpvArgs += "--geometry=$(& $sign ([int]$g.x))$(& $sign ([int]$g.y))"
}

# A file passed on the command line wins; otherwise resume the last one.
if ($Files -and $Files.Count -gt 0) {
    $mpvArgs += $Files
} else {
    $s = Read-Json $StateFile
    if ($s -and $s.file -and (Test-Path -LiteralPath $s.file)) { $mpvArgs += $s.file }
}

# Windows PowerShell's Start-Process does NOT quote ArgumentList entries, so
# any path containing a space arrives at mpv split into several arguments and
# the file silently fails to open. Quote each entry that needs it.
$argLine = ($mpvArgs | ForEach-Object {
    if ($_ -match '[\s]' -and $_ -notmatch '^".*"$') { '"' + $_ + '"' } else { $_ }
}) -join ' '

$proc = Start-Process -FilePath $mpv -ArgumentList $argLine -PassThru

# Track the window rect until mpv exits, so the next launch reopens in place.
# The size is recorded too, purely so a human can read the state file - the
# launcher above only ever plays back x and y.
$last = ""
while (-not $proc.HasExited) {
    Start-Sleep -Milliseconds 1500
    $proc.Refresh()
    if ($proc.HasExited) { break }
    $h = $proc.MainWindowHandle
    if ($h -ne [IntPtr]::Zero) {
        $r = New-Object RECT
        if ([Win32]::GetWindowRect($h, [ref]$r)) {
            $w = $r.Right - $r.Left
            $ht = $r.Bottom - $r.Top
            if ($w -gt 200 -and $ht -gt 200) {
                $json = "{""x"":$($r.Left),""y"":$($r.Top),""w"":$w,""h"":$ht}"
                if ($json -ne $last) {
                    Write-Json $GeomFile $json
                    $last = $json
                }
            }
        }
    }
}

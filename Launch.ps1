# ============================================================
# SlowmoPlayer launcher
#   * restores the last played video and the player window position
#   * saves the window rect periodically while the player runs
# mpv has no window-position property, so the rect is read from the
# Win32 window handle here rather than from inside the Lua script.
# ============================================================

param([string[]]$Files)

$ErrorActionPreference = "SilentlyContinue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$GeomFile = Join-Path $Root "state_geometry.json"
$StateFile = Join-Path $Root "state_player.json"

$mpv = "C:\Program Files\MPV Player\mpv.exe"
if (-not (Test-Path $mpv)) {
    $found = (Get-Command mpv -ErrorAction SilentlyContinue).Source
    if ($found) { $mpv = $found }
}
if (-not (Test-Path $mpv)) {
    [System.Reflection.Assembly]::LoadWithPartialName("System.Windows.Forms") | Out-Null
    [System.Windows.Forms.MessageBox]::Show(
        "mpv.exe not found. Install it with:`n`nwinget install --id shinchiro.mpv -e",
        "SlowmoPlayer") | Out-Null
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
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream(".", "slowmoplayer", [System.IO.Pipes.PipeDirection]::InOut)
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

# Restore window geometry
$g = Read-Json $GeomFile
if ($g -and $g.w -gt 200 -and $g.h -gt 200) {
    $mpvArgs += "--geometry=$($g.w)x$($g.h)+$($g.x)+$($g.y)"
    $mpvArgs += "--autofit-larger=95%x95%"
} else {
    $mpvArgs += "--geometry=70%x80%"
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

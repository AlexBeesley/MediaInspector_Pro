# ============================================================
# Registers SlowmoPlayer with Explorer for video files.
#
# Explorer's "Open with" / default-app system only accepts a real .exe -
# a .bat or .ps1 will not appear in the app picker, which is why setting
# the default previously did nothing. So this builds a tiny SlowmoPlayer.exe
# shim (compiled locally, no downloads) that hands the file to Launch.ps1,
# then registers that.
#
# All keys are under HKCU - no admin, affects only this user.
# Run with -Remove to undo.
# ============================================================

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "SlowmoPlayer.exe"
$Launch = Join-Path $Root "Launch.ps1"
$ProgId = "SlowmoPlayer.Video"
$AppName = "SlowmoPlayer.exe"
$Exts = @(".mp4", ".mov", ".m4v", ".mkv")
$Classes = "HKCU:\Software\Classes"

if ($Remove) {
    Remove-Item "$Classes\$ProgId" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$Classes\Applications\$AppName" -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($e in $Exts) {
        Remove-Item "$Classes\SystemFileAssociations\$e\shell\SlowmoPlayer" -Recurse -Force -ErrorAction SilentlyContinue
        $owp = "$Classes\$e\OpenWithProgids"
        if (Test-Path $owp) { Remove-ItemProperty -Path $owp -Name $ProgId -Force -ErrorAction SilentlyContinue }
    }
    Write-Host "Removed. (If it was set as the default app, pick a new default in"
    Write-Host "Settings > Apps > Default apps.)"
    return
}

if (-not (Test-Path $Launch)) { throw "Launch.ps1 not found beside this script." }

# ---------- Build the shim exe ----------
# WindowsApplication subsystem = no console window flashes on open.
$src = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

static class SlowmoShim {
    static void Main(string[] argv) {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string launch = Path.Combine(dir, "Launch.ps1");

        StringBuilder a = new StringBuilder();
        a.Append("-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"");
        a.Append(launch);
        a.Append("\"");
        foreach (string f in argv) {
            a.Append(" \"");
            a.Append(f);
            a.Append("\"");
        }

        ProcessStartInfo si = new ProcessStartInfo("powershell.exe", a.ToString());
        si.UseShellExecute = false;
        si.CreateNoWindow = true;
        si.WorkingDirectory = dir;
        Process.Start(si);
    }
}
'@

Write-Host "Building $AppName ..."
if (Test-Path $Exe) { Remove-Item $Exe -Force -ErrorAction SilentlyContinue }
Add-Type -TypeDefinition $src -OutputAssembly $Exe -OutputType WindowsApplication
if (-not (Test-Path $Exe)) { throw "Failed to build $AppName" }
Write-Host "Built $Exe"

$icon = "C:\Program Files\MPV Player\mpv.exe,0"
if (-not (Test-Path "C:\Program Files\MPV Player\mpv.exe")) {
    $f = (Get-Command mpv -ErrorAction SilentlyContinue).Source
    if ($f) { $icon = "$f,0" }
}
$cmd = "`"$Exe`" `"%1`""

# ---------- ProgId ----------
New-Item -Path "$Classes\$ProgId\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$Classes\$ProgId" -Name "(default)" -Value "Video"
Set-ItemProperty -Path "$Classes\$ProgId" -Name "FriendlyTypeName" -Value "SlowmoPlayer Video"
Set-ItemProperty -Path "$Classes\$ProgId\shell\open\command" -Name "(default)" -Value $cmd
New-Item -Path "$Classes\$ProgId\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$Classes\$ProgId\DefaultIcon" -Name "(default)" -Value $icon

# ---------- Application entry: this is what makes it show up in
#            "Open with > Choose another app" ----------
New-Item -Path "$Classes\Applications\$AppName\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$Classes\Applications\$AppName" -Name "FriendlyAppName" -Value "SlowmoPlayer"
Set-ItemProperty -Path "$Classes\Applications\$AppName\shell\open\command" -Name "(default)" -Value $cmd
New-Item -Path "$Classes\Applications\$AppName\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$Classes\Applications\$AppName\DefaultIcon" -Name "(default)" -Value $icon
New-Item -Path "$Classes\Applications\$AppName\SupportedTypes" -Force | Out-Null

foreach ($e in $Exts) {
    Set-ItemProperty -Path "$Classes\Applications\$AppName\SupportedTypes" -Name $e -Value ""

    New-Item -Path "$Classes\$e\OpenWithProgids" -Force | Out-Null
    New-ItemProperty -Path "$Classes\$e\OpenWithProgids" -Name $ProgId -Value ([byte[]]@()) `
        -PropertyType None -Force -ErrorAction SilentlyContinue | Out-Null

    # Always-visible right-click verb (works regardless of default app)
    $verb = "$Classes\SystemFileAssociations\$e\shell\SlowmoPlayer"
    New-Item -Path "$verb\command" -Force | Out-Null
    Set-ItemProperty -Path $verb -Name "(default)" -Value "Open with SlowmoPlayer"
    Set-ItemProperty -Path $verb -Name "Icon" -Value $icon
    Set-ItemProperty -Path "$verb\command" -Name "(default)" -Value $cmd
}

# Nudge Explorer to reload associations
try {
    Add-Type -Namespace Sh -Name Api -MemberDefinition @"
[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);
"@ -ErrorAction SilentlyContinue
    [Sh.Api]::SHChangeNotify(0x8000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {}

Write-Host ""
Write-Host "Registered for $($Exts -join ', ')."
Write-Host ""
Write-Host "Right-click any video -> 'Open with SlowmoPlayer' works now."
Write-Host ""
Write-Host "TO MAKE IT THE DEFAULT (must be done by hand - Windows 10/11 protects"
Write-Host "the default-app choice with a signed hash, so no script can set it):"
Write-Host "  Right-click a .mov  ->  Open with  ->  Choose another app"
Write-Host "  ->  pick SlowmoPlayer  ->  tick 'Always use this app'"
Write-Host "SlowmoPlayer now appears in that list because it is a real .exe."

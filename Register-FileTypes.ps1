# ============================================================
# Registers MediaInspector_Pro with Explorer for video, photo and
# audio files.
#
# Explorer's "Open with" / default-app system only accepts a real .exe - a
# .bat or .ps1 never appears in the app picker. The packaged build in dist# is that real .exe, so this simply points Explorer at it.
#
# All keys are under HKCU - no admin, affects only this user.
# Run with -Remove to undo.
# ============================================================

param([switch]$Remove)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Exe = Join-Path $Root "dist\MediaInspector_Pro-win32-x64\MediaInspector_Pro.exe"
$AppName = "MediaInspector_Pro.exe"
$Classes = "HKCU:\Software\Classes"

# One ProgId per kind rather than one for everything, so Explorer's
# "Open with" list shows a sensible type name and Windows can keep a
# separate default for photos than for video if you want one.
$Kinds = @(
    @{ ProgId = "MediaInspectorPro.Video"; Type = "Video"; Friendly = "MediaInspector_Pro Video"
       Exts = @(".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm", ".wmv", ".flv", ".mpg",
                ".mpeg", ".m2ts", ".mts", ".ts", ".m2v", ".vob", ".3gp", ".3g2", ".ogv",
                ".mxf", ".asf", ".divx", ".f4v", ".gif", ".ivf") }
    @{ ProgId = "MediaInspectorPro.Photo"; Type = "Image"; Friendly = "MediaInspector_Pro Image"
       Exts = @(".jpg", ".jpeg", ".jfif", ".png", ".bmp", ".webp", ".tif", ".tiff",
                ".heic", ".heif", ".avif", ".jxl", ".jp2", ".tga", ".exr", ".hdr",
                ".dds", ".ppm", ".pgm", ".pnm", ".pcx", ".qoi", ".dng", ".cr2", ".cr3",
                ".nef", ".arw", ".raf", ".orf", ".rw2") }
    @{ ProgId = "MediaInspectorPro.Audio"; Type = "Audio"; Friendly = "MediaInspector_Pro Audio"
       Exts = @(".mp3", ".wav", ".flac", ".aac", ".m4a", ".m4b", ".ogg", ".oga", ".opus",
                ".wma", ".aiff", ".aif", ".ape", ".wv", ".mka", ".dsf", ".dff", ".ac3",
                ".dts", ".mp2", ".caf", ".au", ".amr") }
)
$AllExts = $Kinds | ForEach-Object { $_.Exts } | Select-Object -Unique

# The pre-rename ProgId and shim, cleaned up so the old "Open with
# SlowmoPlayer" verb doesn't linger in the context menu forever.
$LegacyProgId = "SlowmoPlayer.Video"
$LegacyApp = "SlowmoPlayer.exe"
$LegacyExts = @(".mp4", ".mov", ".m4v", ".mkv")

function Remove-Registration {
    param([string]$ProgId, [string]$App, [string[]]$Exts, [string]$Verb)
    Remove-Item "$Classes\$ProgId" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$Classes\Applications\$App" -Recurse -Force -ErrorAction SilentlyContinue
    foreach ($e in $Exts) {
        Remove-Item "$Classes\SystemFileAssociations\$e\shell\$Verb" -Recurse -Force -ErrorAction SilentlyContinue
        $owp = "$Classes\$e\OpenWithProgids"
        if (Test-Path $owp) { Remove-ItemProperty -Path $owp -Name $ProgId -Force -ErrorAction SilentlyContinue }
    }
}

# Always clear the old registration, whether installing or removing - an
# upgrade should not leave two entries pointing at two different exes.
Remove-Registration -ProgId $LegacyProgId -App $LegacyApp -Exts $LegacyExts -Verb "SlowmoPlayer"

if ($Remove) {
    foreach ($k in $Kinds) {
        Remove-Registration -ProgId $k.ProgId -App $AppName -Exts $k.Exts -Verb "MediaInspectorPro"
    }
    Remove-Item "$Classes\Applications\$AppName" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Removed. (If it was set as the default app, pick a new default in"
    Write-Host "Settings > Apps > Default apps.)"
    return
}

# ---------- The app itself ----------
# This registers the packaged binary and must never build it here. Note that
# the path is baked into the registry, so re-run this script after moving the
# project folder or the right-click verb points at nothing.
if (-not (Test-Path $Exe)) {
    throw "Packaged build not found at $Exe - build it first:  cd app; npm run build"
}
Write-Host "Registering $Exe"

# The exe carries app.ico, so it is its own icon; mpv's is only a fallback for
# a build that predates the icon.
$icon = "$Exe,0"
if (-not (Test-Path (Join-Path $Root "app.ico"))) {
    $icon = "C:\Program Files\MPV Player\mpv.exe,0"
    $f = (Get-Command mpv -ErrorAction SilentlyContinue).Source
    if ($f -and -not (Test-Path "C:\Program Files\MPV Player\mpv.exe")) { $icon = "$f,0" }
}
$cmd = "`"$Exe`" `"%1`""

# ---------- Application entry: this is what makes it show up in
#            "Open with > Choose another app" ----------
New-Item -Path "$Classes\Applications\$AppName\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$Classes\Applications\$AppName" -Name "FriendlyAppName" -Value "MediaInspector_Pro"
Set-ItemProperty -Path "$Classes\Applications\$AppName\shell\open\command" -Name "(default)" -Value $cmd
New-Item -Path "$Classes\Applications\$AppName\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$Classes\Applications\$AppName\DefaultIcon" -Name "(default)" -Value $icon
New-Item -Path "$Classes\Applications\$AppName\SupportedTypes" -Force | Out-Null

foreach ($k in $Kinds) {
    # ---------- ProgId ----------
    New-Item -Path "$Classes\$($k.ProgId)\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path "$Classes\$($k.ProgId)" -Name "(default)" -Value $k.Type
    Set-ItemProperty -Path "$Classes\$($k.ProgId)" -Name "FriendlyTypeName" -Value $k.Friendly
    Set-ItemProperty -Path "$Classes\$($k.ProgId)\shell\open\command" -Name "(default)" -Value $cmd
    New-Item -Path "$Classes\$($k.ProgId)\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path "$Classes\$($k.ProgId)\DefaultIcon" -Name "(default)" -Value $icon

    foreach ($e in $k.Exts) {
        Set-ItemProperty -Path "$Classes\Applications\$AppName\SupportedTypes" -Name $e -Value ""

        New-Item -Path "$Classes\$e\OpenWithProgids" -Force | Out-Null
        New-ItemProperty -Path "$Classes\$e\OpenWithProgids" -Name $k.ProgId -Value ([byte[]]@()) `
            -PropertyType None -Force -ErrorAction SilentlyContinue | Out-Null

        # Always-visible right-click verb (works regardless of default app)
        $verb = "$Classes\SystemFileAssociations\$e\shell\MediaInspectorPro"
        New-Item -Path "$verb\command" -Force | Out-Null
        Set-ItemProperty -Path $verb -Name "(default)" -Value "Open with MediaInspector_Pro"
        Set-ItemProperty -Path $verb -Name "Icon" -Value $icon
        Set-ItemProperty -Path "$verb\command" -Name "(default)" -Value $cmd
    }
}

# Nudge Explorer to reload associations
try {
    Add-Type -Namespace Sh -Name Api -MemberDefinition @"
[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, uint f, IntPtr a, IntPtr b);
"@ -ErrorAction SilentlyContinue
    [Sh.Api]::SHChangeNotify(0x8000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
} catch {}

Write-Host ""
Write-Host "Registered for $($AllExts.Count) extensions across video, photos and audio."
Write-Host ""
Write-Host "Right-click any of them -> 'Open with MediaInspector_Pro' works now."
Write-Host ""
Write-Host "TO MAKE IT THE DEFAULT (must be done by hand - Windows 10/11 protects"
Write-Host "the default-app choice with a signed hash, so no script can set it):"
Write-Host "  Right-click a file  ->  Open with  ->  Choose another app"
Write-Host "  ->  pick MediaInspector_Pro  ->  tick 'Always use this app'"
Write-Host "It appears in that list because it is a real .exe."



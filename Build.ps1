# ============================================================
# Builds MediaInspector_Pro.exe from src\*.cs
#
# Uses the C# compiler that ships with the .NET Framework, so there is
# nothing to install - no SDK, no NuGet, no toolchain. Output is a single
# self-contained WinExe next to this script.
# ============================================================

param([switch]$Run)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Out = Join-Path $Root "MediaInspector_Pro.exe"
$Src = Get-ChildItem (Join-Path $Root "src") -Filter *.cs | Sort-Object Name

if (-not $Src) { throw "No sources found in $Root\src" }

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) { throw "csc.exe not found - is the .NET Framework present?" }

# WinExe: no console window flashes when Explorer launches it.
$args = @(
    "/nologo"
    "/target:winexe"
    "/optimize+"
    "/platform:anycpu"
    "/out:`"$Out`""
    "/reference:System.dll"
    "/reference:System.Drawing.dll"
    "/reference:System.Windows.Forms.dll"
    "/reference:System.Management.dll"
)

$icon = Join-Path $Root "app.ico"
if (Test-Path $icon) { $args += "/win32icon:`"$icon`"" }

$args += ($Src | ForEach-Object { "`"$($_.FullName)`"" })

Write-Host "Compiling $($Src.Count) source files -> $(Split-Path $Out -Leaf)"
if (Test-Path $Out) {
    try { Remove-Item -LiteralPath $Out -Force } catch { throw "$Out is locked - close the app first." }
}

$output = & $csc $args 2>&1
$ok = $LASTEXITCODE -eq 0

$output | ForEach-Object { Write-Host $_ }

if (-not $ok -or -not (Test-Path $Out)) { throw "Build failed." }

Write-Host ""
Write-Host "Built $Out  ($([math]::Round((Get-Item $Out).Length / 1kb)) KB)"
if (-not (Test-Path $icon)) {
    Write-Host "(no app.ico beside this script - built without a custom icon)"
}

if ($Run) { Start-Process -FilePath $Out -WorkingDirectory $Root }

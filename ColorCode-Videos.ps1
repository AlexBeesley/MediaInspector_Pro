param(
    [string]$TargetFolder = "."
)

$ErrorActionPreference = "Stop"

# Resolve absolute path
$TargetFolder = (Resolve-Path $TargetFolder).Path

Write-Host "Color-coding videos in: $TargetFolder" -ForegroundColor Cyan

# Create Shell object to read native Windows metadata
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace($TargetFolder)

if (-not $folder) {
    Write-Error "Could not access folder: $TargetFolder"
    exit 1
}

# Dynamically find the "Frame rate" property ID (it can vary by Windows version, usually 317)
$frameRateId = -1
for ($i = 0; $i -le 400; $i++) {
    if ($folder.GetDetailsOf($null, $i) -match "^Frame rate$") {
        $frameRateId = $i
        break
    }
}

if ($frameRateId -eq -1) {
    Write-Error "Could not find 'Frame rate' property in Windows."
    exit 1
}

$emojis = @("🟡", "🟢", "🔵")
$extensions = @(".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm")

$files = Get-ChildItem -Path $TargetFolder -File | Where-Object { $extensions -contains $_.Extension.ToLower() }

$processed = 0
$skipped = 0

foreach ($fileInfo in $files) {
    $shellFile = $folder.ParseName($fileInfo.Name)
    if (-not $shellFile) { continue }

    $fpsString = $folder.GetDetailsOf($shellFile, $frameRateId)
    $fps = 0

    if ($fpsString -match '(\d+(?:\.\d+)?)') {
        $fps = [double]$matches[1]
    }

    if ($fps -eq 0) {
        Write-Host "Skipping '$($fileInfo.Name)' (Could not detect framerate)" -ForegroundColor DarkGray
        $skipped++
        continue
    }

    # Determine Tier Emoji
    $emoji = "🔵"
    if ($fps -ge 110) {
        $emoji = "🟡"
    } elseif ($fps -ge 50) {
        $emoji = "🟢"
    }

    $newName = $fileInfo.Name

    # Strip existing emojis from the start
    foreach ($e in $emojis) {
        if ($newName.StartsWith("$e ")) {
            $newName = $newName.Substring($e.Length + 1)
        } elseif ($newName.StartsWith($e)) {
            $newName = $newName.Substring($e.Length)
        }
    }

    # Add the new emoji
    $newName = "$emoji $newName"

    if ($newName -cne $fileInfo.Name) {
        Rename-Item -Path $fileInfo.FullName -NewName $newName -ErrorAction Stop
        Write-Host "Renamed: $($fileInfo.Name) -> $newName ($fps fps)" -ForegroundColor Green
        $processed++
    } else {
        $skipped++
    }
}

Write-Host "Done! Processed $processed, Skipped $skipped." -ForegroundColor Cyan

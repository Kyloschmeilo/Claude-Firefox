<#
  Claude-Firefox: Claude Code / Claude Desktop auch für Firefox anmelden (optional, experimentell).

  Claude Code und Claude Desktop sprechen über "Native Messaging" mit der Extension.
  Beide richten das nur für Chrome ein. Dieses Skript liest die vorhandene
  Chrome-Registrierung und legt eine passende Registrierung für Firefox an.

  Aufruf (PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-native-host.ps1
  Rückgängig:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-native-host.ps1 -Uninstall
#>
param(
  [string]$GeckoId = 'claude-firefox-port@localhost',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$hostNames = @('com.anthropic.claude_code_browser_extension', 'com.anthropic.claude_browser_extension')
$chromeRoots = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKLM:\Software\Google\Chrome\NativeMessagingHosts',
  'HKLM:\Software\WOW6432Node\Google\Chrome\NativeMessagingHosts'
)
$firefoxRoot = 'HKCU:\Software\Mozilla\NativeMessagingHosts'
$targetDir = Join-Path $env:LOCALAPPDATA 'Claude-Firefox\NativeMessagingHosts'

if ($Uninstall) {
  foreach ($name in $hostNames) {
    $key = Join-Path $firefoxRoot $name
    if (Test-Path $key) { Remove-Item $key -Force; Write-Host "  - $name entfernt" }
  }
  if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
  Write-Host 'Fertig.'
  exit 0
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$found = 0
foreach ($name in $hostNames) {
  $chromeManifest = $null
  foreach ($root in $chromeRoots) {
    $key = Join-Path $root $name
    if (Test-Path $key) {
      $chromeManifest = (Get-Item $key).GetValue('')
      if ($chromeManifest) { break }
    }
  }
  if (-not $chromeManifest -or -not (Test-Path $chromeManifest)) {
    Write-Host "  - $name : keine Chrome-Registrierung gefunden (Programm nicht installiert oder nicht für Chrome eingerichtet)."
    continue
  }

  $json = Get-Content -Raw -Path $chromeManifest | ConvertFrom-Json
  $hostPath = [string]$json.path
  if (-not [System.IO.Path]::IsPathRooted($hostPath)) {
    $hostPath = Join-Path (Split-Path -Parent $chromeManifest) $hostPath
  }

  $firefoxManifest = [ordered]@{
    name               = $name
    description        = [string]$json.description
    path               = $hostPath
    type               = 'stdio'
    allowed_extensions = @($GeckoId)
  }
  $out = Join-Path $targetDir "$name.json"
  # Ohne BOM schreiben – Firefox liest die Datei als reines UTF-8.
  $text = $firefoxManifest | ConvertTo-Json -Depth 3
  [System.IO.File]::WriteAllText($out, $text, (New-Object System.Text.UTF8Encoding $false))

  $key = Join-Path $firefoxRoot $name
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $out
  Write-Host "  + $name -> $hostPath"
  $found++
}

if ($found -eq 0) {
  Write-Host ''
  Write-Host 'Nichts eingerichtet. Richte zuerst Claude Code (claude --chrome) oder Claude Desktop für Chrome ein'
  Write-Host 'und starte dieses Skript dann erneut.'
  exit 1
}
Write-Host ''
Write-Host 'Fertig. Firefox neu starten, damit die Änderung wirkt.'

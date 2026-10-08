[CmdletBinding()]
param([int]$Port = 7878, [string]$Repository)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.installer-active.json')) { throw 'Setup is active or interrupted. Use Setup / Recover before starting the bridge.' }
$nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
$status = (& $nodePath (Join-Path $PSScriptRoot 'control.mjs') $Port | ConvertFrom-Json)
if ($status.running) {
    throw "Port $Port is already occupied. Stop the other bridge before starting this package."
}
$dataPath = Join-Path $PSScriptRoot 'data'
$logPath = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logPath | Out-Null
$profilePath = Join-Path $dataPath 'portable'
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$personasPath = Join-Path $profilePath 'personas.json'
if (-not (Test-Path -LiteralPath $personasPath)) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'personas.example.json') -Destination $personasPath
}
$arguments = @(('"' + (Join-Path $PSScriptRoot 'foreman\src\observer-main.mjs') + '"'), '--home', ('"' + $dataPath + '"'), '--profile', 'portable', '--port', [string]$Port)
if ($Repository) {
    $repoPath = (Resolve-Path -LiteralPath $Repository).Path
    if ($repoPath.Contains('"') -or -not (Test-Path -LiteralPath (Join-Path $repoPath '.git'))) { throw 'Choose a local Git repository.' }
    $arguments += @('--repo', ('"' + $repoPath + '"'))
}
$previousBinding = $env:AGENTCRAFT_CHAT_CONFIG
try {
    $env:AGENTCRAFT_CHAT_CONFIG = Join-Path $profilePath 'codex-chat.json'
    $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logPath 'bridge.log') -RedirectStandardError (Join-Path $logPath 'bridge-error.log')
} finally { $env:AGENTCRAFT_CHAT_CONFIG = $previousBinding }
for ($i=0; $i -lt 15; $i++) {
    $status = (& $nodePath (Join-Path $PSScriptRoot 'control.mjs') $Port | ConvertFrom-Json)
    if ($status.running -and $status.backend -eq 'observer') { Write-Host "Codex observer is ready on port $Port."; return }
    if ($process.HasExited) { throw "Bridge stopped. See logs\bridge-error.log." }
    Start-Sleep -Milliseconds 300
}
throw 'Bridge did not become ready. See the logs folder.'

[CmdletBinding()]
param([int]$Port = 7878)
$ErrorActionPreference = 'Stop'
$nodePath = Join-Path $PSScriptRoot 'runtime\node.exe'
$status = (& $nodePath (Join-Path $PSScriptRoot 'control.mjs') $Port | ConvertFrom-Json)
if ($status.running) {
    if ($status.backend -ne 'observer') { throw "Port $Port is used by another AgentCraft mode." }
    Write-Host "Codex observer is already running on port $Port."
    return
}
$dataPath = Join-Path $PSScriptRoot 'data'
$logPath = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $logPath | Out-Null
$arguments = @(('"' + (Join-Path $PSScriptRoot 'foreman\src\observer-main.mjs') + '"'), '--home', ('"' + $dataPath + '"'), '--profile', 'portable', '--port', [string]$Port)
$process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logPath 'bridge.log') -RedirectStandardError (Join-Path $logPath 'bridge-error.log')
for ($i=0; $i -lt 15; $i++) {
    $status = (& $nodePath (Join-Path $PSScriptRoot 'control.mjs') $Port | ConvertFrom-Json)
    if ($status.running -and $status.backend -eq 'observer') { Write-Host "Codex observer is ready on port $Port."; return }
    if ($process.HasExited) { throw "Bridge stopped. See logs\bridge-error.log." }
    Start-Sleep -Milliseconds 300
}
throw 'Bridge did not become ready. See the logs folder.'

[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Agent, [int]$Port = 7878)
$ErrorActionPreference = 'Stop'
$profilePath = Join-Path $PSScriptRoot 'data\portable'
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$previousBinding = $env:AGENTCRAFT_CHAT_CONFIG
try {
    $env:AGENTCRAFT_CHAT_CONFIG = Join-Path $profilePath 'codex-chat.json'
    & (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'connect-codex-chat.mjs') --agent $Agent --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'Connect this package from the selected Codex desktop conversation.' }
} finally { $env:AGENTCRAFT_CHAT_CONFIG = $previousBinding }

[CmdletBinding()]
param([string]$Agent, [int]$Port = 7878, [string]$ThreadId, [string]$HostId, [switch]$Check)
$ErrorActionPreference = 'Stop'
$profilePath = Join-Path $PSScriptRoot 'data\portable'
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$previousBinding = $env:AGENTCRAFT_CHAT_CONFIG
try {
    $env:AGENTCRAFT_CHAT_CONFIG = Join-Path $profilePath 'codex-chat.json'
    $targetArgs = @()
    if ($ThreadId -or $HostId) {
        if (-not $ThreadId -or -not $HostId) { throw 'Specify both -ThreadId and -HostId.' }
        $targetArgs += @('--thread', $ThreadId, '--host', $HostId)
    }
    if ($Check) { $targetArgs += '--check' }
    if ($Agent) {
        & (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'connect-codex-chat.mjs') --agent $Agent --port $Port @targetArgs
    } else {
        if (-not $Check -and (Test-Path -LiteralPath (Join-Path $profilePath 'team.json'))) { throw 'This profile uses a team. Specify -Agent <id>.' }
        & (Join-Path $PSScriptRoot 'runtime\node.exe') (Join-Path $PSScriptRoot 'connect-codex-chat.mjs') @targetArgs
    }
    if ($LASTEXITCODE -ne 0) { throw 'Connect this package from the selected Codex desktop conversation.' }
} finally { $env:AGENTCRAFT_CHAT_CONFIG = $previousBinding }

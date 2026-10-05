<# Starts the Codex observer with a private, portable Java 25 runtime. #>
[CmdletBinding()]
param(
    [switch]$Stop,
    [switch]$NoGame,
    [switch]$NoWait,
    [string]$Repo = 'C:\Users\GB\Documents\New project'
)
$ErrorActionPreference = 'Stop'
$acRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$acHome = Join-Path $acRoot '.agentcraft-home'
if ($Stop) {
    & (Join-Path $PSScriptRoot 'stop.ps1') -Home $acHome -Profile traderecord
    exit $LASTEXITCODE
}
$runtimeRoot = Join-Path $acRoot '.runtime'
$jdk = Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like 'jdk-25*' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'bin\java.exe')) } |
    Sort-Object Name -Descending | Select-Object -First 1
if (-not $NoGame -and -not $jdk) { throw 'Install a portable JDK 25 under the AgentCraft .runtime folder first (see docs/CODEX_OBSERVER.md).' }
$oldJavaHome = $env:JAVA_HOME
$oldWorldConfig = $env:AGENTCRAFT_WORLD_CONFIG
try {
    if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
    $env:AGENTCRAFT_WORLD_CONFIG = Join-Path $acRoot 'world-settings.json'
    & (Join-Path $PSScriptRoot 'launch.ps1') -Backend observer -Profile traderecord -Home $acHome -Repo $Repo -Port 7878 -DevPort 7879 -NoGame:$NoGame -NoWait:$NoWait -SummaryJson (Join-Path $acRoot 'artifacts\run\traderecord-summary.json')
} finally {
    $env:JAVA_HOME = $oldJavaHome
    $env:AGENTCRAFT_WORLD_CONFIG = $oldWorldConfig
}

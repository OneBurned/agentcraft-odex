[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Agent,
    [string]$ProfileDir = (Join-Path $PSScriptRoot 'data\portable'),
    [switch]$Desktop,
    [switch]$Return
)
$ErrorActionPreference = 'Stop'
$launchArgs = @((Join-Path $PSScriptRoot 'foreman\src\agent-terminal.mjs'), '--profile-dir', $ProfileDir, '--agent', $Agent)
if ($Desktop) { $launchArgs += '--desktop' }
if ($Return) { $launchArgs += '--return' }
& (Join-Path $PSScriptRoot 'runtime\node.exe') @launchArgs
if ($LASTEXITCODE -ne 0) { throw 'Claude Code did not finish successfully. See its message above.' }

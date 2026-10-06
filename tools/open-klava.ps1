[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [switch]$Continue,
    [switch]$Check
)
$ErrorActionPreference = 'Stop'
$acRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node -ErrorAction Stop).Source
$loader = ([Uri](Join-Path $acRoot 'foreman\node_modules\tsx\dist\loader.mjs')).AbsoluteUri
$launchArgs = @('--import', $loader, (Join-Path $PSScriptRoot 'klava-terminal.mjs'), '--workspace', $Workspace)
if ($Continue) { $launchArgs += '--continue' }
if ($Check) { $launchArgs += '--check' }
& $node @launchArgs
if ($LASTEXITCODE -ne 0) { throw 'Claude Code did not finish successfully. See its message above.' }

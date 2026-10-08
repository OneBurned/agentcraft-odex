[CmdletBinding()]
param([string]$GameDirectory)
$ErrorActionPreference = 'Stop'
# All installation entry points use the same process guards, validation, backups and rollback.
if ($GameDirectory) { Write-Host "Select this game directory in Setup: $GameDirectory" }
& (Join-Path $PSScriptRoot 'Setup.ps1')

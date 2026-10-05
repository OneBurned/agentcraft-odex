$ErrorActionPreference = 'Stop'
$profilePath = Join-Path $PSScriptRoot 'data\portable'
$ownerPath = Join-Path $profilePath 'portable.json'
if (-not (Test-Path -LiteralPath $ownerPath)) { Write-Host 'This package has no running bridge. An observer started elsewhere is left running.'; return }
$owner = Get-Content -Raw -LiteralPath $ownerPath | ConvertFrom-Json
@{ pid=$owner.pid; token=$owner.token } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $profilePath 'portable-stop.json') -Encoding Ascii
for ($i=0; $i -lt 30; $i++) {
    if (-not (Test-Path -LiteralPath $ownerPath)) { Write-Host 'Bridge stopped; state saved.'; return }
    Start-Sleep -Milliseconds 300
}
throw 'No shutdown acknowledgement. No other process was stopped. Check logs\bridge-error.log.'

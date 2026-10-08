# Run with both pwsh and Windows PowerShell. No child processes are stopped by this check.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\lib\procs.ps1')
$testFile = Join-Path ([IO.Path]::GetTempPath()) ('agentcraft-procs-' + [Guid]::NewGuid().ToString('N') + '.json')
try {
    $start = Get-ProcStart $PID
    Write-JsonFile $testFile @{ pid = $PID; startTime = $start }
    $read = Read-JsonFile $testFile
    if ($read.startTime -isnot [string]) { throw 'JSON process timestamp must remain a string' }
    if ($read.startTime -ne $start) { throw 'JSON process timestamp lost precision or timezone' }
    if (-not (Test-SameProc $PID $read.startTime)) { throw 'Live process was incorrectly classified as dead' }
    $wrongStart = [DateTime]::Parse($start).AddMinutes(-1).ToUniversalTime().ToString('o')
    if (Test-SameProc $PID $wrongStart) { throw 'Wrong process identity was accepted' }
    Write-Output 'Process identity JSON round-trip: PASS'
} finally { if (Test-Path -LiteralPath $testFile) { Remove-Item -LiteralPath $testFile } }

[CmdletBinding()]
param([string]$GameDirectory)
$ErrorActionPreference = 'Stop'
if (-not $GameDirectory) { $GameDirectory = Read-Host 'Minecraft 26.3 Fabric profile game directory' }
if (-not $GameDirectory -or -not (Test-Path -LiteralPath $GameDirectory -PathType Container)) { throw 'Choose an existing Minecraft profile game directory.' }
$gamePath = [IO.Path]::GetFullPath($GameDirectory)
$modsPath = Join-Path $gamePath 'mods'
$backupPath = Join-Path $gamePath ('agentcraft-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Force -Path $modsPath | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
foreach ($jar in Get-ChildItem -LiteralPath $modsPath -Filter '*.jar' -File) {
    $archive = $null
    $modId = $null
    try {
        $archive = [IO.Compression.ZipFile]::OpenRead($jar.FullName)
        $entry = $archive.GetEntry('fabric.mod.json')
        if ($entry) {
            $reader = [IO.StreamReader]::new($entry.Open())
            try { $modId = ($reader.ReadToEnd() | ConvertFrom-Json).id } finally { $reader.Dispose() }
        }
    } finally { if ($archive) { $archive.Dispose() } }
    if ($modId -in @('agentcraft','fabric-api')) {
        New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
        Move-Item -LiteralPath $jar.FullName -Destination (Join-Path $backupPath $jar.Name)
    }
}
Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'mods') -Filter '*.jar' -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $modsPath }
$configPath = Join-Path $gamePath 'config'
New-Item -ItemType Directory -Force -Path $configPath | Out-Null
$clientConfig = Join-Path $configPath 'agentcraft-client.json'
if (-not (Test-Path -LiteralPath $clientConfig)) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'config\agentcraft-client.json') -Destination $clientConfig }
Write-Host "Installed AgentCraft and Fabric API in $modsPath. Select Minecraft 26.3 with Fabric Loader 0.19.5+ and Java 25."
Write-Host 'Existing replaced mods are preserved under agentcraft-backups. Existing client settings are preserved.'

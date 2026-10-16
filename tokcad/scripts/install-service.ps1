<#
.SYNOPSIS
    One-time: register the tok-cad NSSM service (TOK CAD at tok-share.com/cad). Run elevated.
    Does not start it; tokcad\scripts\deploy.ps1 fills D:\apps\tokcad and starts it.

    Node from Program Files (machine-wide, visible to LocalSystem), production mode, port 5006
    on loopback only, account data in D:\apps\tokcad-data. The data folder holds the account
    databases and mail.json (the Gmail app password), so it is closed to everyone but SYSTEM,
    Administrators and the owner.
#>
[CmdletBinding()]
param(
    [string]$ServiceName = 'tok-cad',
    [string]$LiveDir = 'D:\apps\tokcad',
    [string]$DataDir = 'D:\apps\tokcad-data',
    [string]$Node = 'C:\Program Files\nodejs\node.exe',
    [string]$Nssm = 'C:\Windows\system32\nssm.exe',
    [string]$Owner = 'timjb'
)
$ErrorActionPreference = 'Stop'

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "$ServiceName already exists - nothing to do." -ForegroundColor Yellow
    exit 0
}
foreach ($p in $Node, $Nssm) { if (-not (Test-Path $p)) { throw "not found: $p" } }
New-Item -ItemType Directory -Force -Path $LiveDir, $DataDir | Out-Null

& icacls $DataDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${Owner}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls on $DataDir failed ($LASTEXITCODE)" }

& $Nssm install $ServiceName $Node (Join-Path $LiveDir 'server.js')
if ($LASTEXITCODE -ne 0) { throw "nssm install failed ($LASTEXITCODE)" }
$set = @(
    @('AppDirectory', $LiveDir),
    @('AppStdout', (Join-Path $LiveDir 'stdout.log')),
    @('AppStderr', (Join-Path $LiveDir 'stderr.log')),
    @('AppRotateFiles', '1'),
    @('AppRotateBytes', '5242880'),
    @('AppRestartDelay', '3000'),
    @('AppThrottle', '5000'),
    @('Start', 'SERVICE_AUTO_START'),
    @('DisplayName', $ServiceName),
    @('Description', 'TOK CAD browser CAD (tok-share.com/cad), port 5006')
)
foreach ($kv in $set) {
    & $Nssm set $ServiceName $kv[0] $kv[1] | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "nssm set $($kv[0]) failed ($LASTEXITCODE)" }
}
& $Nssm set $ServiceName AppEnvironmentExtra 'NODE_ENV=production' 'PARTMODE_HOST=127.0.0.1' 'PARTMODE_PORT=5006' `
    "PARTMODE_DIST_DIR=$LiveDir" "PARTMODE_STATE_DIR=$DataDir" 'PARTMODE_PUBLIC_ORIGIN=https://tok-share.com' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "nssm set AppEnvironmentExtra failed ($LASTEXITCODE)" }

# Verify from the registry, not from nssm's exit codes.
$params = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
if ($params.Application -ne $Node -or $params.AppDirectory -ne $LiveDir) {
    throw "service registered but its parameters are not what was set"
}
Write-Host "$ServiceName registered (not started)." -ForegroundColor Green
$params | Select-Object Application, AppParameters, AppDirectory, AppEnvironmentExtra | Format-List

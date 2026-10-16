<#
.SYNOPSIS
    Build TOK CAD from this repository and deploy it to D:\apps\tokcad (service tok-cad). Run elevated.

.DESCRIPTION
    The AGPL requires the source of the exact running version to be public, so this refuses
    to deploy unless the tree is clean AND HEAD is already on GitHub (origin/tokcad), and the
    smoke check confirms the served page names that commit and that its source link resolves.

    Builds with TOKCAD_BASE_PATH=/cad TOKCAD_BRAND=1, mirrors dist\ into the live directory,
    restarts the service, and checks the result from the served pages, not from exit codes.
    Account data lives in D:\apps\tokcad-data (PARTMODE_STATE_DIR), outside the mirror.

.EXAMPLE
    .\tokcad\scripts\deploy.ps1 -DryRun
    .\tokcad\scripts\deploy.ps1
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [string]$LiveDir = 'D:\apps\tokcad',
    [string]$ServiceName = 'tok-cad',
    [string]$SmokeUrl = 'http://127.0.0.1:5006',
    [string]$Remote = 'origin',
    [string]$Branch = 'tokcad'
)
$ErrorActionPreference = 'Stop'
$RepoDir = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }

Step "Checking the working tree"
$dirty = & git -C $RepoDir status --porcelain
if ($dirty) {
    Write-Host "   Refusing to deploy: uncommitted changes." -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "     $_" }
    exit 1
}
$sha = (& git -C $RepoDir rev-parse HEAD).Trim()
$shortSha = $sha.Substring(0, 7)
$subject = (& git -C $RepoDir log -1 --format=%s).Trim()
Ok "clean at $shortSha - $subject"

Step "Checking the source is public"
& git -C $RepoDir fetch --quiet $Remote $Branch
if ($LASTEXITCODE -ne 0) { throw "git fetch $Remote $Branch failed" }
& git -C $RepoDir merge-base --is-ancestor $sha "$Remote/$Branch"
if ($LASTEXITCODE -ne 0) {
    Write-Host "   Refusing to deploy: $shortSha is not on $Remote/$Branch. Push it first (git push $Remote $Branch)." -ForegroundColor Red
    exit 1
}
Ok "$shortSha is on $Remote/$Branch"

if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
    throw "$ServiceName is not installed - run tokcad\scripts\install-service.ps1 first"
}

Step "Building"
$env:TOKCAD_BASE_PATH = '/cad'
$env:TOKCAD_BRAND = '1'
Push-Location $RepoDir
try {
    & npm ci --no-audit --no-fund 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    & npm run build 2>&1 | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
    & npm run check:integrity 2>&1 | Select-Object -Last 1
    if ($LASTEXITCODE -ne 0) { throw "integrity check failed" }
} finally {
    Pop-Location
    Remove-Item Env:\TOKCAD_BASE_PATH, Env:\TOKCAD_BRAND -ErrorAction SilentlyContinue
}
$dist = Join-Path $RepoDir 'dist'
$release = Get-Content (Join-Path $dist 'release.json') -Raw | ConvertFrom-Json
if ($release.releaseSha -ne $sha) { throw "built release $($release.releaseSha) is not HEAD $sha" }
if ($release.basePath -ne '/cad' -or -not $release.brand) { throw "build is not a /cad TOK CAD build" }
$files = (Get-ChildItem -Recurse -File $dist).Count
# robocopy /MIR purges what the source lacks: an empty build would delete production.
if ($files -lt 100) { throw "dist has only $files file(s) - refusing to mirror" }
Ok "built $shortSha ($files files)"

if ($DryRun) {
    Step "Dry run - nothing changed"
    Write-Host "   Would stop $ServiceName, mirror $files file(s) into $LiveDir, start it, smoke-check."
    exit 0
}

try {
    Step "Stopping $ServiceName"
    if ((Get-Service $ServiceName).Status -ne 'Stopped') {
        Stop-Service $ServiceName
        (Get-Service $ServiceName).WaitForStatus('Stopped', '00:00:30')
    }
    Ok "stopped"

    Step "Copying into $LiveDir"
    $rcArgs = @($dist, $LiveDir, '/MIR',
                '/XF', 'DEPLOYED.txt', 'stdout.log', 'stderr.log', 'stdout-*.log', 'stderr-*.log',
                '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy @rcArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
    Ok "copied (robocopy status $LASTEXITCODE)"
    "$sha`n$shortSha  $subject`ndeployed $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n" |
        Set-Content -Path (Join-Path $LiveDir 'DEPLOYED.txt') -Encoding utf8

    Step "Starting $ServiceName"
    Start-Service $ServiceName
    (Get-Service $ServiceName).WaitForStatus('Running', '00:00:30')
    Ok "started"

    Step "Smoke check"
    $page = $null
    for ($i = 0; $i -lt 30 -and -not $page; $i++) {
        try { $page = Invoke-WebRequest -Uri "$SmokeUrl/" -UseBasicParsing -TimeoutSec 10 } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $page -or $page.StatusCode -ne 200) { throw "GET / did not return 200" }
    if ($page.Content -notmatch "name=`"partmode-release`" content=`"$sha`"") { throw "served page is not release $sha" }
    if ($page.Content -notmatch [regex]::Escape("/tok-cad/tree/$sha")) { throw "served page has no source link to $sha" }
    $asset = Invoke-WebRequest -Uri "$SmokeUrl/assets/$($release.assetVersion)/studio.js" -UseBasicParsing -TimeoutSec 10
    if ($asset.StatusCode -ne 200) { throw "studio.js returned $($asset.StatusCode)" }
    $src = Invoke-WebRequest -Uri "https://github.com/tbarker80/tok-cad/tree/$sha" -UseBasicParsing -TimeoutSec 20 -Method Head
    if ($src.StatusCode -ne 200) { throw "the source link does not resolve on GitHub" }
    Ok "release $shortSha served; source link resolves on GitHub"
    Write-Host "`nDeployed $shortSha - $subject" -ForegroundColor Green
}
finally {
    $svc = Get-Service $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') {
        Write-Host "`n$ServiceName is not running - starting it." -ForegroundColor Yellow
        Start-Service $ServiceName -ErrorAction SilentlyContinue
    }
}

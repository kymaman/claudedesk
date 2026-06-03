# ClaudeDesk smart launcher
# - Checks src/ vs dist/ and electron/ vs dist-electron/ mtimes
# - Rebuilds ONLY what's stale (build:frontend / compile)
# - Then launches Electron pointing at dist-electron/main.js
#
# Run from the desktop shortcut. Skips rebuild entirely when nothing
# changed since last build -- typical launch is ~1 second.
#
# ASCII-only on purpose: PowerShell 5.1 reads .ps1 as ANSI when there
# is no BOM, and any non-ASCII char (arrows, em-dashes) breaks the
# tokenizer at unrelated braces. Don't add Unicode here without a BOM.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

function NewestMtime($glob) {
    $files = Get-ChildItem -Path $glob -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\(node_modules|dist|dist-electron|release|test-results|playwright-report)\\' }
    if (-not $files) { return [DateTime]::MinValue }
    return ($files | Measure-Object -Property LastWriteTime -Maximum).Maximum
}

function FileMtime($path) {
    if (Test-Path $path) { return (Get-Item $path).LastWriteTime }
    return [DateTime]::MinValue
}

$srcNewest      = NewestMtime "$root\src"
$electronNewest = NewestMtime "$root\electron"
$distBuilt      = FileMtime "$root\dist\index.html"
$mainBuilt      = FileMtime "$root\dist-electron\main.js"

$needFrontend = ($srcNewest -gt $distBuilt) -or (-not (Test-Path "$root\dist\index.html"))
# Compile electron/ only when its sources moved past the compiled main.js.
$needCompile  = ($electronNewest -gt $mainBuilt) -or (-not (Test-Path "$root\dist-electron\main.js"))

if ($needFrontend -or $needCompile) {
    Write-Host "[ClaudeDesk] Source changed -- rebuilding..." -ForegroundColor Yellow
    if ($needCompile) {
        Write-Host "  -> npm run compile (electron main)" -ForegroundColor DarkGray
        npm run compile
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Compile failed -- aborting launch." -ForegroundColor Red
            Read-Host "Press Enter to close"
            exit 1
        }
    }
    if ($needFrontend) {
        Write-Host "  -> npm run build:frontend (renderer)" -ForegroundColor DarkGray
        npm run build:frontend
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Frontend build failed -- aborting launch." -ForegroundColor Red
            Read-Host "Press Enter to close"
            exit 1
        }
    }
    Write-Host "[ClaudeDesk] Build done -- launching..." -ForegroundColor Green
}

# Launch Electron detached so the launcher console can close immediately.
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$mainJs   = Join-Path $root 'dist-electron\main.js'

if (-not (Test-Path $electron)) {
    Write-Host "Electron binary missing at $electron -- run 'npm install' first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Start-Process -FilePath $electron -ArgumentList "`"$mainJs`"" -WorkingDirectory $root

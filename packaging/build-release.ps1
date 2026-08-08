<#
.SYNOPSIS
    Build the distributable Setup.exe for a GitHub release.

.DESCRIPTION
    Three stages, in the only order they work in: build the interface, freeze
    the server around it, then wrap the result in an installer. Each stage
    fails loudly rather than letting the next one package something stale --
    shipping yesterday's interface inside today's build is the mistake this
    script exists to make impossible.

    The card mirror is deliberately not included. Each install downloads its
    own from Scryfall on first run, which keeps this under about 60MB, keeps
    the data current, and means every copy talks to Scryfall directly the way
    they ask rather than through a redistribution of their bulk files.

.EXAMPLE
    .\packaging\build-release.ps1
    .\packaging\build-release.ps1 -Version 1.1.0
    .\packaging\build-release.ps1 -SkipInstaller   # stop after PyInstaller
#>
[CmdletBinding()]
param(
    [string]$Version = '1.0.0',
    [switch]$SkipInstaller
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root 'server\.venv\Scripts\python.exe'
$pyinstaller = Join-Path $root 'server\.venv\Scripts\pyinstaller.exe'

# Native tools are run through this rather than called directly.
#
# npm, PyInstaller and ISCC all write ordinary progress to stderr, and with
# ErrorActionPreference at Stop PowerShell wraps each of those lines in an
# ErrorRecord and aborts -- on a build that succeeded and returned zero. The
# exit code is the only trustworthy signal, so the preference is relaxed for
# the duration of the call and the caller checks $LASTEXITCODE.
function Run {
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $File @Arguments } finally { $ErrorActionPreference = $previous }
}

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }
function Step($msg) { Say ''; Say "  $msg" 'Cyan' }
function Ok($msg) { Say "  [ok]   $msg" 'Green' }
function Die($msg) { Say "  [fail] $msg" 'Red'; exit 1 }

Say ''
Say "  INSIGHT ENGINE - release build $Version" 'Cyan'

if (-not (Test-Path $python)) { Die 'No virtualenv. Run .\install.ps1 first.' }

# --- 1. interface ----------------------------------------------------------

Step 'Building the interface'
Run 'npm' @('--prefix', (Join-Path $root 'web'), 'run', 'build')
if ($LASTEXITCODE -ne 0) { Die 'Web build failed.' }
$index = Join-Path $root 'web\dist\index.html'
if (-not (Test-Path $index)) { Die 'Web build produced no dist/index.html.' }
Ok 'web/dist'

# --- 2. freeze -------------------------------------------------------------

Step 'Drawing the icon'
# Regenerated every build rather than committed as a binary that drifts: it is
# a hundred lines of Pillow, and the executable, the installer and the tray all
# take their mark from this one file.
# Run as a module from the server directory rather than passed as `-c`:
# PowerShell strips the inner quotes out of an inline program, which turned
# sys.path.insert(0, "server") into a NameError.
$ico = Join-Path $root 'packaging\insight-engine.ico'
Push-Location (Join-Path $root 'server')
try {
    Run $python @('-m', 'app.icon', $ico)
    if ($LASTEXITCODE -ne 0) { Die 'Icon generation failed.' }
} finally {
    Pop-Location
}
if (-not (Test-Path $ico)) { Die 'Icon generation produced no .ico.' }
Ok 'packaging\insight-engine.ico'

Step 'Freezing the server'

if (-not (Test-Path $pyinstaller)) {
    Say '  installing pyinstaller into the venv' 'DarkGray'
    Run $python @('-m','pip','install','--quiet','pyinstaller')
    if ($LASTEXITCODE -ne 0) { Die 'Could not install PyInstaller.' }
}

# Cleared rather than reused: PyInstaller happily leaves stale data files in
# place, which is how an old interface ends up inside a new build.
foreach ($dir in @('build', 'dist')) {
    $path = Join-Path $root $dir
    if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

Push-Location $root
try {
    Run $pyinstaller @((Join-Path $root 'packaging\insight-engine.spec'), '--noconfirm', '--clean')
    if ($LASTEXITCODE -ne 0) { Die 'PyInstaller failed.' }
} finally {
    Pop-Location
}

$exe = Join-Path $root 'dist\InsightEngine\InsightEngine.exe'
if (-not (Test-Path $exe)) { Die 'PyInstaller produced no executable.' }
$mb = [math]::Round((Get-ChildItem (Join-Path $root 'dist\InsightEngine') -Recurse |
    Measure-Object -Property Length -Sum).Sum / 1MB)
Ok "dist\InsightEngine (${mb} MB)"

# --- 3. installer ----------------------------------------------------------

if ($SkipInstaller) {
    Say ''
    Say '  Stopped before the installer, as asked.' 'Gray'
    Say "  Folder build: $(Join-Path $root 'dist\InsightEngine')" 'Gray'
    exit 0
}

Step 'Building the installer'

$iscc = Get-Command iscc -ErrorAction SilentlyContinue
if (-not $iscc) {
    foreach ($candidate in @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
    )) {
        if (Test-Path $candidate) { $iscc = Get-Item $candidate; break }
    }
}
if (-not $iscc) {
    Say '  [warn] Inno Setup not found. The folder build is ready at:' 'Yellow'
    Say "         $(Join-Path $root 'dist\InsightEngine')" 'Yellow'
    Say '         Install Inno Setup 6 from jrsoftware.org and re-run to get Setup.exe.' 'Yellow'
    exit 0
}

$source = if ($iscc.Source) { $iscc.Source } else { $iscc.FullName }
Run $source @((Join-Path $root 'packaging\insight-engine.iss'), "/DAppVersion=$Version")
if ($LASTEXITCODE -ne 0) { Die 'Inno Setup failed.' }

$setup = Join-Path $root "release\InsightEngine-$Version-Setup.exe"
if (-not (Test-Path $setup)) { Die 'Inno Setup produced no Setup.exe.' }
$setupMb = [math]::Round((Get-Item $setup).Length / 1MB, 1)

Say ''
Say '  Done.' 'Green'
Say "  $setup (${setupMb} MB)" 'Gray'
Say ''
Say '  Attach that to the GitHub release. It is unsigned, so Windows will show' 'DarkGray'
Say '  a SmartScreen warning until the download builds reputation.' 'DarkGray'
Say ''

<#
.SYNOPSIS
    Install Insight Engine: dependencies, card mirror, and optional startup entry.

.DESCRIPTION
    Does the four things start.ps1 checks for and refuses to do itself. Every
    step is skipped if it has already been done, so re-running after a failure
    picks up where it stopped rather than starting again -- which matters,
    because the mirror step downloads about 180MB.

.EXAMPLE
    .\install.ps1
    .\install.ps1 -SkipMirror     # dependencies only; build the mirror later
    .\install.ps1 -Startup        # also launch the tray at login
    .\install.ps1 -Force          # rebuild the venv and re-download the mirror
#>
[CmdletBinding()]
param(
    [switch]$SkipMirror,
    [switch]$Startup,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root 'server\.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$db = Join-Path $root 'data\manafold.sqlite3'

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }
function Step($msg) { Say ''; Say "  $msg" 'Cyan' }
function Ok($msg) { Say "  [ok]   $msg" 'Green' }
function Skip($msg) { Say "  [skip] $msg" 'DarkGray' }
function Warn($msg) { Say "  [warn] $msg" 'Yellow' }
function Die($msg) { Say "  [fail] $msg" 'Red'; exit 1 }

Say ''
Say '  INSIGHT ENGINE - install' 'Cyan'
Say '  Magic: The Gathering search. Card data from Scryfall.' 'DarkGray'

# --- prerequisites ---------------------------------------------------------
# Checked all together and up front: finding out about a missing Node twenty
# minutes into a mirror download is the worst possible time to find out.

Step 'Checking prerequisites'

$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
if (-not $py) { Die 'No Python found. Install 3.11 or newer from python.org and re-run.' }

# 3.11 is the floor: the server uses `X | Y` unions at runtime in pydantic
# models, which 3.9 parses but cannot evaluate.
$pyVersion = & $py.Source -c "import sys; print('{}.{}'.format(*sys.version_info[:2]))"
if ([version]$pyVersion -lt [version]'3.11') {
    Die "Python $pyVersion found, 3.11 or newer required."
}
Ok "Python $pyVersion"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) { Die 'No npm found. Install Node.js 18 or newer from nodejs.org and re-run.' }
Ok "npm $(& npm --version)"

# --- python environment ----------------------------------------------------

Step 'Python environment'

if ($Force -and (Test-Path $venv)) {
    Say '  removing existing virtualenv' 'DarkGray'
    Remove-Item -Recurse -Force $venv
}

if (Test-Path $python) {
    Skip 'virtualenv already exists'
} else {
    & $py.Source -3.11 -m venv $venv 2>$null
    if (-not (Test-Path $python)) { & $py.Source -m venv $venv }
    if (-not (Test-Path $python)) { Die 'Could not create the virtualenv.' }
    Ok 'virtualenv created'
}

& $python -m pip install --quiet --upgrade pip
& $python -m pip install --quiet -r (Join-Path $root 'server\requirements.txt')
if ($LASTEXITCODE -ne 0) { Die 'pip install failed.' }
Ok 'Python dependencies'

# --- frontend --------------------------------------------------------------

Step 'Frontend'

if ((Test-Path (Join-Path $root 'web\node_modules')) -and -not $Force) {
    Skip 'node_modules already present'
} else {
    & npm --prefix (Join-Path $root 'web') install --no-fund --no-audit --loglevel=error
    if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' }
    Ok 'Node dependencies'
}

# --- card mirror -----------------------------------------------------------
# The long one. Roughly 180MB of bulk data from Scryfall, then an ingest pass
# that builds the FTS index and the oracle tags.

Step 'Card mirror'

if ($SkipMirror) {
    Skip 'asked to skip; build it later with:  cd server; .venv\Scripts\python -m app.bulk'
} elseif ((Test-Path $db) -and -not $Force) {
    $size = [math]::Round((Get-Item $db).Length / 1MB)
    Skip "already built (${size} MB); use -Force to rebuild"
} else {
    Say '  Downloading and ingesting. This takes a few minutes.' 'DarkGray'
    Push-Location (Join-Path $root 'server')
    try {
        if ($Force) { & $python -m app.bulk --force } else { & $python -m app.bulk }
        if ($LASTEXITCODE -ne 0) { Die 'Mirror build failed.' }
    } finally {
        Pop-Location
    }
    $size = [math]::Round((Get-Item $db).Length / 1MB)
    Ok "Card mirror (${size} MB)"
}

# --- ollama ----------------------------------------------------------------
# Not installed here, and not fatal. Everything except q: searches and AI deck
# recommendations works without it, and which model to pull is a decision the
# Settings page exists to make -- so this only reports.

Step 'Local model (optional)'

try {
    $tags = Invoke-RestMethod 'http://localhost:11434/api/tags' -TimeoutSec 5
    $names = @($tags.models.name)
    if ($names -contains 'llama3.3:70b') {
        Ok 'Ollama up, default model llama3.3:70b installed'
    } elseif ($names.Count) {
        Warn "Ollama is up with: $($names -join ', ')"
        Warn 'Pick one in Settings, or pull the default:  ollama pull llama3.3:70b'
    } else {
        Warn 'Ollama is up but has no models. Pull one:  ollama pull llama3.1:8b'
    }
} catch {
    Warn 'Ollama not detected on port 11434.'
    Warn 'Everything works except q: searches and AI recommendations.'
    Warn 'Install from ollama.com, then choose a size in Settings.'
}

# --- startup entry ---------------------------------------------------------

if ($Startup) {
    Step 'Startup entry'
    $tray = Join-Path $root 'tray\insight_tray.py'
    $pythonw = Join-Path $venv 'Scripts\pythonw.exe'
    if (-not (Test-Path $tray)) {
        Warn 'Tray script not found; skipping.'
    } else {
        # A Startup-folder shortcut rather than a Run registry value. Both were
        # tried; the shortcut is the one a user can see, disable in Task
        # Manager, and delete without regedit.
        $startupDir = [Environment]::GetFolderPath('Startup')
        $link = Join-Path $startupDir 'Insight Engine.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($link)
        $shortcut.TargetPath = $pythonw
        $shortcut.Arguments = "`"$tray`""
        $shortcut.WorkingDirectory = $root
        $shortcut.Description = 'Insight Engine tray'
        $shortcut.Save()
        Ok "Shortcut written to $link"
    }
}

# --- done ------------------------------------------------------------------

Say ''
Say '  Done.' 'Green'
Say ''
Say '  Start it with:   .\start.ps1' 'Gray'
Say '  Then open:       http://localhost:5173' 'Gray'
Say ''
Say '  The first run seeds a sample Commander deck so the Deck Lab,' 'DarkGray'
Say '  the charts and the playtester have something to be about.' 'DarkGray'
Say ''

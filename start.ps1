<#
.SYNOPSIS
    Start Insight Engine: checks prerequisites, then launches the API and web server.

.EXAMPLE
    .\start.ps1
    .\start.ps1 -NoBrowser      # don't open a browser window
    .\start.ps1 -SkipChecks     # skip the model/mirror preflight
    .\start.ps1 -Lan            # serve to the local network (see README)
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipChecks,
    [switch]$Lan
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = Join-Path $root 'server\.venv\Scripts\python.exe'
$db = Join-Path $root 'data\manafold.sqlite3'

function Say($msg, $colour = 'Gray') { Write-Host $msg -ForegroundColor $colour }
function Ok($msg) { Say "  [ok]   $msg" 'Green' }
function Warn($msg) { Say "  [warn] $msg" 'Yellow' }
function Die($msg) { Say "  [fail] $msg" 'Red'; exit 1 }

Say ''
Say '  INSIGHT ENIGMA' 'Cyan'
Say '  Magic: The Gathering search. Card data from Scryfall.' 'DarkGray'
Say ''

$bindHost = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
if ($Lan) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    Warn 'LAN mode: anyone on this network can search, edit saved decks and'
    Warn 'queue GPU work. There is no authentication. Do not port-forward it.'
    if ($ip) { Say "  Other machines: http://${ip}:5173" 'Cyan' }
    Say ''
}

# --- preflight -------------------------------------------------------------

if (-not (Test-Path $python)) {
    Die "No virtualenv. Run:  py -3.11 -m venv server\.venv; server\.venv\Scripts\python -m pip install -r server\requirements.txt"
}
Ok 'Python environment'

if (-not (Test-Path (Join-Path $root 'web\node_modules'))) {
    Die "Frontend dependencies missing. Run:  npm --prefix web install"
}
Ok 'Node dependencies'

if (-not $SkipChecks) {
    if (-not (Test-Path $db)) {
        Die "Card mirror not built. Run:  cd server; .venv\Scripts\python -m app.bulk"
    }
    $size = [math]::Round((Get-Item $db).Length / 1MB)
    Ok "Card mirror (${size} MB)"

    # Ollama is only needed for q: searches; everything else works without it.
    try {
        $tags = Invoke-RestMethod 'http://localhost:11434/api/tags' -TimeoutSec 5
        $model = if ($env:INSIGHT_OLLAMA_MODEL) { $env:INSIGHT_OLLAMA_MODEL } else { 'llama3.3:70b' }
        if ($tags.models.name -contains $model) {
            Ok "Ollama, $model loaded"
        } else {
            Warn "Ollama is up but '$model' is not installed - q: searches will fail."
            Warn "Install it with:  ollama pull $model"
        }
    } catch {
        Warn 'Ollama is not responding on port 11434.'
        Warn 'Everything works except q: searches. Start it with:  ollama serve'
    }
}

# --- launch ----------------------------------------------------------------

Say ''
Say '  Starting servers...' 'Cyan'

$api = Start-Process -PassThru -WindowStyle Minimized $python `
    -ArgumentList '-m', 'uvicorn', 'app.main:app', '--host', $bindHost, '--port', '8787' `
    -WorkingDirectory (Join-Path $root 'server')
Ok "API      http://localhost:8787   (pid $($api.Id))"

# Vite needs --host to listen on anything but loopback.
$webArgs = if ($Lan) { @('run', 'dev', '--', '--host') } else { @('run', 'dev') }
$web = Start-Process -PassThru -WindowStyle Minimized 'npm.cmd' `
    -ArgumentList $webArgs `
    -WorkingDirectory (Join-Path $root 'web')
Ok "Web      http://localhost:5173   (pid $($web.Id))"

# Wait for Vite to bind before opening a browser at a dead port.
$ready = $false
foreach ($attempt in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
        Invoke-WebRequest 'http://localhost:5173' -TimeoutSec 2 -UseBasicParsing | Out-Null
        $ready = $true
        break
    } catch { }
}

Say ''
if ($ready) {
    Say '  Ready.' 'Green'
    if (-not $NoBrowser) { Start-Process 'http://localhost:5173' }
} else {
    Warn 'Web server did not respond within 20s; check its window.'
}

Say ''
Say '  Try:   c:red t:creature mv<=3' 'DarkGray'
Say '         o:"Elf_creature"                 (wildcard)' 'DarkGray'
Say '         q:"cards that sacrifice for value"  (local model, ~8 min)' 'DarkGray'
Say ''
Say "  Stop with:  Stop-Process -Id $($api.Id),$($web.Id)" 'DarkGray'
Say ''

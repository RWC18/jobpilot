# Daily JobPilot run (for Windows Task Scheduler): starts the app if it isn't running, then one autopilot
# cycle: search, then auto-apply to the best new matches within the daily limits in Settings.
#   powershell -ExecutionPolicy Bypass -File tools\daily.ps1           # real run
#   powershell -ExecutionPolicy Bypass -File tools\daily.ps1 -DryRun   # fill forms of the top 3, send nothing
# Set JOBPILOT_NODE to a node.exe if Node.js isn't on PATH.
param([switch]$DryRun)

$root = Split-Path -Parent $PSScriptRoot
$node = if ($env:JOBPILOT_NODE) { $env:JOBPILOT_NODE } else { 'node' }
$base = 'http://127.0.0.1:4310'
$logFile = Join-Path $root 'data\daily.log'
New-Item -ItemType Directory -Force (Join-Path $root 'data') | Out-Null

function Log($message) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" | Add-Content -Path $logFile -Encoding utf8 }
function ServerUp { try { Invoke-RestMethod "$base/api/settings" -TimeoutSec 5 | Out-Null; $true } catch { $false } }

if (-not (ServerUp)) {
    Log 'Starting the JobPilot server'
    Start-Process -FilePath $node -ArgumentList 'src\server.cjs' -WorkingDirectory $root -WindowStyle Minimized
    for ($i = 0; $i -lt 30 -and -not (ServerUp); $i++) { Start-Sleep -Seconds 2 }
    if (-not (ServerUp)) { Log 'The server did not start'; exit 1 }
}

$body = @{ dryRun = [bool]$DryRun } | ConvertTo-Json
try {
    Invoke-RestMethod "$base/api/run-cycle" -Method Post -ContentType 'application/json' -Body $body | Out-Null
    Log $(if ($DryRun) { 'Started a dry-run cycle' } else { 'Started the daily cycle' })
} catch {
    Log "Could not start the cycle: $($_.Exception.Message)"
    exit 1
}

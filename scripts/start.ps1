# Windows: start the Cua daemon, run the preflight, open the panel and start the agent.
# Run from a normal (non-admin) PowerShell in this folder:  powershell -ExecutionPolicy Bypass -File scripts\start.ps1
Set-Location (Join-Path $PSScriptRoot "..")
& (Join-Path $PSScriptRoot "daemon.ps1")
bun src/preflight.ts
if ($LASTEXITCODE -ne 0) { Write-Output "Fix the FAIL lines above, then run this again."; exit 1 }
$env:OPEN_PANEL = "1"   # the app opens the panel once it is listening
bun src/main.ts

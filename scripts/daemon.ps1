# Start the Cua Driver daemon for this user (never as administrator). Safe to run twice.
#   -Restart   stop a running daemon first, so it picks up the tuning below (as the Mac version's daemon.sh does)
# Tuning (from the Mac version): CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=300 -> after an action, wait at most 300 ms for a
# new window instead of 1000 ms. The daemon only reads it when it starts, so it must be started by this script.
param([switch]$Restart)
$cd = Join-Path $env:LOCALAPPDATA "Programs\Cua\cua-driver\bin\cua-driver.exe"
if (-not (Test-Path $cd)) { Write-Error "cua-driver not installed: see BUILD-WINDOWS-AND-MAC.md section 3.2"; exit 1 }
$status = & $cd status 2>&1 | Out-String
if ($status -match "is running") {
    if (-not $Restart) { Write-Output "Cua daemon already running (scripts\daemon.ps1 -Restart restarts it with the speed tuning)"; exit 0 }
    & $cd stop 2>&1 | Out-Null
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not ((& $cd status 2>&1 | Out-String) -match "is running")) { break }
    }
    if ((& $cd status 2>&1 | Out-String) -match "is running") {
        # "stop" is not understood by every version: end the daemon's process (only cua-driver, only this user's)
        Get-Process -Name "cua-driver" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    if ((& $cd status 2>&1 | Out-String) -match "is running") { Write-Output "The Cua daemon did not stop: quit it from its tray icon, then run this again."; exit 1 }
}
$env:CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS = "300"
Start-Process -FilePath $cd -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 2
& $cd status
Write-Output "daemon tuned: window-change timeout 300 ms"

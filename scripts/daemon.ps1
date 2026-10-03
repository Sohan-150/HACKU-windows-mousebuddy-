# Start the Cua Driver daemon for this user (never as administrator). Safe to run twice.
$cd = Join-Path $env:LOCALAPPDATA "Programs\Cua\cua-driver\bin\cua-driver.exe"
if (-not (Test-Path $cd)) { Write-Error "cua-driver not installed: see BUILD-WINDOWS-AND-MAC.md section 3.2"; exit 1 }
$status = & $cd status 2>&1 | Out-String
if ($status -match "is running") { Write-Output "Cua daemon already running"; exit 0 }
Start-Process -FilePath $cd -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 2
& $cd status

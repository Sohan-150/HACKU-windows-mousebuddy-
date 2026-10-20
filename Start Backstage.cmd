@echo off
rem Backstage: double-click to start (Windows). Works in the Windows engine's folder, or at the root of the HackU repo
rem (it then starts windows\). It checks Bun, installs the packages the first time, makes .env from .env.example if
rem there is none, then runs scripts\start.ps1 (the Cua daemon, the preflight, the panel and the agent).
setlocal
title Backstage
cd /d "%~dp0"
if not exist "scripts\start.ps1" if exist "windows\scripts\start.ps1" cd /d "%~dp0windows"
if not exist "scripts\start.ps1" (
  echo Can't find scripts\start.ps1 next to this file. Keep this file in the Backstage folder.
  goto :end
)

rem Bun (its installer puts it here, which may not be on PATH yet in a new window)
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
where bun >nul 2>nul
if errorlevel 1 (
  echo Bun is not installed. Install it with this command in PowerShell, then double-click this file again:
  echo     powershell -c "irm bun.sh/install.ps1 | iex"
  goto :end
)

if not exist "node_modules\@anthropic-ai\sdk" (
  echo First start: installing packages...
  call bun install
  if errorlevel 1 ( echo bun install failed: see above. & goto :end )
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Made .env from .env.example. Put your TYPESAFE_API_KEY ^(and ANTHROPIC_API_KEY^) in it, save, close Notepad.
  start /wait notepad ".env"
)

echo Starting Backstage... the panel opens in your browser. Close this window to stop it.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\start.ps1"

:end
echo.
echo Backstage has stopped. Press any key to close this window.
pause >nul
endlocal

@echo off
cd /d "%~dp0"
if exist "runtimelectron.exe" (
  start "" "runtimelectron.exe" "app"
  exit /b
)
if exist "app
ode_moduleslectron\distlectron.exe" (
  start "" "app
ode_moduleslectron\distlectron.exe" "app"
  exit /b
)
echo Nova Heads is not set up yet.
echo  - Easiest: download NovaHeads-win-x64.zip from the GitHub Releases page.
echo  - Or install Node.js and run setup.bat
pause

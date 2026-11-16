@echo off
cd /d "%~dp0"
if exist "runtime\electron.exe" (
  start "" "runtime\electron.exe" "app"
  exit /b
)
if exist "app\node_modules\electron\dist\electron.exe" (
  start "" "app\node_modules\electron\dist\electron.exe" "app"
  exit /b
)
echo Nova StreamHub is not set up yet.
echo  - Easiest: download NovaStreamHub-win-x64.zip from the GitHub Releases page.
echo  - Or install Node.js and run setup.bat
pause

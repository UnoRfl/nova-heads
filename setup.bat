@echo off
cd /d "%~dp0app"
where npm >nul 2>nul || (
  echo Node.js is not installed. Get it from https://nodejs.org then run this again.
  echo Or skip all this: download NovaHeads-win-x64.zip from the Releases page.
  pause
  exit /b 1
)
echo Installing Electron (one time, about 100 MB)...
call npm install --no-audit --no-fund || (pause & exit /b 1)
cd /d "%~dp0"
echo Done! Starting Nova Heads...
call "Start Nova Heads.bat"

@echo off
cd /d "%~dp0app"
start "" "%~dp0app\node_modules\electron\dist\electron.exe" "%~dp0app"

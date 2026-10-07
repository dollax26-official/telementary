@echo off
cd /d "%~dp0"
if not exist "local-data" mkdir "local-data"
where node >nul 2>nul
if %errorlevel%==0 goto usenode
"C:\Program Files\nodejs\node.exe" "sync.js" >> "local-data\sync-log.txt" 2>&1
goto end
:usenode
node "sync.js" >> "local-data\sync-log.txt" 2>&1
:end

@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 goto usenode
"C:\Program Files\nodejs\node.exe" "sync.js"
goto end
:usenode
node "sync.js"
:end
echo.
pause

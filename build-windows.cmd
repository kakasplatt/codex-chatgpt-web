@echo off
rem Double-click to build the Codex Web GPT Windows installer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-windows.ps1"
set "BUILD_EXIT=%ERRORLEVEL%"
echo.
if not "%BUILD_EXIT%"=="0" echo Build failed with exit code %BUILD_EXIT%.
pause
exit /b %BUILD_EXIT%

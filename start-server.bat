@echo off
cd /d "%~dp0"

echo ========================================
echo   MUSIXQUARE Local Server
echo ========================================
echo.
echo Server running at: http://localhost:8080
echo Press Ctrl+C to stop.
echo.

py -3 -m http.server 8080
pause

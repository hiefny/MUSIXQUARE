@echo off
cd /d "%~dp0"

echo ========================================
echo   MUSIXQUARE Local Server
echo ========================================
echo.
echo Server running at: http://localhost:5173
echo Press Ctrl+C to stop.
echo.

py -3 -m http.server 5173
pause

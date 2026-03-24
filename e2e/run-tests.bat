@echo off
echo [MUSIXQUARE] Opening report viewer...
start "" "%~dp0report-viewer.html"
echo [MUSIXQUARE] Running E2E tests...
cd /d "%~dp0.."
call npm run test:e2e:report
echo.
echo [MUSIXQUARE] Done! Check the report in your browser.
pause

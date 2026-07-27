@echo off
cd /d "%~dp0.."
del /q "e2e-report.json" 2>nul
del /q "e2e\e2e-report-data.js" 2>nul
echo [MUSIXQUARE] Opening report viewer...
start "" "%~dp0report-viewer.html"
echo [MUSIXQUARE] Running E2E tests...
call npm run test:e2e:report
set "TEST_EXIT_CODE=%ERRORLEVEL%"
echo.
echo [MUSIXQUARE] Done! Check the report in your browser.
pause
exit /b %TEST_EXIT_CODE%

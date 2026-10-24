@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   CareerFlow -- Version Inventory
echo ============================================================
echo.

node scripts\version-manager.mjs list

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Inventory listing failed with exit code %EXIT_CODE%.
)

echo.
pause
exit /b %EXIT_CODE%

@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Progress Ledger -- Freeze Current Accepted Version
echo ============================================================
echo.

set "TAG=%~1"
set "DESC=%~2"

if "%TAG%"=="" (
    set /p "TAG=Enter version tag to freeze (or press Enter to auto-increment): "
)

if "%TAG%"=="" (
    node scripts\version-manager.mjs freeze
) else if not "%DESC%"=="" (
    node scripts\version-manager.mjs freeze %TAG% --desc "%DESC%"
) else (
    node scripts\version-manager.mjs freeze %TAG%
)

set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Freeze operation failed with exit code %EXIT_CODE%.
) else (
    echo.
    echo [SUCCESS] Freeze operation completed successfully.
)

echo.
pause
exit /b %EXIT_CODE%

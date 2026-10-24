@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   Progress Ledger -- Verify Version Integrity
echo ============================================================
echo.

set "TAG=%~1"
if "%TAG%"=="" (
    node scripts\version-manager.mjs list
    echo.
    set /p "TAG=Enter version tag to verify (e.g. v2): "
)

if "%TAG%"=="" (
    echo [ERROR] No version tag specified.
    set "EXIT_CODE=1"
    goto done
)

node scripts\version-manager.mjs verify %TAG%
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Verification failed with exit code %EXIT_CODE%.
) else (
    echo.
    echo [SUCCESS] Verification passed (100%% integrity confirmed).
)

:done
echo.
pause
exit /b %EXIT_CODE%

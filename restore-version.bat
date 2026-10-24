@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   CareerFlow -- Safe Version Restore / Rollback
echo ============================================================
echo.
echo NOTE: A safety backup of your current working workspace will
echo be automatically created and cryptographically verified before
echo any files are modified.
echo.

set "TAG=%~1"
if "%TAG%"=="" (
    node scripts\version-manager.mjs list
    echo.
    set /p "TAG=Enter version tag to restore (e.g. v2): "
)

if "%TAG%"=="" (
    echo [ERROR] No version tag specified.
    set "EXIT_CODE=1"
    goto done
)

echo.
echo Are you SURE you want to restore version "%TAG%" into your active workspace?
set /p "CONFIRM=Type YES to continue: "

if /i not "%CONFIRM%"=="YES" (
    echo [CANCELLED] Restore aborted by user.
    set "EXIT_CODE=0"
    goto done
)

node scripts\version-manager.mjs restore %TAG%
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Restore operation failed or was rolled back (exit code %EXIT_CODE%).
) else (
    echo.
    echo [SUCCESS] Workspace restored successfully.
)

:done
echo.
pause
exit /b %EXIT_CODE%

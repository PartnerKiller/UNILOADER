@echo off
title JAV ^& Universal Media Downloader
cd /d "%~dp0"

echo ========================================================
echo   JAV ^& Universal Media Downloader (Windows Desktop)
echo ========================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not found in PATH!
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules\electron (
    echo [INFO] Installing Electron runtime...
    call npm install electron --save-dev
)

echo [INFO] Launching Desktop Application...
call npx electron .

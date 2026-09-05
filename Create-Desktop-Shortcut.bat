@echo off
title Create Desktop Shortcut
cd /d "%~dp0"

echo Creating Windows Desktop Shortcut...

set SCRIPT="%TEMP%\%RANDOM%-%RANDOM%_shortcut.vbs"
set TARGET_DIR=%~dp0
set VBS_TARGET=%TARGET_DIR%JAV-Downloader.vbs
set ICON_TARGET=%TARGET_DIR%public\favicon.ico

echo Set oWS = WScript.CreateObject("WScript.Shell") >> %SCRIPT%
echo sLinkFile = oWS.SpecialFolders("Desktop") ^& "\JAV Downloader.lnk" >> %SCRIPT%
echo Set oLink = oWS.CreateShortcut(sLinkFile) >> %SCRIPT%
echo oLink.TargetPath = "wscript.exe" >> %SCRIPT%
echo oLink.Arguments = """%VBS_TARGET%""" >> %SCRIPT%
echo oLink.WorkingDirectory = "%TARGET_DIR%" >> %SCRIPT%
echo oLink.Description = "JAV & Universal Media Downloader" >> %SCRIPT%
if exist "%ICON_TARGET%" (
    echo oLink.IconLocation = "%ICON_TARGET%" >> %SCRIPT%
)
echo oLink.Save >> %SCRIPT%

cscript /nologo %SCRIPT%
del %SCRIPT%

echo.
echo ========================================================
echo   [SUCCESS] Shortcut created on your Windows Desktop!
echo   You can now launch "JAV Downloader" from your Desktop!
echo ========================================================
echo.

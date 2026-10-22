@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Build-Android.ps1" %*
if errorlevel 1 exit /b 1

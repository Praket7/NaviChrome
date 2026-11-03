@echo off
if /i "%~1"=="mcp" goto compact
"%~dp0navichrome-core.exe" %*
exit /b %errorlevel%
:compact
"%~dp0navichrome-v2-core.exe" %*
exit /b %errorlevel%

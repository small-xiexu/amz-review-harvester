@echo off
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"

if exist "%CHROME%" (
  start "" "%CHROME%" "chrome://extensions"
  exit /b 0
)

if exist "%EDGE%" (
  start "" "%EDGE%" "edge://extensions"
  exit /b 0
)

start "" "edge://extensions"

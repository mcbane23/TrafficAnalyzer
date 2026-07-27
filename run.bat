@echo off
REM Builds TrafficAnalyzer, starts the server, and opens it in a browser.
REM
REM Usage:
REM   run.bat                 -> build, start server, open in default browser
REM   run.bat chrome           -> open in Chrome instead of the default browser
REM   run.bat msedge           -> open in Edge
REM   run.bat firefox          -> open in Firefox
REM   run.bat "C:\path\to\browser.exe"  -> open with a specific executable
REM
REM The browser argument is passed straight to the Windows `start` command,
REM so any value that works with `start "" <value> <url>` is accepted.

setlocal enabledelayedexpansion

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "BROWSER=%~1"
set "PORT=3001"
set "URL=http://localhost:%PORT%"

echo.
echo === Building TrafficAnalyzer (server + web) ===
call npm run build
if errorlevel 1 (
    echo.
    echo Build failed. Aborting.
    exit /b 1
)

echo.
echo === Starting server on %URL% ===
start "TrafficAnalyzer Server" cmd /k "npm start"

echo.
echo Waiting for the server to become ready...
set "READY=0"
set "STATUS_FILE=%TEMP%\trafficanalyzer_status.txt"

for /l %%i in (1,1,30) do (
    curl -s -o NUL -w "%%{http_code}" "%URL%/api/cameras" > "!STATUS_FILE!" 2>nul
    set /p STATUS=<"!STATUS_FILE!"
    if "!STATUS!"=="200" (
        set "READY=1"
        goto :server_ready
    )
    timeout /t 1 /nobreak >nul
)

:server_ready
if exist "!STATUS_FILE!" del "!STATUS_FILE!" >nul 2>nul

if "!READY!"=="0" (
    echo Server did not respond within 30 seconds - opening the browser anyway.
) else (
    echo Server is ready.
)

echo.
if "%BROWSER%"=="" (
    echo Opening default browser at %URL% ...
    start "" "%URL%"
) else (
    echo Opening "%BROWSER%" at %URL% ...
    start "" "%BROWSER%" "%URL%"
)

endlocal

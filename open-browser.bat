@echo off
REM Helper used by run.bat: waits for the server to respond, then opens a
REM browser at the given URL. Runs detached in the background (started via
REM `start /b`) so it never opens its own window and doesn't block run.bat
REM from running the server in the foreground.
REM
REM Usage: open-browser.bat <url> [browser]

setlocal enabledelayedexpansion

set "URL=%~1"
set "BROWSER=%~2"

set "READY=0"
set "STATUS_FILE=%TEMP%\trafficanalyzer_status_%RANDOM%.txt"

for /l %%i in (1,1,30) do (
    curl -s -o NUL -w "%%{http_code}" "%URL%/api/cameras" > "!STATUS_FILE!" 2>nul
    set /p STATUS=<"!STATUS_FILE!"
    if "!STATUS!"=="200" (
        set "READY=1"
        goto :ready
    )
    timeout /t 1 /nobreak >nul
)

:ready
if exist "!STATUS_FILE!" del "!STATUS_FILE!" >nul 2>nul

if "!READY!"=="0" (
    echo Server did not respond within 30 seconds - opening the browser anyway.
) else (
    echo Server is ready.
)

if "%BROWSER%"=="" (
    start "" "%URL%"
) else (
    start "" "%BROWSER%" "%URL%"
)

endlocal

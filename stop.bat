@echo off
REM Force-stops the TrafficAnalyzer server, in case run.bat's window was
REM closed (X button, closed terminal, etc.) instead of stopped with Ctrl+C,
REM or the server was started some other way (e.g. `npm start` directly).
REM
REM It finds whatever process is LISTENING on the server's port and kills it
REM (and its child processes), rather than assuming a particular window
REM title or process name. Safe to run even if nothing is running.
REM
REM Usage: stop.bat

setlocal enabledelayedexpansion

set "PORT=3001"
set "FOUND=0"

echo Looking for a process listening on port %PORT% ...

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    set "PID=%%p"
    if not "!PID!"=="0" (
        echo Stopping process !PID! ^(and its child processes^) ...
        taskkill /F /T /PID !PID! >nul 2>nul
        if !errorlevel! == 0 (
            set "FOUND=1"
        )
    )
)

if "!FOUND!"=="0" (
    echo No process found listening on port %PORT%. Nothing to stop.
) else (
    echo Done.
)

endlocal

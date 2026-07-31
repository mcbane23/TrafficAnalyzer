@echo off
REM Builds TrafficAnalyzer and starts the server in THIS window (single
REM process, foreground) so it's easy to stop: press Ctrl+C here, or close
REM the window. If it ever gets left running detached (e.g. window closed
REM without Ctrl+C), run stop.bat to force-kill it.
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

REM Wait for the server to come up and open the browser, in a detached
REM background helper (no window of its own) so it doesn't block this
REM window from running the server itself in the foreground below.
REM NOTE: open-browser.bat is a script, not a native exe, so it must be run
REM via an explicit "cmd /c" - handing a bare .bat path to "start /b" relies
REM on file-association ShellExecute, which can mis-parse the quoted path
REM and throw "The filename, directory name, or volume label syntax is
REM incorrect." (harmless, but noisy).
start "" /b cmd /c call "%ROOT%open-browser.bat" "%URL%" "%BROWSER%"

echo.
echo === Starting server on %URL% ===
echo Press Ctrl+C to stop the server (or run stop.bat from another window).
echo.
call npm start

endlocal

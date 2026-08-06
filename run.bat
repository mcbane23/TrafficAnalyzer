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
REM
REM Dependencies are installed automatically on a fresh clone, and afterwards
REM only when they've actually changed - see the freshness check below.

setlocal enabledelayedexpansion

REM Switch to the project root before doing anything else. run.bat is often
REM launched from somewhere else (a shortcut, another drive, an editor's
REM terminal), and every step below - install, build, start - has to act on
REM this project rather than on whatever directory happened to be current.
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "BROWSER=%~1"
set "PORT=3001"
set "URL=http://localhost:%PORT%"

REM Node has to be on PATH before anything else is attempted. A freshly
REM installed or upgraded Node is invisible to windows that were already open,
REM because Windows only hands the updated PATH to processes started
REM afterwards - so say that plainly here instead of letting npm fail several
REM lines later with a bare "not recognized".
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Node.js was not found on PATH.
    echo.
    echo If you just installed or upgraded Node, close this window - along with
    echo any editor or terminal that was already open - and try again. Running
    echo programs keep the PATH they were started with.
    echo.
    echo Otherwise install Node 22.12 or newer, 64-bit: https://nodejs.org/
    exit /b 1
)

REM Only install when node_modules is missing or older than the manifests.
REM A full "npm install" on every launch costs seconds each time, and
REM better-sqlite3 ships no prebuilt binary - so a needless reinstall can kick
REM off a native compile that requires Python and the MSVC build tools.
REM npm rewrites node_modules\.package-lock.json on every install, which makes
REM its timestamp a reliable "last installed" marker; a missing node_modules
REM reads as timestamp 0 and therefore as out of date. Delete node_modules to
REM force a clean reinstall.
set "NEED_INSTALL="
node -e "const fs=require('fs');const m=p=>{try{return fs.statSync(p).mtimeMs}catch(e){return 0}};const s=m('node_modules/.package-lock.json');process.exit(s>0 && s>=m('package.json') && s>=m('package-lock.json') ? 0 : 1)"
if errorlevel 1 set "NEED_INSTALL=1"

if defined NEED_INSTALL (
    echo.
    echo === Installing dependencies ===
    call npm install
    if errorlevel 1 (
        echo.
        echo Dependency install failed. Aborting.
        echo.
        echo If it failed while building better-sqlite3: that package publishes
        echo no prebuilt binary, so it is compiled from source and needs both
        echo Python 3 and the Visual Studio Build Tools with the
        echo "Desktop development with C++" workload installed.
        exit /b 1
    )
) else (
    echo Dependencies are up to date - skipping install.
)

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

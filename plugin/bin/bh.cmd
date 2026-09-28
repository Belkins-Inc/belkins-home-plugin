@echo off
rem bh for Windows: cmd and PowerShell run this, Git Bash runs bin/bh. The same lookup as bin/bh:
rem BH_CLI, else plugin/cli/cli.ts in the published plugin, else packages/bh in the platform clone.
setlocal
set "plugin=%~dp0.."
if defined BH_CLI (set "cli=%BH_CLI%" & goto found)
if exist "%plugin%\cli\cli.ts" (set "cli=%plugin%\cli\cli.ts" & goto found)
set "cli=%plugin%\..\packages\bh\src\cli.ts"
:found
if exist "%cli%" goto node
echo bh: no CLI at "%cli%" 1>&2
echo hint: install the plugin from Belkins-Inc/belkins-home-plugin, or set BH_CLI to a CLI 1>&2
exit /b 2

:node
where node >nul 2>nul
if not errorlevel 1 goto version
echo bh: node is not installed 1>&2
echo hint: bh runs on Node 24 or newer - winget install OpenJS.NodeJS.LTS 1>&2
exit /b 2

:version
for /f "tokens=1 delims=." %%v in ('node -v') do set "major=%%v"
set "major=%major:v=%"
if %major% GEQ 24 goto run
echo bh: Node v%major% is too old 1>&2
echo hint: the CLI is TypeScript run as it is; Node 24 or newer strips the types 1>&2
exit /b 2

:run
node "%cli%" %*
exit /b %errorlevel%

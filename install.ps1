# Sets up Belkins Home on Windows, with no WSL. In PowerShell:
#
#   irm https://raw.githubusercontent.com/Belkins-Inc/belkins-home-plugin/main/install.ps1 | iex
#
# Installs what is missing (Node 24+, Git, Claude Code), then the plugin, puts bh on the PATH, copies
# the working directory to ~\work\belkins-home and, in a console, connects bh through a link to
# approve in the browser. Every step checks first, so running it again only finishes what is left.
$ErrorActionPreference = 'Stop'

$Marketplace = Join-Path $HOME '.claude\plugins\marketplaces\belkins-home'
$Workspace = Join-Path $HOME 'work\belkins-home'

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    (Join-Path $HOME '.local\bin')
  ) -join ';'
}
function Winget($id) {
  if (-not (Have winget)) {
    throw "winget is missing: install 'App Installer' from the Microsoft Store, then run this again"
  }
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
function Node-Major {
  if (-not (Have node)) { return 0 }
  if ((node -v) -match '^v(\d+)') { return [int]$Matches[1] }
  return 0
}

Step 'Node 24 or newer'
if ((Node-Major) -lt 24) { Winget 'OpenJS.NodeJS.LTS' }
if ((Node-Major) -lt 24) {
  throw "node on the PATH is still $(node -v): remove the old Node, open a new PowerShell and run this again"
}

Step 'Git'
if (-not (Have git)) { Winget 'Git.Git' }

Step 'Claude Code'
if (-not (Have claude)) {
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  Refresh-Path
}
if (-not (Have claude)) { throw 'claude is not on the PATH: open a new PowerShell and run this again' }

Step 'The belkins-home plugin'
if (Test-Path $Marketplace) {
  claude plugin marketplace update belkins-home
} else {
  claude plugin marketplace add Belkins-Inc/belkins-home-plugin
}
claude plugin install belkins-home@belkins-home
$Bin = Join-Path $Marketplace 'plugin\bin'
if (-not (Test-Path (Join-Path $Bin 'bh.cmd'))) { throw "the plugin did not install: no $Bin\bh.cmd" }

Step 'bh on the PATH'
$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($UserPath -split ';') -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable('Path', (@($UserPath, $Bin) | Where-Object { $_ }) -join ';', 'User')
}
Refresh-Path

Step 'The working directory'
if (-not (Test-Path (Join-Path $Workspace 'CLAUDE.md'))) {
  New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
  Copy-Item -Recurse -Force (Join-Path $Marketplace 'workspace\*') $Workspace
}

Step 'Connect bh to your account'
# cmd swallows the output: Windows PowerShell would turn a native command's redirected stderr into
# an error that stops the script.
cmd /c 'bh whoami >nul 2>&1'
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Already connected.'
} elseif ([Console]::IsOutputRedirected) {
  Write-Host 'Run "bh login" to connect.'
} else {
  bh login
  if ($LASTEXITCODE -ne 0) { throw 'bh login did not finish: run "bh login" again' }
}

Write-Host ''
Write-Host "Done. Open Claude Code in $Workspace and name the client in your first message." -ForegroundColor Green

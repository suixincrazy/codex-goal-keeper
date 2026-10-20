param([string]$NodePath, [string]$CodexPath, [switch]$SkipMarketplace)
$ErrorActionPreference = 'Stop'
$keeperHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$keeperData = Join-Path $keeperHome 'goal-keeper'
New-Item -ItemType Directory -Path $keeperData -Force | Out-Null

if (-not $CodexPath) { $CodexPath = $env:CODEX_CLI_PATH }
if (-not $CodexPath) {
    $keeperCli = Get-Command codex -ErrorAction SilentlyContinue
    if ($keeperCli) { $CodexPath = $keeperCli.Source }
}
if (-not $CodexPath) {
    $keeperBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $CodexPath = (Get-ChildItem -LiteralPath $keeperBin -Directory | ForEach-Object { Join-Path $_.FullName 'codex.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -Last 1)
}
if (-not $CodexPath) { throw 'Codex desktop CLI was not found.' }
if (-not $NodePath) { $NodePath = $env:CODEX_MCP_NODE_PATH }
if (-not $NodePath) {
    $keeperNodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($keeperNodeCommand) { $NodePath = $keeperNodeCommand.Source }
}
if (-not $NodePath) { throw 'Node.js 24 or newer is required.' }
$keeperVersion = & $NodePath --version
if ([int]($keeperVersion.TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node.js 24 or newer is required.' }
$env:CODEX_CLI_PATH = $CodexPath
$keeperConfig = Join-Path $keeperHome 'config.toml'
if (Test-Path -LiteralPath $keeperConfig) {
    Copy-Item -LiteralPath $keeperConfig -Destination (Join-Path $keeperData ('config-backup-{0}.toml' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) -Force
}

if (-not $SkipMarketplace) {
    & $CodexPath plugin marketplace add suixincrazy/codex-goal-keeper --ref main --json
    if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed.' }
}
$keeperInstallText = & $CodexPath plugin add codex-goal-keeper@goal-keeper --json
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
$keeperInstall = ($keeperInstallText -join "`n") | ConvertFrom-Json
$keeperInstallText | Write-Output
$keeperRoot = $keeperInstall.installedPath
if (-not $keeperRoot) { $keeperRoot = $keeperInstall.pluginRoot }
if (-not $keeperRoot) { $keeperRoot = $keeperInstall.installedRoot }
if (-not $keeperRoot) {
    $keeperCache = Join-Path $keeperHome 'plugins\cache\goal-keeper\codex-goal-keeper'
    $keeperRoot = (Get-ChildItem -LiteralPath $keeperCache -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $keeperRoot -or -not (Test-Path -LiteralPath (Join-Path $keeperRoot 'src\cli.mjs'))) { throw 'Installed plugin files were not found.' }

$keeperEntry = Join-Path $keeperRoot 'src\cli.mjs'
& $NodePath $keeperEntry runtime
if ($LASTEXITCODE -ne 0) { throw 'Could not save local runtime settings.' }
$keeperMcpPath = Join-Path $keeperRoot '.mcp.json'
$keeperMcp = Get-Content -LiteralPath $keeperMcpPath -Raw | ConvertFrom-Json
$keeperMcp.mcpServers.goal_keeper.command = $NodePath
$keeperMcp.mcpServers.goal_keeper.args = @((Join-Path $keeperRoot 'src\mcp.mjs'))
[System.IO.File]::WriteAllText($keeperMcpPath, ($keeperMcp | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
$keeperShell = New-Object -ComObject WScript.Shell
$keeperStartup = [Environment]::GetFolderPath('Startup')
$keeperShortcut = $keeperShell.CreateShortcut((Join-Path $keeperStartup 'Codex Goal Keeper.lnk'))
$keeperShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$keeperShortcut.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $keeperRoot 'scripts\launch.ps1')
$keeperShortcut.WorkingDirectory = $keeperData
$keeperShortcut.WindowStyle = 7
$keeperShortcut.Description = 'Start Codex Goal Keeper'
$keeperShortcut.Save()

Start-Process -FilePath $NodePath -ArgumentList @(('"{0}"' -f $keeperEntry), 'serve') -WindowStyle Hidden
& $NodePath $keeperEntry status
if ($LASTEXITCODE -ne 0) { throw 'Plugin is installed but its local service did not start.' }

param([string]$NodePath, [string]$CodexPath)
$ErrorActionPreference = 'Stop'
$keeperHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$keeperData = Join-Path $keeperHome 'goal-keeper'
$keeperRuntime = Get-Content -LiteralPath (Join-Path $keeperData 'runtime.json') -Raw | ConvertFrom-Json
if (-not $NodePath) { $NodePath = $keeperRuntime.node }
if (-not $CodexPath) { $CodexPath = $env:CODEX_CLI_PATH }
if (-not $CodexPath) { $CodexPath = $keeperRuntime.codex }
& $NodePath (Join-Path $keeperRuntime.root 'src\cli.mjs') stop
Start-Sleep -Milliseconds 400
& $CodexPath plugin marketplace upgrade goal-keeper --json
if ($LASTEXITCODE -ne 0) { throw 'Marketplace update failed.' }
& (Join-Path $PSScriptRoot 'install.ps1') -NodePath $NodePath -CodexPath $CodexPath -SkipMarketplace

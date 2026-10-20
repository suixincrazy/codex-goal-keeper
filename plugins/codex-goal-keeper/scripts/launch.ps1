$ErrorActionPreference = 'Stop'
$keeperHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$keeperData = Join-Path $keeperHome 'goal-keeper'
$keeperRuntimeFile = Join-Path $keeperData 'runtime.json'
if (-not (Test-Path -LiteralPath $keeperRuntimeFile)) { exit 1 }
$keeperRuntime = Get-Content -LiteralPath $keeperRuntimeFile -Raw | ConvertFrom-Json
$keeperCurrentRoot = Split-Path -Parent $PSScriptRoot
if ($keeperRuntime.root -ne $keeperCurrentRoot) { $keeperRuntime.root = $keeperCurrentRoot }
$keeperEntry = Join-Path $keeperRuntime.root 'src\cli.mjs'
if (-not (Test-Path -LiteralPath $keeperEntry) -or -not (Test-Path -LiteralPath $keeperRuntime.node)) { exit 1 }
$env:GOAL_KEEPER_DATA_DIR = $keeperData
$env:CODEX_CLI_PATH = $keeperRuntime.codex
Start-Process -FilePath $keeperRuntime.node -ArgumentList @(('"{0}"' -f $keeperEntry), 'serve') -WindowStyle Hidden

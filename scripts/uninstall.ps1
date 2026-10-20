$ErrorActionPreference = 'Stop'
$keeperHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$keeperData = Join-Path $keeperHome 'goal-keeper'
$keeperRuntimeFile = Join-Path $keeperData 'runtime.json'
if (Test-Path -LiteralPath $keeperRuntimeFile) {
    $keeperRuntime = Get-Content -LiteralPath $keeperRuntimeFile -Raw | ConvertFrom-Json
    & $keeperRuntime.node (Join-Path $keeperRuntime.root 'src\cli.mjs') stop
    Start-Sleep -Milliseconds 400
    & $keeperRuntime.codex mcp remove goal_keeper
    & $keeperRuntime.codex plugin remove codex-goal-keeper@goal-keeper
}
$keeperShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Goal Keeper.lnk'
if (Test-Path -LiteralPath $keeperShortcut) { Remove-Item -LiteralPath $keeperShortcut -Force }
Write-Output 'Goal Keeper stopped and uninstalled. Local switch settings and config backups were retained.'

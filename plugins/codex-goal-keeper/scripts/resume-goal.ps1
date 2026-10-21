$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Reply([string]$Status) {
    [Console]::WriteLine((@{ status = $Status } | ConvertTo-Json -Compress))
}

function Normalized([string]$Text) {
    return [regex]::Replace($Text, '\s+', ' ').Trim()
}

function SettingsUnchanged {
    if (-not $keeperRequest.settingsFile) { return $true }
    if (-not (Test-Path -LiteralPath $keeperRequest.settingsFile)) { return $null -eq $keeperRequest.settingsHash }
    $keeperHash = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($keeperRequest.settingsFile)
        $actual = ([BitConverter]::ToString($keeperHash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        return $actual -eq $keeperRequest.settingsHash
    } finally { $keeperHash.Dispose() }
}

try {
    $keeperRequest = [Console]::ReadLine() | ConvertFrom-Json
    if (-not $keeperRequest.title -or -not $keeperRequest.objective) { Reply 'unavailable'; exit }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $keeperTitle = Normalized $keeperRequest.title
    $keeperObjective = Normalized $keeperRequest.objective
    $keeperResumeNames = '["Resume goal","\u6062\u590d\u76ee\u6807","\u7ee7\u7eed\u76ee\u6807"]' | ConvertFrom-Json
    $keeperStalledNames = '["Goal stalled","Stalled goal","\u76ee\u6807\u5df2\u505c\u6ede","\u5df2\u505c\u6ede\u7684\u76ee\u6807"]' | ConvertFrom-Json
    $keeperDocuments = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document)
    $keeperButtons = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button)
    $keeperWalker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $keeperButton = $null
    $keeperDocument = $null
    $keeperSummary = $null
    $keeperDeadline = [DateTime]::UtcNow.AddSeconds(4)
    do {
        $keeperProcesses = if ($keeperRequest.processId) {
            @(Get-Process -Id $keeperRequest.processId -ErrorAction SilentlyContinue)
        } else {
            @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Where-Object {
                $_.MainWindowHandle -ne 0 -and $_.Path -match '\\OpenAI\.Codex_[^\\]+\\app\\'
            })
        }
        foreach ($keeperProcess in $keeperProcesses) {
            if ($keeperProcess.MainWindowHandle -eq 0) { continue }
            $keeperWindow = [System.Windows.Automation.AutomationElement]::FromHandle($keeperProcess.MainWindowHandle)
            foreach ($document in $keeperWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, $keeperDocuments)) {
                $documentTitle = Normalized $document.Current.Name
                $prefix = $documentTitle.TrimEnd([char]0x2026)
                if ($documentTitle -ne $keeperTitle -and -not ($documentTitle.EndsWith([char]0x2026) -and $prefix.Length -ge 24 -and $keeperTitle.StartsWith($prefix))) { continue }
                foreach ($button in $document.FindAll([System.Windows.Automation.TreeScope]::Descendants, $keeperButtons)) {
                    if ($button.Current.Name -notin $keeperResumeNames -or -not $button.Current.IsEnabled) { continue }
                    $ancestor = $keeperWalker.GetParent($button)
                    for ($level = 0; $level -lt 4 -and $null -ne $ancestor; $level++) {
                        foreach ($summary in $ancestor.FindAll([System.Windows.Automation.TreeScope]::Descendants, $keeperButtons)) {
                            $summaryName = Normalized $summary.Current.Name
                            $stalled = @($keeperStalledNames | Where-Object { $summaryName.StartsWith($_) }).Count -gt 0
                            if ($stalled -and $summaryName.Contains($keeperObjective)) {
                                $keeperButton = $button
                                $keeperDocument = $document
                                $keeperSummary = $summary
                                break
                            }
                        }
                        if ($keeperButton) { break }
                        $ancestor = $keeperWalker.GetParent($ancestor)
                    }
                    if ($keeperButton) { break }
                }
                if ($keeperButton) { break }
            }
            if ($keeperButton) { break }
        }
        if (-not $keeperButton) { Start-Sleep -Milliseconds 100 }
    } while (-not $keeperButton -and [DateTime]::UtcNow -lt $keeperDeadline)
    if (-not $keeperButton) { Reply 'unavailable'; exit }
    $keeperPattern = $keeperButton.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    Reply 'ready'
    $keeperAction = [Console]::ReadLine()
    if ($keeperAction -eq 'inspect') { Reply 'available'; exit }
    if ($keeperAction -ne 'invoke' -or -not (SettingsUnchanged)) { Reply 'cancelled'; exit }
    if (-not $keeperButton.Current.IsEnabled -or $keeperButton.Current.Name -notin $keeperResumeNames -or (Normalized $keeperDocument.Current.Name) -ne $documentTitle) { Reply 'cancelled'; exit }
    $summaryName = Normalized $keeperSummary.Current.Name
    if (-not $summaryName.Contains($keeperObjective) -or @($keeperStalledNames | Where-Object { $summaryName.StartsWith($_) }).Count -eq 0) { Reply 'cancelled'; exit }
    $keeperPattern.Invoke()
    Reply 'clicked'
} catch {
    Reply 'unavailable'
}

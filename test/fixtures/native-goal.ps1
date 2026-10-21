$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -ReferencedAssemblies PresentationFramework, PresentationCore, WindowsBase, System.Xaml -TypeDefinition @'
using System.Collections.Generic;
using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Controls;

public sealed class GoalDocument : StackPanel {
    protected override AutomationPeer OnCreateAutomationPeer() { return new GoalDocumentPeer(this); }
}
public sealed class GoalDocumentPeer : FrameworkElementAutomationPeer {
    public GoalDocumentPeer(GoalDocument owner) : base(owner) { }
    protected override AutomationControlType GetAutomationControlTypeCore() { return AutomationControlType.Document; }
    protected override string GetNameCore() { return "Goal Keeper regression fixture"; }
    protected override List<AutomationPeer> GetChildrenCore() {
        var peers = new List<AutomationPeer>();
        foreach (UIElement child in ((GoalDocument)Owner).Children) {
            var peer = UIElementAutomationPeer.CreatePeerForElement(child);
            if (peer != null) peers.Add(peer);
        }
        return peers;
    }
}
'@
$keeperWindow = [System.Windows.Window]::new()
$keeperWindow.Title = 'Goal Keeper regression fixture'
$keeperWindow.ShowInTaskbar = $true
$keeperWindow.ShowActivated = $false
$keeperWindow.Opacity = 0
$keeperWindow.Width = 420
$keeperWindow.Height = 160
$keeperDocument = [GoalDocument]::new()
$keeperSummary = [System.Windows.Controls.Button]::new()
$keeperSummary.Content = 'Goal stalled Verify native goal continuation'
$keeperResume = [System.Windows.Controls.Button]::new()
$keeperResume.Content = 'Resume goal'
$keeperResume.Add_Click({ [Console]::WriteLine('{"event":"clicked"}') })
$keeperDocument.Children.Add($keeperSummary) | Out-Null
$keeperDocument.Children.Add($keeperResume) | Out-Null
$keeperWindow.Content = $keeperDocument
$keeperWindow.Add_ContentRendered({ [Console]::WriteLine((@{ event = 'ready'; pid = $PID } | ConvertTo-Json -Compress)) })
$keeperWindow.ShowDialog() | Out-Null

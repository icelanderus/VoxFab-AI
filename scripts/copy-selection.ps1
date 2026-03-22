# Copy Selection Helper Script
# Focuses a target window by handle, then sends Ctrl+C to copy highlighted text

param([string]$TargetHandle = "0")

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CopyHelper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

$handle = [IntPtr]::new([long]$TargetHandle)

if ($handle -ne [IntPtr]::Zero) {
    # Focus the target window
    [CopyHelper]::SetForegroundWindow($handle) | Out-Null
    # Wait for focus to switch
    Start-Sleep -Milliseconds 250
}

# Send Ctrl+C
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^c")
# Small delay to ensure clipboard updates
Start-Sleep -Milliseconds 100

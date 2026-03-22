# Window Monitor Script
# Continuously monitors the foreground window and outputs its handle
# Filters out the Voice To Text app window

param([int]$ExcludeHandle = 0)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMonitor {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

$excludePtr = [IntPtr]$ExcludeHandle

while ($true) {
    $h = [WinMonitor]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero -and $h -ne $excludePtr) {
        Write-Output "HANDLE:$h"
        [Console]::Out.Flush()
    }
    Start-Sleep -Milliseconds 300
}

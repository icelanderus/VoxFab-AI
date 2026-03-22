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
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@

$excludePtr = [IntPtr]$ExcludeHandle

while ($true) {
    $h = [WinMonitor]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero -and $h -ne $excludePtr) {
        $procId = [uint32]0
        [WinMonitor]::GetWindowThreadProcessId($h, [ref]$procId)
        $process = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($process) {
            $name = $process.ProcessName
            if ($name -ne "Voice To Text") {
                Write-Output "HANDLE:$h NAME:$name"
                [Console]::Out.Flush()
            }
        }
    }
    Start-Sleep -Milliseconds 300
}

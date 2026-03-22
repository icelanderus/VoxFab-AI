# Create Shortcut with Icon
# Parameters: TargetPath, IconPath, ShortcutName, Arguments

param(
    [string]$TargetPath,
    [string]$IconPath,
    [string]$ShortcutPath,
    [string]$Arguments = ""
)

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.Arguments = $Arguments
$Shortcut.WorkingDirectory = Split-Path -Parent $TargetPath
$Shortcut.IconLocation = $IconPath
$Shortcut.Save()

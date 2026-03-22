# Convert PNG to ICO
# Parameters: InputPath, OutputPath

param(
    [string]$InputPath,
    [string]$OutputPath
)

Add-Type -AssemblyName System.Drawing
$bitmap = [System.Drawing.Bitmap]::FromFile($InputPath)
$hIcon = $bitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)

$fileStream = New-Object System.IO.FileStream($OutputPath, [System.IO.FileMode]::Create)
$icon.Save($fileStream)
$fileStream.Close()

$icon.Dispose()
$bitmap.Dispose()

# Cleanup
$win32 = Add-Type -MemberDefinition @"
[DllImport("user32.dll", CharSet = CharSet.Auto)]
public static extern bool DestroyIcon(IntPtr handle);
"@ -Name "Win32" -Namespace "Win32" -PassThru
$win32::DestroyIcon($hIcon)

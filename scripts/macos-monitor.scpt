-- macOS Window Monitor Script
-- Periodically outputs the frontmost app name to STDOUT (not `log`, which goes to stderr).
-- Skips this app so we keep the last external target for paste (same idea as Windows ExcludeHandle).

on run
    repeat
        try
            tell application "System Events"
                set frontProcess to first process whose frontmost is true
                set processName to name of frontProcess
            end tell
            if processName is not "Electron" and processName is not "Voice To Text" then
                -- Must use `log` so osascript writes to stderr; `do shell script` only returns to AppleScript (stdout stayed empty and Node never saw updates).
                log processName
            end if
        on error
            -- Ignore errors (e.g., if no process is frontmost)
        end try
        delay 0.5
    end repeat
end run

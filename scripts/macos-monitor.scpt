-- macOS Window Monitor Script
-- Periodically outputs the name of the frontmost application
-- This script is designed to be run via osascript and its output read by Electron

on run
    repeat
        try
            tell application "System Events"
                set frontProcess to first process whose frontmost is true
                set processName to name of frontProcess
                log processName
            end tell
        on error
            -- Ignore errors (e.g., if no process is frontmost)
        end try
        delay 0.5
    end repeat
end run

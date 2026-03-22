-- macOS Paste Helper Script
-- Receives a target application name as an argument, activates it, and sends Command+V

on run {targetApp}
    if targetApp is not "" then
        try
            tell application targetApp to activate
            delay 0.2
            tell application "System Events"
                keystroke "v" using command down
            end tell
        on error
            -- Fallback: If focus fails, just try to send the keystroke
            tell application "System Events"
                keystroke "v" using command down
            end tell
        end try
    else
        -- No target app specified, just try to paste
        tell application "System Events"
            keystroke "v" using command down
        end tell
    end if
end run

-- Bring a process to the foreground (by System Events name). Used before sending Cmd+V from the main app.

on run argv
	if (count of argv) < 1 then error "Missing paste target (process name)"
	set targetProc to item 1 of argv as text
	if targetProc is "" then error "Empty paste target — focus the app where text should go, then try again"

	tell application "System Events"
		if not (exists process targetProc) then error "Process not found: " & targetProc
		tell process targetProc
			set frontmost to true
		end tell
	end tell
end run

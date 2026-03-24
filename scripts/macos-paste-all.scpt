-- Single osascript run: focus target process + Cmd+V (child processes cannot read paths inside app.asar; keep scripts unpacked).
on run argv
	if (count of argv) < 1 then error "Missing paste target (process name)"
	set targetProc to item 1 of argv as text
	if targetProc is "" then error "Empty paste target"

	tell application "System Events"
		if not (exists process targetProc) then error "Process not found: " & targetProc
		tell process targetProc
			set frontmost to true
		end tell
		delay 0.7
		keystroke "v" using command down
	end tell
end run

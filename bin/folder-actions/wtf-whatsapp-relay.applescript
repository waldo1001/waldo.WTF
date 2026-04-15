-- waldo.WTF — Downloads → WaldoInbox relay
--
-- Attached to ~/Downloads as a Folder Action. Whenever one or more files
-- land in Downloads, Finder (which has Downloads TCC) fires this script.
-- It moves anything matching "WhatsApp Chat*" into ~/WaldoInbox, where the
-- launchd WatchPaths agent (bin/com.waldo.wtf.whatsapp-push.plist) picks
-- it up within ~2s and scp's it to the NAS.
--
-- Why this exists: launchd-spawned shell scripts cannot read ~/Downloads
-- (TCC blocks them silently, even with Full Disk Access granted to the
-- script). Finder + Folder Actions has the TCC grant and can do the move.

on adding folder items to this_folder after receiving added_items
	set inbox to (POSIX path of (path to home folder)) & "WaldoInbox/"
	repeat with f in added_items
		tell application "System Events"
			set fname to name of f
		end tell
		if fname starts with "WhatsApp Chat" and (fname ends with ".zip" or fname ends with ".txt") then
			try
				set src to POSIX path of f
				do shell script "/bin/mv " & quoted form of src & " " & quoted form of (inbox & fname)
			on error errMsg
				do shell script "echo " & quoted form of ("[wtf-relay] failed: " & errMsg) & " >> /tmp/wtf-whatsapp-relay.log"
			end try
		end if
	end repeat
end adding folder items to

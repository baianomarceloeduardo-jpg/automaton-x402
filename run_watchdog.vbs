' Automaton-Sovereign — hidden launcher for the watchdog.
' Runs watchdog.ps1 with no visible window, detached from any console session.
Dim sh, fso, dir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = "C:\root\value-api"
sh.CurrentDirectory = dir
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\watchdog.ps1""", 0, False

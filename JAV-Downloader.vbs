Set fso = CreateObject("Scripting.FileSystemObject")
strDir = fso.GetParentFolderName(WScript.ScriptFullName)
strPath = strDir & "\JAV-Downloader.bat"
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = strDir
WshShell.Run """" & strPath & """", 0, False
Set WshShell = Nothing
Set fso = Nothing

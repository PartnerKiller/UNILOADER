Set WshShell = CreateObject("WScript.Shell")
strPath = WshShell.CurrentDirectory & "\JAV-Downloader.bat"
WshShell.Run """" & strPath & """", 0, False
Set WshShell = Nothing

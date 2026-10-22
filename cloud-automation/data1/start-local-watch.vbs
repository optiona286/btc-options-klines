Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then WScript.Quit 1
shell.CurrentDirectory = folder
shell.Run """" & nodeExe & """ """ & folder & "\local-watch.mjs""", 0, False

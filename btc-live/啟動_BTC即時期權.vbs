Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
Set req = CreateObject("MSXML2.ServerXMLHTTP.6.0")
On Error Resume Next
req.setTimeouts 1000, 1000, 1000, 1000
req.open "GET", "http://127.0.0.1:5084/ping", False
req.send
healthy = False
If Err.Number = 0 Then
  healthy = (InStr(req.responseText, "btc-options-live-overlay") > 0)
End If
Err.Clear
On Error GoTo 0
If Not healthy Then
  sh.Run """" & nodeExe & """ """ & appDir & "\btc-options-live-server.cjs""", 0, False
  WScript.Sleep 1800
End If
sh.Run "http://127.0.0.1:5084", 1, False

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = "C:\Program Files\nodejs\node.exe"
port = "5083"

shell.CurrentDirectory = appDir

If Not fso.FileExists(nodeExe) Then
  shell.Popup "Node.js was not found. Please install Node.js first.", 6, "BTC Options K Line System", 48
  WScript.Quit 1
End If

If Not fso.FileExists(appDir & "\server.js") Then
  shell.Popup "server.js was not found in: " & appDir, 6, "BTC Options K Line System", 48
  WScript.Quit 1
End If

baseUrl = "http://127.0.0.1:" & port
health = CheckHealth()
If health = 1 Then
  shell.Run baseUrl, 1, False
  WScript.Quit 0
End If
If health = -1 Then
  shell.Popup "Port " & port & " is being used by another service. Close that service and try again.", 10, "BTC Options K Line System", 48
  WScript.Quit 1
End If

shell.Environment("PROCESS")("PORT") = port
shell.Run """" & nodeExe & """ """ & appDir & "\server.js""", 0, False
For attempt = 1 To 30
  WScript.Sleep 400
  health = CheckHealth()
  If health = 1 Then
    shell.Run baseUrl, 1, False
    WScript.Quit 0
  End If
  If health = -1 Then Exit For
Next
shell.Popup "The server could not start on port " & port & ". Please check Node.js and whether this port is already in use.", 10, "BTC Options K Line System", 48
WScript.Quit 1

Function CheckHealth()
  On Error Resume Next
  Dim request
  Set request = CreateObject("WinHttp.WinHttpRequest.5.1")
  request.SetTimeouts 400, 400, 400, 600
  request.Open "GET", baseUrl & "/ping", False
  request.Send
  If Err.Number <> 0 Then
    Err.Clear
    CheckHealth = 0
  ElseIf request.Status = 200 And InStr(request.ResponseText, """appId"":""btc-options-portable-1h""") > 0 Then
    CheckHealth = 1
  Else
    CheckHealth = -1
  End If
  On Error GoTo 0
End Function

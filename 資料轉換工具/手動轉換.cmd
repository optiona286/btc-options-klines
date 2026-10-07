@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo 請先安裝 Node.js 20.3 或以上，再重新開啟此檔案。
 pause
 exit /b 1
)
node "convert.js"
if errorlevel 1 echo 轉換有錯誤，請查看上方訊息。
pause
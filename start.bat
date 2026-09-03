@echo off
chcp 65001 >nul
echo 正在启动「财务小管家」...
echo 启动后请用浏览器打开：http://127.0.0.1:3090
node "%~dp0server\index.js"
pause

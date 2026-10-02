@chcp 65001 >nul
@echo off
title Knowledge Base Server
cd /d "%~dp0"

set "NODE_CMD=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Users\Lenovo\AppData\Local\Doubao\User Data\sandbox_runtime\bases\c98c5042338ed152c6f10ecd8591889f\node\node.exe" (
    set "NODE_CMD=C:\Users\Lenovo\AppData\Local\Doubao\User Data\sandbox_runtime\bases\c98c5042338ed152c6f10ecd8591889f\node\node.exe"
  ) else (
    echo [ERROR] Node.js runtime not found. Cannot start the service.
    pause
    exit /b 1
  )
)

set "KB_RESTART="

:loop
"%NODE_CMD%" server.js
if exist "data\.restart" (
  del /q "data\.restart"
  echo.
  echo [AutoRestart] restarting server without auth...
  echo.
  set "KB_RESTART=1"
  goto loop
)
echo.
echo [服务已停止] 窗口将于 2 秒后自动关闭（详细日志见 data\server.log）
timeout /t 2 >nul

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 필름 색보정 대시보드 =====
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

echo   서버를 시작합니다... 브라우저가 자동으로 열립니다.
echo   (이 창은 닫지 마세요 — 닫으면 페이지도 꺼집니다)
echo.
start "" http://localhost:4279
node server.js
goto end

:nonode
echo   Node.js가 설치되어 있지 않습니다.
echo   https://nodejs.org 에서 LTS 버전을 설치한 후 다시 실행해주세요.

:end
echo.
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 현장용 사이트 미리보기 =====
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

echo   site 폴더의 보정 데이터를 최신 LUT으로 갱신한 뒤 서버를 켭니다.
echo   브라우저가 자동으로 열립니다. 휴대폰 주소는 아래에 표시됩니다.
echo   (이 창은 닫지 마세요 — 닫으면 페이지도 꺼집니다)
echo.
start "" http://localhost:4281
node site_serve.js
goto end

:nonode
echo   Node.js가 설치되어 있지 않습니다.
echo   https://nodejs.org 에서 LTS 버전을 설치한 후 다시 실행해주세요.

:end
echo.
pause

@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 1단계: 캘리브레이션 차트 만들기 =====
echo.
echo   인화할 필름 종류와 방향을 고르세요.
echo   (인화 앱에 넣었을 때 잘리지 않는 방향으로 고르면 됩니다)
echo.
echo     1) 인스탁스 미니   - 가로
echo     2) 인스탁스 미니   - 세로
echo     3) 인스탁스 스퀘어
echo     4) 인스탁스 와이드 - 가로
echo     5) 인스탁스 와이드 - 세로
echo     6) 폴라로이드
echo.
set /p choice=  번호 입력 (1-6): 

if "%choice%"=="1" set MEDIA=mini
if "%choice%"=="2" set MEDIA=mini_v
if "%choice%"=="3" set MEDIA=square
if "%choice%"=="4" set MEDIA=wide
if "%choice%"=="5" set MEDIA=wide_v
if "%choice%"=="6" set MEDIA=polaroid
if "%MEDIA%"=="" goto badchoice

node run.js 차트 %MEDIA%
if errorlevel 1 goto fail
explorer "%~dp0차트"
goto done

:badchoice
echo.
echo   1-6 중에서 골라주세요.
goto done

:fail
echo.
echo   실패했습니다. Node.js 가 설치되어 있는지 확인하세요 (nodejs.org).

:done
echo.
pause

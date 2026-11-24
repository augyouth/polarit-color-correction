@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 2단계: 스캔본 측정 및 LUT 생성 =====
echo.
if "%~1"=="" goto noarg
node run.js 측정 "%~1"
if errorlevel 1 goto fail
explorer "%~dp0LUT"
goto done

:noarg
echo   인화한 차트를 스캔한 이미지 파일을
echo   이 배치 파일 아이콘 위로 끌어다 놓으세요.
goto done

:fail
echo.
echo   실패했습니다. 위 메시지를 확인하세요.

:done
echo.
pause

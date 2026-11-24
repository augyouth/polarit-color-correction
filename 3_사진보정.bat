@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 3단계: 사진에 보정 적용 =====
echo.
if "%~1"=="" goto noarg
node run.js 보정 "%~1"
if errorlevel 1 goto fail
goto done

:noarg
echo   인화할 사진이 든 폴더(또는 사진 파일 하나)를
echo   이 배치 파일 아이콘 위로 끌어다 놓으세요.
goto done

:fail
echo.
echo   실패했습니다. 위 메시지를 확인하세요.

:done
echo.
pause

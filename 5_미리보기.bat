@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 미리보기: 인화하면 어떻게 나올지 화면에서 확인 =====
echo.
if "%~1"=="" goto noarg
node run.js 미리보기 "%~1"
if errorlevel 1 goto fail
goto done

:noarg
echo   보정 없이 원본 그대로 인화했을 때 어떻게 나올지 보고 싶은
echo   사진 폴더(또는 파일 하나)를 이 배치 파일 아이콘 위로 끌어다 놓으세요.
echo.
echo   ※ 3_사진보정.bat 과 반대입니다 — 그건 인화용 보정 파일을 만들고,
echo     이건 "안 고치면 어떻게 나오는지" 화면으로만 미리 보여줍니다.
goto done

:fail
echo.
echo   실패했습니다. 위 메시지를 확인하세요.

:done
echo.
pause

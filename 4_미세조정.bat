@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   ===== 4단계: 눈으로 본 편차 미세조정 =====
echo.
echo   보정본을 인화해서 화면과 비교해보셨나요?
echo   살짝 어긋난다면 아래에서 조정하세요. 한 번에 조금씩 이동합니다.
echo   (여러 번 조정하려면 이 파일을 다시 실행하세요)
echo.
echo     1) 더 밝게
echo     2) 더 어둡게
echo     3) 더 따뜻하게 (노랑/붉은맛)
echo     4) 더 차갑게 (파랑맛)
echo     5) 마젠타기 줄이기 (그린쪽으로)
echo     6) 그린기 줄이기 (마젠타쪽으로)
echo.
echo     9) 현재 조정 상태만 보기
echo     0) 처음(측정 직후) 상태로 초기화
echo.
set /p choice=  번호 입력:

if "%choice%"=="1" set ACTION=밝게
if "%choice%"=="2" set ACTION=어둡게
if "%choice%"=="3" set ACTION=따뜻하게
if "%choice%"=="4" set ACTION=차갑게
if "%choice%"=="5" set ACTION=마젠타줄이기
if "%choice%"=="6" set ACTION=그린줄이기
if "%choice%"=="9" set ACTION=상태
if "%choice%"=="0" set ACTION=초기화

if "%ACTION%"=="" goto badchoice

node run.js 조정 "" %ACTION%
goto done

:badchoice
echo.
echo   0-9 중에서 골라주세요.

:done
echo.
echo   조정을 더 하려면 이 파일을 다시 실행하세요.
echo   조정이 끝났으면 3_사진보정.bat 을 다시 돌려야 사진에 반영됩니다.
echo.
pause

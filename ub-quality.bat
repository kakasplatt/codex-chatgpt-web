@echo off
setlocal
rem ============================================================
rem  ub-quality.bat - roda crapper, dryer e mutator com um clique.
rem  Coloque este arquivo na RAIZ do projeto e de duplo clique.
rem  Detecta sozinho o runner de teste (Bun, Vitest, Jest ou Node/c8).
rem ============================================================

rem Pastas a analisar, separadas por espaco (vazio = projeto inteiro).
rem Exemplo: set SRC=src launcher\electron
rem Evite pastas de codigo gerado/minificado.
set SRC=

set TOOLS=%USERPROFILE%\.agents\tools
set PY=%TOOLS%\.venv\Scripts\python.exe
set PROJ=%~dp0
set COVFLAG=

echo.
echo === [1/5] Verificando ferramentas em %TOOLS% ===
if not exist "%TOOLS%" mkdir "%TOOLS%"
for %%T in (crapper dryer mutator) do (
  if not exist "%TOOLS%\%%T" git clone https://github.com/unclebob/%%T "%TOOLS%\%%T"
)
if not exist "%PY%" (
  echo Criando ambiente virtual e instalando...
  python -m venv "%TOOLS%\.venv" || py -m venv "%TOOLS%\.venv"
  "%TOOLS%\.venv\Scripts\pip.exe" install -e "%TOOLS%\crapper" -e "%TOOLS%\dryer" -e "%TOOLS%\mutator"
)
if not exist "%PY%" (
  echo ERRO: nao foi possivel preparar o Python das ferramentas.
  pause
  exit /b 1
)

cd /d "%PROJ%"

echo.
echo === [2/5] Gerando cobertura ===
if exist package.json call :cov "%PROJ%" "%PROJ%target\coverage\typescript"
if exist launcher\package.json call :cov "%PROJ%launcher" "%PROJ%target\coverage\typescript\launcher"
if not exist package.json if not exist launcher\package.json echo Sem package.json: o crapper gera a cobertura sozinho para a linguagem do projeto.

if exist "%PROJ%target\coverage\typescript\lcov.info" set COVFLAG=--use-existing-coverage
if exist "%PROJ%target\coverage\typescript\launcher\lcov.info" set COVFLAG=--use-existing-coverage

echo.
echo === [3/5] CRAP (limite 10) ===
"%PY%" -m crapper %COVFLAG% --threshold 10 %SRC%

echo.
echo === [4/5] Duplicacao (limite 0.8) ===
"%PY%" -m dryer --threshold 0.8 %SRC%

echo.
echo === [5/5] Mutacao (apenas arquivos alterados no git) ===
"%PY%" -m mutator --changed

echo.
echo Concluido. Resultados em .metrics\ dentro do projeto.
pause
endlocal
exit /b 0

rem ------------------------------------------------------------
rem :cov <pasta> <pasta-de-saida>
rem Escolhe o runner pelo script "test" do package.json:
rem   "bun test"  -> cobertura nativa do Bun
rem   vitest      -> vitest --coverage
rem   jest        -> jest --coverage
rem   outro       -> c8 (cobertura V8 do Node)
rem ------------------------------------------------------------
:cov
pushd "%~1"
set RUNNER=c8
findstr /i /r /c:"\"test\".*bun test" package.json >nul 2>&1 && set RUNNER=bun
if "%RUNNER%"=="c8" findstr /i /r /c:"\"test\".*vitest" package.json >nul 2>&1 && set RUNNER=vitest
if "%RUNNER%"=="c8" findstr /i /r /c:"\"test\".*jest" package.json >nul 2>&1 && set RUNNER=jest
echo [%~1] runner detectado: %RUNNER%
if "%RUNNER%"=="bun" call npm test -- --coverage --coverage-reporter=lcov --coverage-dir="%~2"
if "%RUNNER%"=="vitest" call npx --yes vitest run --coverage.enabled=true --coverage.reporter=lcov --coverage.reportsDirectory="%~2"
if "%RUNNER%"=="jest" call npx --yes jest --coverage --coverageReporters=lcov --coverageDirectory="%~2"
if "%RUNNER%"=="c8" call npx --yes c8 --reporter=lcov --reports-dir "%~2" npm test
popd
exit /b 0

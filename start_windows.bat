@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto check_environment
where py >nul 2>nul
if errorlevel 1 goto use_python
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 goto unsupported_python
py -3 -m venv .venv
if errorlevel 1 goto failure
goto check_environment
:use_python
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 goto unsupported_python
python -m venv .venv
if errorlevel 1 goto failure
:check_environment
".venv\Scripts\python.exe" -c "import sys; print('Python ' + sys.version.split()[0]); sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 goto unsupported_environment
:dependencies
".venv\Scripts\python.exe" -c "import flask, waitress, mutagen" >nul 2>nul
if not errorlevel 1 goto launch
".venv\Scripts\python.exe" install_dependencies.py
if errorlevel 1 goto failure
:launch
echo Open http://127.0.0.1:8000 in your browser.
echo Keep this window open while playing. Stop: Ctrl+C.
".venv\Scripts\python.exe" app.py
if errorlevel 1 goto failure
goto end
:unsupported_python
echo.
echo Python 3.9 or newer is required. Install it and run this file again.
echo If several versions are installed, use: py -0p
goto wait_for_key
:unsupported_environment
echo.
echo The Python in .venv is too old or the environment is broken.
echo Install Python 3.9 or newer, remove ONLY this project's .venv folder,
echo then run start_windows.bat again. Your source files will remain intact.
goto wait_for_key
:failure
echo.
echo Could not start. Read the error above and see README.md.
:wait_for_key
pause
:end
endlocal

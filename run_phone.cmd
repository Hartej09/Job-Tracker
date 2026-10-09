@echo off
rem Start the Job Tracker so phones on the same network can open it.
rem Open the "Network URL" printed below on your phone.
cd /d "%~dp0"
echo.
echo  Phone access: open the Network URL below on a phone connected to the same network.
echo  Close this window (or press Ctrl+C) to stop.
echo.
".venv\Scripts\streamlit.exe" run app.py --server.address 0.0.0.0 --server.headless true

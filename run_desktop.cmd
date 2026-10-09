@echo off
rem Start the Job Tracker for this PC only (no phone access).
cd /d "%~dp0"
".venv\Scripts\streamlit.exe" run app.py

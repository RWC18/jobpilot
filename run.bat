@echo off
rem Starts JobPilot and opens it in your browser. Needs Node.js 20+ on PATH (or set JOBPILOT_NODE to a node.exe).
cd /d "%~dp0"
if not exist node_modules call npm install
set NODE=node
if defined JOBPILOT_NODE set NODE=%JOBPILOT_NODE%
start "" http://localhost:4310
"%NODE%" src\server.cjs

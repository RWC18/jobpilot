#!/bin/sh
# Virtual screen for Chrome, a window manager, a VNC server bound to localhost (the app proxies it behind
# its password), then the app itself.
set -e
mkdir -p "$JOBPILOT_DATA"
# Locks left by a previous container would make Chrome think the profile is in use.
rm -f /tmp/.X99-lock "$JOBPILOT_DATA"/chrome-profile/Singleton*
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
sleep 1
fluxbox >/dev/null 2>&1 &
x11vnc -display :99 -forever -shared -nopw -localhost -rfbport "$JOBPILOT_VNC_PORT" -quiet >/dev/null 2>&1 &
exec node src/server.cjs

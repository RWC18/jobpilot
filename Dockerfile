# JobPilot server image: Node + Google Chrome on a virtual screen, viewable in the app over VNC.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget xvfb x11vnc fluxbox fonts-liberation fonts-noto-color-emoji \
 && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Mount a persistent volume at /data (profile, CV, jobs, browser logins).
ENV HOST=0.0.0.0 \
    PORT=4310 \
    JOBPILOT_DATA=/data \
    JOBPILOT_VNC_PORT=5900 \
    JOBPILOT_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage" \
    DISPLAY=:99
EXPOSE 4310
CMD ["sh", "docker/start.sh"]

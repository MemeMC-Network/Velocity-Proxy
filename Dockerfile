# Velocity Proxy — container image
#
# Works on any Docker host (Render, Railway, Fly.io, a VPS). Chromium and
# ffmpeg run inside the image; audio flows through a private PulseAudio null
# sink created by scripts/start-with-audio.sh.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    XDG_RUNTIME_DIR=/run/velocity-proxy \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    AUDIO_ENABLED=1 \
    AUDIO_SOURCE=pulse \
    AUDIO_DEVICE=velocity_sink.monitor \
    AUDIO_PULSE_SINK=velocity_sink

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates ffmpeg pulseaudio pulseaudio-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY . .
RUN mkdir -p /data /run/velocity-proxy \
 && chmod +x scripts/start-with-audio.sh

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./scripts/start-with-audio.sh"]

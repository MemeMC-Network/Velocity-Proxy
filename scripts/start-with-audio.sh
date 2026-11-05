#!/usr/bin/env bash
# Launch Velocity Proxy with a private PulseAudio instance so Chromium has a
# device to play page audio into. Used by systemd (velocity-proxy.service).
#
# Chromium plays into the "velocity_sink" null sink; ffmpeg records that sink's
# monitor source and the server streams it as Opus. This needs no sound card and
# no manual device configuration on the server.
set -Eeuo pipefail

APP_DIR="${VELOCITY_APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SINK_NAME="${AUDIO_PULSE_SINK:-velocity_sink}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/velocity-proxy}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

if command -v pulseaudio >/dev/null 2>&1; then
  if ! pulseaudio --check >/dev/null 2>&1; then
    pulseaudio --start --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1 || true
    for _ in $(seq 1 25); do
      pulseaudio --check >/dev/null 2>&1 && break
      sleep 0.2
    done
  fi
  if pulseaudio --check >/dev/null 2>&1; then
    pactl load-module module-null-sink \
      "sink_name=${SINK_NAME}" "rate=48000" "channels=2" \
      "sink_properties=device.description=VelocityProxy" >/dev/null 2>&1 || true
    pactl set-default-sink "${SINK_NAME}" >/dev/null 2>&1 || true
    export PULSE_SINK="${SINK_NAME}"
  else
    echo "warning: PulseAudio did not start; browser audio will be unavailable" >&2
  fi
else
  echo "warning: pulseaudio is not installed; browser audio will be unavailable" >&2
fi

exec node "${APP_DIR}/src/server.js"

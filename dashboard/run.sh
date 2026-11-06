#!/bin/sh
set -e

# Export S6 container environment variables if present
if [ -d "/run/s6/container_environment" ]; then
  for env_file in /run/s6/container_environment/*; do
    if [ -f "$env_file" ]; then
      var_name=$(basename "$env_file")
      export "$var_name"="$(cat "$env_file")"
    fi
  done
fi

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

echo "[Solar Forecast Add-on] Starting Solar Forecast Engine..."
echo "[Solar Forecast Add-on] Node binary path: $(which node || echo 'not found')"
echo "[Solar Forecast Add-on] Node version: $(node -v || echo 'not available')"

# If running inside Home Assistant Add-on, /data is the persistent volume
if [ -d "/data" ]; then
  export DATA_DIR="/data"
  echo "[Solar Forecast Add-on] Using persistent SQLite directory: /data"
fi

exec node server.js

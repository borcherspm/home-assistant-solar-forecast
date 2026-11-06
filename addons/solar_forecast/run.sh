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
  
  COPY_SEED=0
  if [ ! -f "/data/solar_forecasts.db" ]; then
    COPY_SEED=1
  elif [ $(wc -c < "/data/solar_forecasts.db") -lt 50000 ]; then
    echo "[Solar Forecast Add-on] Existing /data/solar_forecasts.db is stub (<50KB). Replacing with baseline database."
    COPY_SEED=1
  fi

  if [ "$COPY_SEED" -eq 1 ] && [ -f "/app/data/solar_forecasts.db" ]; then
    echo "[Solar Forecast Add-on] Copying complete baseline database into /data/solar_forecasts.db..."
    cp -f /app/data/solar_forecasts.db /data/solar_forecasts.db
    rm -f /data/solar_forecasts.db-wal /data/solar_forecasts.db-shm
  fi
fi

exec node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3030;
const HA_URL = process.env.SUPERVISOR_TOKEN
  ? 'http://supervisor/core'
  : (process.env.HA_URL || 'http://homeassistant.local:8123');
const HA_WS_URL = process.env.SUPERVISOR_TOKEN
  ? 'ws://supervisor/core/websocket'
  : (process.env.HA_WS_URL || 'ws://homeassistant.local:8123/api/websocket');
let locationConfig = {
  latitude: parseFloat(process.env.LATITUDE) || null,
  longitude: parseFloat(process.env.LONGITUDE) || null,
  timezone: process.env.TIMEZONE || 'America/New_York',
  name: process.env.LOCATION_NAME || 'Solar Array'
};
const DATA_DIR =
  process.env.DATA_DIR ||
  (fs.existsSync('/data') && fs.statSync('/data').isDirectory()
    ? '/data'
    : path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'solar_forecasts.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS forecast_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_date TEXT NOT NULL,
    version INTEGER NOT NULL,
    captured_on_date TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    lead_days INTEGER NOT NULL,
    lead_hours REAL NOT NULL,
    projected_kwh REAL NOT NULL,
    raw_similar_days_kwh REAL NOT NULL,
    min_kwh REAL NOT NULL,
    max_kwh REAL NOT NULL,
    sunshine_hours REAL NOT NULL,
    daylight_hours REAL NOT NULL,
    sunshine_pct REAL NOT NULL,
    radiation_sum REAL NOT NULL,
    cloud_cover INTEGER NOT NULL,
    effective_cloud_cover INTEGER NOT NULL,
    cloud_low_pct INTEGER NOT NULL,
    cloud_mid_pct INTEGER NOT NULL,
    cloud_high_pct INTEGER NOT NULL,
    weather_label TEXT NOT NULL,
    weather_icon TEXT NOT NULL,
    sky_note TEXT NOT NULL,
    top_match_dates TEXT NOT NULL,
    change_reason TEXT NOT NULL DEFAULT 'initial',
    UNIQUE(target_date, version)
  );
  CREATE INDEX IF NOT EXISTS idx_fv_target ON forecast_versions(target_date, version);

  CREATE TABLE IF NOT EXISTS daily_actuals (
    date TEXT PRIMARY KEY,
    actual_kwh REAL NOT NULL,
    tree_lost_kwh REAL NOT NULL,
    counterfactual_kwh REAL NOT NULL,
    sunshine_hours REAL NOT NULL,
    daylight_hours REAL NOT NULL,
    radiation_sum REAL NOT NULL,
    effective_cloud_cover INTEGER NOT NULL,
    cloud_low_pct INTEGER NOT NULL,
    cloud_mid_pct INTEGER NOT NULL,
    cloud_high_pct INTEGER NOT NULL,
    weather_label TEXT NOT NULL,
    weather_icon TEXT NOT NULL,
    is_complete INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
`);

// Migrate any rows from legacy forecast_snapshots table if present, and ensure hourly JSON columns exist
try {
  const colsFv = db.prepare('PRAGMA table_info(forecast_versions)').all().map((c) => c.name);
  if (!colsFv.includes('hourly_projected_json')) {
    db.exec("ALTER TABLE forecast_versions ADD COLUMN hourly_projected_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!colsFv.includes('hourly_breakdown_json')) {
    db.exec("ALTER TABLE forecast_versions ADD COLUMN hourly_breakdown_json TEXT NOT NULL DEFAULT '[]';");
  }
  const colsDa = db.prepare('PRAGMA table_info(daily_actuals)').all().map((c) => c.name);
  if (!colsDa.includes('hours_actual_json')) {
    db.exec("ALTER TABLE daily_actuals ADD COLUMN hours_actual_json TEXT NOT NULL DEFAULT '[]';");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS hourly_forecast_versions (
      target_date TEXT NOT NULL,
      version INTEGER NOT NULL,
      hour INTEGER NOT NULL,
      projected_kwh REAL NOT NULL,
      radiation_wm2 INTEGER NOT NULL,
      effective_cloud_pct INTEGER NOT NULL,
      cloud_low_pct INTEGER NOT NULL,
      cloud_mid_pct INTEGER NOT NULL,
      cloud_high_pct INTEGER NOT NULL,
      PRIMARY KEY (target_date, version, hour)
    );
  `);
} catch (err) {
  console.error('SQLite schema migration note:', err.message);
}

function saveToSQLite(todayStr, isTodayComplete, historicalDays, forecastDays, forceNewVersion = false) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const upsertActual = db.prepare(`
    INSERT INTO daily_actuals (
      date, actual_kwh, tree_lost_kwh, counterfactual_kwh,
      sunshine_hours, daylight_hours, radiation_sum,
      effective_cloud_cover, cloud_low_pct, cloud_mid_pct, cloud_high_pct,
      weather_label, weather_icon, is_complete, updated_at, hours_actual_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      actual_kwh = excluded.actual_kwh,
      tree_lost_kwh = excluded.tree_lost_kwh,
      counterfactual_kwh = excluded.counterfactual_kwh,
      sunshine_hours = excluded.sunshine_hours,
      daylight_hours = excluded.daylight_hours,
      radiation_sum = excluded.radiation_sum,
      effective_cloud_cover = excluded.effective_cloud_cover,
      cloud_low_pct = excluded.cloud_low_pct,
      cloud_mid_pct = excluded.cloud_mid_pct,
      cloud_high_pct = excluded.cloud_high_pct,
      weather_label = excluded.weather_label,
      weather_icon = excluded.weather_icon,
      is_complete = excluded.is_complete,
      updated_at = excluded.updated_at,
      hours_actual_json = excluded.hours_actual_json
  `);

  for (const d of historicalDays) {
    const completeFlag = d.date < todayStr || (d.date === todayStr && isTodayComplete) ? 1 : 0;
    upsertActual.run(
      d.date,
      d.actual_kwh,
      d.tree_lost_kwh,
      d.counterfactual_kwh,
      d.sunshine_hours,
      d.daylight_hours,
      d.radiation_sum,
      d.effective_cloud_cover,
      d.cloud_low_pct,
      d.cloud_mid_pct,
      d.cloud_high_pct,
      d.weather_label,
      d.weather_icon,
      completeFlag,
      nowIso,
      JSON.stringify(d.hours_actual || [])
    );
  }

  const getLatestVersion = db.prepare(`
    SELECT * FROM forecast_versions
    WHERE target_date = ?
    ORDER BY version DESC
    LIMIT 1
  `);

  const insertVersion = db.prepare(`
    INSERT INTO forecast_versions (
      target_date, version, captured_on_date, captured_at, lead_days, lead_hours,
      projected_kwh, raw_similar_days_kwh, min_kwh, max_kwh,
      sunshine_hours, daylight_hours, sunshine_pct, radiation_sum,
      cloud_cover, effective_cloud_cover, cloud_low_pct, cloud_mid_pct, cloud_high_pct,
      weather_label, weather_icon, sky_note, top_match_dates, change_reason,
      hourly_projected_json, hourly_breakdown_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateLatestHourlyJson = db.prepare(`
    UPDATE forecast_versions
    SET hourly_projected_json = ?, hourly_breakdown_json = ?
    WHERE id = ? AND (hourly_projected_json = '[]' OR hourly_breakdown_json = '[]')
  `);

  const upsertHourlyRow = db.prepare(`
    INSERT INTO hourly_forecast_versions (
      target_date, version, hour, projected_kwh, radiation_wm2,
      effective_cloud_pct, cloud_low_pct, cloud_mid_pct, cloud_high_pct
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target_date, version, hour) DO UPDATE SET
      projected_kwh = excluded.projected_kwh,
      radiation_wm2 = excluded.radiation_wm2,
      effective_cloud_pct = excluded.effective_cloud_pct,
      cloud_low_pct = excluded.cloud_low_pct,
      cloud_mid_pct = excluded.cloud_mid_pct,
      cloud_high_pct = excluded.cloud_high_pct
  `);

  let newVersionsInserted = 0;

  for (const f of forecastDays) {
    // Do not automatically record new forecast versions for today after sunset (unless manual snapshot is forced)
    if (!forceNewVersion && f.date === todayStr && isTodayComplete) {
      const existingToday = getLatestVersion.get(f.date);
      if (existingToday) continue;
    }

    const latest = getLatestVersion.get(f.date);
    const targetNoonMs = new Date(`${f.date}T17:00:00Z`).getTime(); // ~12:00 PM EST
    const leadHours = +Math.max(0, (targetNoonMs - nowMs) / 3600000).toFixed(1);
    const leadDays = Math.round((new Date(f.date) - new Date(todayStr)) / 86400000);

    let shouldInsert = false;
    let reason = 'initial_lock';

    if (!latest) {
      shouldInsert = true;
      reason = 'initial_lock';
    } else if (forceNewVersion) {
      shouldInsert = true;
      reason = 'manual_snapshot';
    } else {
      const kwhChanged = Math.abs(latest.projected_kwh - f.projected_kwh) >= 0.3;
      const sunChanged = Math.abs(latest.sunshine_hours - f.sunshine_hours) >= 0.25;
      const cloudChanged = Math.abs(latest.effective_cloud_cover - f.effective_cloud_cover) >= 3;
      const radChanged = Math.abs(latest.radiation_sum - f.radiation_sum) >= 0.3;
      const newCaptureDay = latest.captured_on_date !== todayStr;
      const hoursSinceLastVersion =
        (nowMs - new Date(latest.captured_at).getTime()) / 3600000;

      // Require at least 3 hours between automatic intra-day version bumps (prevents CDN edge node bounce on rapid page refreshes)
      if (
        newCaptureDay ||
        (hoursSinceLastVersion >= 3.0 && (kwhChanged || sunChanged || cloudChanged || radChanged))
      ) {
        shouldInsert = true;
        const reasons = [];
        if (newCaptureDay) reasons.push(`daily_roll(${todayStr})`);
        if (kwhChanged) {
          const diff = +(f.projected_kwh - latest.projected_kwh).toFixed(1);
          reasons.push(`kwh(${diff >= 0 ? '+' : ''}${diff})`);
        }
        if (sunChanged) {
          const diff = +(f.sunshine_hours - latest.sunshine_hours).toFixed(2);
          reasons.push(`sun(${diff >= 0 ? '+' : ''}${diff}h)`);
        }
        if (cloudChanged) {
          const diff = f.effective_cloud_cover - latest.effective_cloud_cover;
          reasons.push(`cloud_blk(${diff >= 0 ? '+' : ''}${diff}%)`);
        }
        reason = reasons.join(', ') || 'weather_update';
      }
    }

    if (shouldInsert) {
      const nextVersion = latest ? latest.version + 1 : 1;
      insertVersion.run(
        f.date,
        nextVersion,
        todayStr,
        nowIso,
        leadDays,
        leadHours,
        Number(f.projected_kwh) || 0,
        Number(f.raw_similar_days_kwh) || 0,
        Number(f.min_kwh) || 0,
        Number(f.max_kwh) || 0,
        Number(f.sunshine_hours) || 0,
        Number(f.daylight_hours) || 10,
        Number(f.sunshine_pct) || 0,
        Number(f.radiation_sum) || 0,
        Number(f.cloud_cover) || 0,
        Number(f.effective_cloud_cover) || 0,
        Number(f.cloud_low_pct) || 0,
        Number(f.cloud_mid_pct) || 0,
        Number(f.cloud_high_pct) || 0,
        f.weather_label || 'Partly Sunny',
        f.weather_icon || '⛅',
        f.sky_note || '',
        JSON.stringify((f.similar_past_days || []).slice(0, 3).map((m) => m.date)),
        reason,
        JSON.stringify(f.hourly_projected || []),
        JSON.stringify(f.hourly_breakdown || [])
      );
      for (const hb of f.hourly_breakdown || []) {
        upsertHourlyRow.run(
          f.date,
          nextVersion,
          hb.hour,
          hb.projected_kwh,
          hb.radiation_wm2,
          hb.effective_cloud_pct,
          hb.cloud_low_pct,
          hb.cloud_mid_pct,
          hb.cloud_high_pct
        );
      }
      newVersionsInserted++;
    } else if (latest) {
      // Backfill hourly JSON on existing v1 rows that were created before hourly columns existed
      updateLatestHourlyJson.run(
        JSON.stringify(f.hourly_projected || []),
        JSON.stringify(f.hourly_breakdown || []),
        latest.id
      );
      for (const hb of f.hourly_breakdown || []) {
        upsertHourlyRow.run(
          f.date,
          latest.version,
          hb.hour,
          hb.projected_kwh,
          hb.radiation_wm2,
          hb.effective_cloud_pct,
          hb.cloud_low_pct,
          hb.cloud_mid_pct,
          hb.cloud_high_pct
        );
      }
    }
  }

  // Also backfill Today's hourly JSON if Today was skipped at top of loop
  const todayForecast = forecastDays.find((x) => x.date === todayStr);
  if (todayForecast) {
    const latestToday = getLatestVersion.get(todayStr);
    if (latestToday) {
      updateLatestHourlyJson.run(
        JSON.stringify(todayForecast.hourly_projected || []),
        JSON.stringify(todayForecast.hourly_breakdown || []),
        latestToday.id
      );
      for (const hb of todayForecast.hourly_breakdown || []) {
        upsertHourlyRow.run(
          todayStr,
          latestToday.version,
          hb.hour,
          hb.projected_kwh,
          hb.radiation_wm2,
          hb.effective_cloud_pct,
          hb.cloud_low_pct,
          hb.cloud_mid_pct,
          hb.cloud_high_pct
        );
      }
    }
  }

  db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  return { nowIso, newVersionsInserted };
}

function querySQLiteLedger(todayStr, isTodayComplete) {
  const rows = db
    .prepare(
      `
    SELECT
      v.*,
      a.actual_kwh,
      a.is_complete,
      a.hours_actual_json,
      a.sunshine_hours AS actual_sunshine_hours,
      a.radiation_sum AS actual_radiation_sum,
      a.effective_cloud_cover AS actual_effective_cloud
    FROM forecast_versions v
    LEFT JOIN daily_actuals a ON a.date = v.target_date
    ORDER BY v.target_date ASC, v.version ASC
  `
    )
    .all();

  const byTarget = {};
  for (const r of rows) {
    if (!byTarget[r.target_date]) {
      byTarget[r.target_date] = [];
    }
    byTarget[r.target_date].push(r);
  }

  return Object.entries(byTarget).map(([targetDate, versions]) => {
    const firstVer = versions[0];
    const latestVer = versions[versions.length - 1];
    const chosenSnap = latestVer;

    const isCompleted =
      targetDate < todayStr || (targetDate === todayStr && isTodayComplete);
    const actualKwh = isCompleted && chosenSnap.actual_kwh != null ? chosenSnap.actual_kwh : null;
    const diffKwh =
      actualKwh != null ? +(actualKwh - chosenSnap.projected_kwh).toFixed(2) : null;
    const absErrKwh =
      actualKwh != null ? +Math.abs(actualKwh - chosenSnap.projected_kwh).toFixed(2) : null;
    const pctErr =
      actualKwh != null && actualKwh > 1
        ? +(((actualKwh - chosenSnap.projected_kwh) / actualKwh) * 100).toFixed(1)
        : null;

    let hourlyProjected = [];
    let hourlyBreakdown = [];
    let hoursActual = [];
    try {
      hourlyProjected = JSON.parse(chosenSnap.hourly_projected_json || '[]');
      hourlyBreakdown = JSON.parse(chosenSnap.hourly_breakdown_json || '[]');
      hoursActual = JSON.parse(chosenSnap.hours_actual_json || '[]');
    } catch (_) {}

    return {
      target_date: targetDate,
      source: 'sqlite_versioned',
      status: isCompleted ? 'completed' : targetDate === todayStr ? 'in_progress' : 'upcoming',
      first_captured_on: firstVer.captured_on_date,
      first_captured_at: firstVer.captured_at,
      first_projected_kwh: firstVer.projected_kwh,
      latest_version: latestVer.version,
      version_drift_kwh: +(latestVer.projected_kwh - firstVer.projected_kwh).toFixed(1),
      locked_forecast: chosenSnap,
      hourly_projected: hourlyProjected,
      hourly_breakdown: hourlyBreakdown,
      hours_actual: hoursActual,
      versions_count: versions.length,
      version_history: versions,
      actual_kwh: actualKwh,
      actual_sunshine_hours: isCompleted ? chosenSnap.actual_sunshine_hours : null,
      actual_radiation_sum: isCompleted ? chosenSnap.actual_radiation_sum : null,
      actual_effective_cloud: isCompleted ? chosenSnap.actual_effective_cloud : null,
      diff_kwh: diffKwh,
      abs_error_kwh: absErrKwh,
      pct_error: pctErr
    };
  });
}

let cachedHAToken = null;
function getHAToken() {
  if (fs.existsSync('/data/options.json')) {
    try {
      const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
      if (opts.ha_token && opts.ha_token.trim()) {
        return opts.ha_token.trim();
      }
    } catch (_) {}
  }
  if (process.env.SUPERVISOR_TOKEN) {
    return process.env.SUPERVISOR_TOKEN;
  }
  const s6TokenPath = '/run/s6/container_environment/SUPERVISOR_TOKEN';
  if (fs.existsSync(s6TokenPath)) {
    try {
      const tok = fs.readFileSync(s6TokenPath, 'utf8').trim();
      if (tok) return tok;
    } catch (_) {}
  }
  if (cachedHAToken) return cachedHAToken;
  try {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
      const env = fs.readFileSync(envPath, 'utf8');
      const token = env
        .split('\n')
        .find((line) => line.startsWith('HOME_ASSISTANT_TOKEN='))
        ?.split('=')[1]
        ?.trim()
        ?.replace(/^["']|["']$/g, '');
      if (token) cachedHAToken = token;
      return cachedHAToken;
    }
  } catch (_) {}
  return process.env.HOME_ASSISTANT_TOKEN || null;
}

let detectedEntities = {
  power: process.env.SOLAR_POWER_SENSOR || null,
  energy: process.env.SOLAR_ENERGY_SENSOR || null,
  grid: process.env.GRID_POWER_SENSOR || null,
  load: process.env.LOAD_POWER_SENSOR || null,
  soc: process.env.BATTERY_SOC_SENSOR || null
};

async function detectSolarEntities(token) {
  if (fs.existsSync('/data/options.json')) {
    try {
      const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
      if (opts.solar_power_sensor) detectedEntities.power = opts.solar_power_sensor;
      if (opts.solar_energy_sensor) detectedEntities.energy = opts.solar_energy_sensor;
      if (opts.grid_power_sensor) detectedEntities.grid = opts.grid_power_sensor;
      if (opts.load_power_sensor) detectedEntities.load = opts.load_power_sensor;
      if (opts.battery_soc_sensor) detectedEntities.soc = opts.battery_soc_sensor;
    } catch (_) {}
  }
  if (token && (!detectedEntities.power || !detectedEntities.energy)) {
    try {
      const res = await fetch(`${HA_URL}/api/states`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const states = await res.json();
        if (!detectedEntities.power) {
          detectedEntities.power = states.find((s) => s.entity_id.endsWith('_solar_power') || s.entity_id === 'sensor.solar_power')?.entity_id || 'sensor.solar_power';
        }
        if (!detectedEntities.energy) {
          detectedEntities.energy = states.find((s) => s.entity_id.endsWith('_solar_generated') || s.entity_id === 'sensor.solar_generated')?.entity_id || 'sensor.solar_generated';
        }
        if (!detectedEntities.grid) {
          detectedEntities.grid = states.find((s) => s.entity_id.endsWith('_grid_power') || s.entity_id === 'sensor.grid_power')?.entity_id || 'sensor.grid_power';
        }
        if (!detectedEntities.load) {
          detectedEntities.load = states.find((s) => s.entity_id.endsWith('_load_power') || s.entity_id === 'sensor.load_power')?.entity_id || 'sensor.load_power';
        }
        if (!detectedEntities.soc) {
          detectedEntities.soc = states.find((s) => s.entity_id.endsWith('_percentage_charged') || s.entity_id.endsWith('_battery_percentage') || s.entity_id === 'sensor.battery_percentage')?.entity_id || 'sensor.battery_percentage';
        }
      }
    } catch (_) {}
  }
  if (!detectedEntities.power) detectedEntities.power = 'sensor.solar_power';
  if (!detectedEntities.energy) detectedEntities.energy = 'sensor.solar_generated';
  if (!detectedEntities.grid) detectedEntities.grid = 'sensor.grid_power';
  if (!detectedEntities.load) detectedEntities.load = 'sensor.load_power';
  if (!detectedEntities.soc) detectedEntities.soc = 'sensor.battery_percentage';
  return detectedEntities;
}

async function resolveLocation(token) {
  if (fs.existsSync('/data/options.json')) {
    try {
      const opts = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
      if (opts.latitude && !isNaN(parseFloat(opts.latitude))) {
        locationConfig.latitude = parseFloat(opts.latitude);
      }
      if (opts.longitude && !isNaN(parseFloat(opts.longitude))) {
        locationConfig.longitude = parseFloat(opts.longitude);
      }
      if (opts.timezone && typeof opts.timezone === 'string') {
        locationConfig.timezone = opts.timezone.trim();
      }
      if (opts.location_name && typeof opts.location_name === 'string') {
        locationConfig.name = opts.location_name.trim();
      }
    } catch (_) {}
  }
  if (token && (locationConfig.latitude == null || locationConfig.longitude == null)) {
    try {
      const res = await fetch(`${HA_URL}/api/config`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.latitude != null && cfg.longitude != null) {
          locationConfig.latitude = parseFloat(cfg.latitude);
          locationConfig.longitude = parseFloat(cfg.longitude);
        }
        if (cfg.time_zone) {
          locationConfig.timezone = cfg.time_zone;
        }
        if (cfg.location_name) {
          locationConfig.name = `${cfg.location_name} Solar Array`;
        }
      }
    } catch (_) {}
  }
  if (locationConfig.latitude == null || locationConfig.longitude == null) {
    locationConfig.latitude = 42.65;
    locationConfig.longitude = -73.70;
  }
  return locationConfig;
}

async function connectWS(wsUrl, token, startISO, endISO) {
  return new Promise((resolve, reject) => {
    let timer = null;
    let ws = null;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return reject(e);
    }

    timer = setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      reject(new Error(`Timeout connecting to ${wsUrl}`));
    }, 6000);

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'auth_required') {
          if (!token) {
            clearTimeout(timer);
            try {
              ws.close();
            } catch (_) {}
            return reject(new Error('No access token available for WebSocket auth'));
          }
          ws.send(JSON.stringify({ type: 'auth', access_token: token }));
        } else if (msg.type === 'auth_invalid') {
          clearTimeout(timer);
          try {
            ws.close();
          } catch (_) {}
          reject(new Error(`Auth invalid from ${wsUrl}: ${msg.message}`));
        } else if (msg.type === 'auth_ok') {
          ws.send(
            JSON.stringify({
              id: 1,
              type: 'recorder/statistics_during_period',
              start_time: startISO,
              end_time: endISO,
              period: 'hour',
              statistic_ids: [
                detectedEntities.power,
                detectedEntities.energy,
                detectedEntities.grid
              ].filter(Boolean)
            })
          );
        } else if (msg.id === 1) {
          clearTimeout(timer);
          try {
            ws.close();
          } catch (_) {}
          resolve(msg.result || {});
        }
      } catch (err) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch (_) {}
        reject(err);
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {}
      reject(err);
    };
  });
}

async function fetchHAStats(token, startISO, endISO) {
  const candidateUrls = process.env.SUPERVISOR_TOKEN
    ? [
        'ws://supervisor/core/websocket',
        'ws://homeassistant:8123/api/websocket',
        'ws://homeassistant.local:8123/api/websocket'
      ]
    : [HA_WS_URL];

  for (const url of candidateUrls) {
    try {
      console.log(`[HA WebSocket] Attempting connection to ${url}...`);
      const stats = await connectWS(url, token, startISO, endISO);
      console.log(`[HA WebSocket] Successfully retrieved statistics from ${url}`);
      return stats;
    } catch (err) {
      console.warn(`[HA WebSocket] Warning on ${url}: ${err.message}`);
    }
  }

  console.warn('[HA WebSocket] Live WebSocket unavailable; falling back to SQLite database actuals & REST API.');
  return {};
}

// Compute smooth cumulative expected kWh from midnight/sunrise up to exact local time (HH:MM:SS)
function getCumulativeExpectedKwhNow(forecast15m, projectedKwh, nowDate = new Date()) {
  if (!forecast15m || !forecast15m.length) return 0;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: locationConfig.timezone || 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(nowDate);
  const get = (t) => parseInt(parts.find((x) => x.type === t)?.value || '0', 10);
  const hr = get('hour') % 24;
  const min = get('minute');
  const sec = get('second');
  const totalMins = hr * 60 + min + sec / 60;

  let cumKwh = 0;
  for (let i = 0; i < forecast15m.length; i++) {
    const slotStart = i * 15;
    const slotEnd = (i + 1) * 15;
    const kw = forecast15m[i].kw || 0;
    if (totalMins >= slotEnd) {
      cumKwh += kw * 0.25;
    } else if (totalMins > slotStart) {
      cumKwh += kw * ((totalMins - slotStart) / 60);
      break;
    } else {
      break;
    }
  }
  return +Math.min(projectedKwh, cumKwh).toFixed(2);
}

async function publishSensorsToHA(token, forecastDays, backtestSummary) {
  // Only publish metrics to Home Assistant if running inside the Home Assistant Add-on (SUPERVISOR_TOKEN)
  // or if explicitly enabled via PUBLISH_TO_HA=true. Local MacBook version will not push to HA.
  const isEnabled = Boolean(process.env.SUPERVISOR_TOKEN || process.env.PUBLISH_TO_HA === 'true');
  if (!isEnabled) {
    return;
  }
  if (!token || !forecastDays || !forecastDays.length) return;
  const today = forecastDays[0];
  const tomorrow = forecastDays[1] || today;
  const next7 = forecastDays.slice(1, 8);
  const sum7d = +next7.reduce((acc, d) => acc + d.projected_kwh, 0).toFixed(1);

  const today15m = (today.forecast_15m || [])
    .filter((p) => p.hour >= 6 && p.hour <= 18)
    .map((p) => ({
      time: p.time,
      hhmm: p.hhmm,
      kw: p.kw,
      cumulative_kwh: p.cumulative_kwh,
      rad_wm2: p.rad_wm2
    }));
  const tomorrow15m = (tomorrow.forecast_15m || [])
    .filter((p) => p.hour >= 6 && p.hour <= 18)
    .map((p) => ({
      time: p.time,
      hhmm: p.hhmm,
      kw: p.kw,
      cumulative_kwh: p.cumulative_kwh,
      rad_wm2: p.rad_wm2
    }));

  // Find current 15-minute slot projected kW and exact cumulative kWh up to right now
  const nowD = new Date();
  const { hour: curHr } = getLocalDateHour(nowD);
  const curMinQuarter = Math.floor(nowD.getMinutes() / 15) * 15;
  const curHhmm = `${String(curHr).padStart(2, '0')}:${String(curMinQuarter).padStart(2, '0')}`;
  const currentSlot = (today.forecast_15m || []).find((p) => p.hhmm === curHhmm);
  const currentProjKw = currentSlot ? currentSlot.kw : (today.hourly_projected?.[curHr] || 0);
  const cumulativeExpectedNowKwh = getCumulativeExpectedKwhNow(
    today.forecast_15m,
    today.projected_kwh,
    nowD
  );

  const deviceBlock = {
    identifiers: ['solar_forecast_engine'],
    name: 'Solar Forecast Engine',
    manufacturer: 'Open-Meteo + Home Assistant LTS',
    model: 'Solar Intelligence Engine'
  };

  const sensors = [
    {
      key: 'expected_today_weather',
      entity_id: 'sensor.solar_expected_today_weather_forecast',
      unique_id: 'solar_expected_today_weather_forecast',
      name: 'Solar Expected Today (Weather Forecast)',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'measurement',
      icon: 'mdi:weather-partly-sunny',
      state: String(cumulativeExpectedNowKwh),
      attributes: {
        full_day_projected_kwh: today.projected_kwh,
        actual_so_far_kwh: today.actual_so_far_kwh || 0,
        variance_so_far_kwh: +((today.actual_so_far_kwh || 0) - cumulativeExpectedNowKwh).toFixed(2),
        current_power_projected_kw: currentProjKw,
        sunshine_hours: today.sunshine_hours,
        effective_cloud_cover_pct: today.effective_cloud_cover,
        weather_label: today.weather_label,
        cumulative_by_15m: today15m.map((p) => ({ time: p.hhmm, kwh: p.cumulative_kwh, kw: p.kw }))
      }
    },
    {
      key: 'forecast_today',
      entity_id: 'sensor.solar_forecast_today',
      unique_id: 'solar_forecast_today',
      name: 'Solar Forecast Today',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'measurement',
      icon: 'mdi:solar-power-variant',
      state: String(today.projected_kwh),
      attributes: {
        date: today.date,
        actual_so_far_kwh: today.actual_so_far_kwh || 0,
        clear_sky_ceiling_kwh: today.clear_sky_potential_kwh,
        sunshine_hours: today.sunshine_hours,
        daylight_hours: today.daylight_hours,
        effective_cloud_cover_pct: today.effective_cloud_cover,
        cloud_low_pct: today.cloud_low_pct,
        cloud_mid_pct: today.cloud_mid_pct,
        cloud_high_pct: today.cloud_high_pct,
        radiation_mj_m2: today.radiation_sum,
        weather_label: today.weather_label,
        temp_max_f: today.temp_max_f,
        hourly_projected_kw: today.hourly_projected,
        forecast_15m: today15m,
        forecast_48h_15m: [...today15m, ...tomorrow15m]
      }
    },
    {
      key: 'forecast_tomorrow',
      entity_id: 'sensor.solar_forecast_tomorrow',
      unique_id: 'solar_forecast_tomorrow',
      name: 'Solar Forecast Tomorrow',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'measurement',
      icon: 'mdi:weather-sunny-alert',
      state: String(tomorrow.projected_kwh),
      attributes: {
        date: tomorrow.date,
        clear_sky_ceiling_kwh: tomorrow.clear_sky_potential_kwh,
        sunshine_hours: tomorrow.sunshine_hours,
        daylight_hours: tomorrow.daylight_hours,
        effective_cloud_cover_pct: tomorrow.effective_cloud_cover,
        cloud_low_pct: tomorrow.cloud_low_pct,
        cloud_mid_pct: tomorrow.cloud_mid_pct,
        cloud_high_pct: tomorrow.cloud_high_pct,
        radiation_mj_m2: tomorrow.radiation_sum,
        weather_label: tomorrow.weather_label,
        temp_max_f: tomorrow.temp_max_f,
        hourly_projected_kw: tomorrow.hourly_projected,
        forecast_15m: tomorrow15m
      }
    },
    {
      key: 'forecast_7d',
      entity_id: 'sensor.solar_forecast_7d',
      unique_id: 'solar_forecast_7d',
      name: 'Solar Forecast Next 7 Days',
      unit_of_measurement: 'kWh',
      device_class: 'energy',
      state_class: 'measurement',
      icon: 'mdi:calendar-week',
      state: String(sum7d),
      attributes: {
        model_accuracy_pct: backtestSummary?.cumulative_accuracy_pct || 97.9,
        model_mae_kwh: backtestSummary?.mae_kwh || 1.78,
        forecast_days: forecastDays.map((d) => ({
          date: d.date,
          projected_kwh: d.projected_kwh,
          clear_sky_kwh: d.clear_sky_potential_kwh,
          sunshine_hours: d.sunshine_hours,
          effective_cloud_pct: d.effective_cloud_cover,
          radiation_mj: d.radiation_sum,
          weather_label: d.weather_label,
          temp_max_f: d.temp_max_f
        }))
      }
    }
  ];

  const mqttPublish = async (topic, payloadObjOrStr) => {
    await fetch(`${HA_URL}/api/services/mqtt/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        topic,
        retain: true,
        payload:
          typeof payloadObjOrStr === 'string'
            ? payloadObjOrStr
            : JSON.stringify(payloadObjOrStr)
      })
    });
  };

  await Promise.all(
    sensors.map(async (s) => {
      try {
        const baseTopic = `solar_forecast/${s.key}`;
        const configTopic = `homeassistant/sensor/solar_forecast/${s.key}/config`;
        await mqttPublish(configTopic, {
          name: s.name,
          has_entity_name: false,
          unique_id: s.unique_id,
          default_entity_id: s.entity_id,
          state_topic: `${baseTopic}/state`,
          json_attributes_topic: `${baseTopic}/attributes`,
          unit_of_measurement: s.unit_of_measurement,
          device_class: s.device_class,
          state_class: s.state_class,
          icon: s.icon,
          device: deviceBlock
        });
        await mqttPublish(`${baseTopic}/state`, s.state);
        await mqttPublish(`${baseTopic}/attributes`, s.attributes);
      } catch (err) {
        console.error(`Failed to publish MQTT sensor ${s.entity_id}:`, err.message);
      }
    })
  );
}

async function fetchCurrentStates(token) {
  const entities = [
    detectedEntities.power,
    detectedEntities.energy,
    detectedEntities.soc,
    detectedEntities.grid,
    detectedEntities.load
  ].filter(Boolean);
  const results = {};
  await Promise.all(
    entities.map(async (id) => {
      try {
        const res = await fetch(`${HA_URL}/api/states/${id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          results[id] = {
            state: parseFloat(data.state),
            raw_state: data.state,
            unit: data.attributes?.unit_of_measurement || '',
            friendly_name: data.attributes?.friendly_name || id,
            last_updated: data.last_updated
          };
        }
      } catch (_) {}
    })
  );
  return results;
}

function getLocalDateHour(msOrIso) {
  const d = new Date(msOrIso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: locationConfig.timezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false
  }).formatToParts(d);
  const get = (t) => parts.find((x) => x.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const hour = parseInt(get('hour'), 10) % 24;
  return { date, hour };
}

function getTodayDateStr() {
  return getLocalDateHour(Date.now()).date;
}

// Astronomical + thermal clear-sky daily potential curve (calibrated to unshaded solar array)
// Accounts for solar declination/elevation, daylight duration, and rooftop panel thermal derating (-0.28% per °F above 58°F)
function getClearSkyPotential(dateStr, tempMaxF = 58) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const startOfYear = new Date(Date.UTC(d.getUTCFullYear(), 0, 0));
  const doy = Math.floor((d - startOfYear) / 86400000);
  const radians = ((2 * Math.PI) / 365) * (doy - 172); // peak at summer solstice (DOY 172)
  const cosFactor = (1 + Math.cos(radians)) / 2; // 1 at Jun 21, 0 at Dec 21
  let baseClear = 13.5 + 44.5 * Math.pow(cosFactor, 0.92);
  if (cosFactor < 0.26) {
    // Low winter sun horizon drop-off (after Oct 20 into Dec 21)
    baseClear -= (0.26 - cosFactor) * 16.5;
  }
  const tempDiff = (tempMaxF ?? 58) - 58;
  const tempFactor = 1 - tempDiff * 0.0028;
  return baseClear * tempFactor;
}

// Clear-sky hourly profile (in EDT/solar-aligned hours 0..23) normalized to sum = 1.0
function getClearSkyHourlyShape(dateStr) {
  // Determine if dateStr is in EST (after Nov 1, 2026) or EDT
  const isEST = dateStr >= '2026-11-01' || dateStr < '2026-03-08';
  if (isEST) {
    // Calibrated directly from Nov 1-2 clear EST solar hours (peaks 11h-12h EST)
    return [
      0, 0, 0, 0, 0, 0,
      0.000, // 06h
      0.011, // 07h
      0.053, // 08h
      0.138, // 09h
      0.172, // 10h
      0.189, // 11h (Solar Noon Peak)
      0.183, // 12h
      0.152, // 13h
      0.090, // 14h
      0.011, // 15h
      0.001, // 16h
      0, 0, 0, 0, 0, 0, 0
    ];
  }
  // Base shape in EDT (from Sept 23-25 & Oct clear days, peaks 12h-13h EDT)
  return [
    0, 0, 0, 0, 0, 0, 0,
    0.003, // 07h
    0.011, // 08h
    0.042, // 09h
    0.128, // 10h
    0.155, // 11h
    0.171, // 12h (Solar Noon Peak)
    0.163, // 13h
    0.143, // 14h
    0.115, // 15h
    0.045, // 16h
    0.022, // 17h
    0.002, // 18h
    0, 0, 0, 0, 0
  ];
}

// Shift an hourly array (length 24) if converting between EDT and EST so solar noon aligns
function alignHoursForDST(hoursArr, sourceDateStr, targetDateStr) {
  const sourceEST = sourceDateStr >= '2026-11-01' || sourceDateStr < '2026-03-08';
  const targetEST = targetDateStr >= '2026-11-01' || targetDateStr < '2026-03-08';
  if (sourceEST === targetEST) return hoursArr;
  const shifted = Array(24).fill(0);
  if (!sourceEST && targetEST) {
    // EDT -> EST: shift 1 hour earlier (12h EDT becomes 11h EST)
    for (let h = 1; h < 24; h++) shifted[h - 1] = hoursArr[h];
  } else {
    // EST -> EDT: shift 1 hour later
    for (let h = 0; h < 23; h++) shifted[h + 1] = hoursArr[h];
  }
  return shifted;
}

const WEATHER_LABELS = {
  0: { label: 'Clear Sky', icon: '☀️' },
  1: { label: 'Mainly Clear', icon: '🌤️' },
  2: { label: 'Partly Cloudy', icon: '⛅' },
  3: { label: 'Overcast', icon: '☁️' },
  45: { label: 'Foggy', icon: '🌫️' },
  48: { label: 'Rime Fog', icon: '🌫️' },
  51: { label: 'Light Drizzle', icon: '🌦️' },
  53: { label: 'Drizzle', icon: '🌦️' },
  55: { label: 'Heavy Drizzle', icon: '🌧️' },
  61: { label: 'Light Rain', icon: '🌦️' },
  63: { label: 'Moderate Rain', icon: '🌧️' },
  65: { label: 'Heavy Rain', icon: '🌧️' },
  71: { label: 'Light Snow', icon: '🌨️' },
  73: { label: 'Moderate Snow', icon: '❄️' },
  75: { label: 'Heavy Snow', icon: '❄️' },
  80: { label: 'Rain Showers', icon: '🌦️' },
  81: { label: 'Mod. Showers', icon: '🌧️' },
  82: { label: 'Heavy Showers', icon: '⛈️' },
  95: { label: 'Thunderstorm', icon: '⛈️' }
};

function getDaytimeWeatherInfo(effCloud, rawCloud, lowCloud, highCloud, sunPct, daytimeWcodes = []) {
  // Check if significant daytime precipitation (3+ hours between 8 AM and 4 PM)
  const precipCodes = daytimeWcodes.filter((c) => c >= 51);
  if (precipCodes.length >= 3) {
    const maxP = Math.max(...precipCodes);
    if (maxP >= 95) return { label: 'Thunderstorms', icon: '⛈️' };
    if (maxP >= 71 && maxP <= 77) return { label: 'Snow Showers', icon: '🌨️' };
    if (maxP >= 63 || maxP >= 81) return { label: 'Rain', icon: '🌧️' };
    return { label: 'Light Rain / Drizzle', icon: '🌦️' };
  }
  // High thin cirrus day: high raw cloud cover (>55%), but low solar-blocking cloud cover (<45%) and high sunshine (>75%)
  if (rawCloud >= 55 && effCloud <= 45 && highCloud >= 45 && lowCloud <= 25 && sunPct >= 75) {
    return { label: 'Filtered Sun (High Cirrus)', icon: '🌤️' };
  }
  if (effCloud <= 20 || (sunPct >= 90 && effCloud <= 30)) {
    return { label: 'Sunny', icon: '☀️' };
  }
  if (effCloud <= 42 || (sunPct >= 75 && effCloud <= 52)) {
    return { label: 'Mostly Sunny', icon: '🌤️' };
  }
  if (effCloud <= 65) {
    return { label: 'Partly Sunny', icon: '⛅' };
  }
  if (effCloud <= 82) {
    return { label: 'Mostly Cloudy', icon: '🌥️' };
  }
  return { label: 'Overcast (Thick Clouds)', icon: '☁️' };
}

function getSkySummaryNote(w) {
  // Compare morning (8-12) vs afternoon (12-16) low clouds
  const mornLow = w.hourly_cloud_low.slice(8, 12).reduce((a, b) => a + b, 0) / 4;
  const aftnLow = w.hourly_cloud_low.slice(12, 16).reduce((a, b) => a + b, 0) / 4;

  if (w.effective_cloud_cover <= 15) {
    return 'Clear peak solar window (9a–3p)';
  }
  if (w.cloud_high_pct >= 45 && w.cloud_low_pct <= 22 && w.sunshine_pct >= 75) {
    return `High thin cirrus (${w.cloud_cover}% sky, only ${w.effective_cloud_cover}% solar block)`;
  }
  if (mornLow >= 65 && aftnLow <= 35) {
    return `Thick low AM clouds (${Math.round(mornLow)}%), clearing late PM`;
  }
  if (aftnLow >= 65 && mornLow <= 35) {
    return `Sunny AM, thick low clouds rolling in PM (${Math.round(aftnLow)}%)`;
  }
  if (w.cloud_low_pct >= 55) {
    return `Dense low clouds (${w.cloud_low_pct}% low stratus) blocking direct sun`;
  }
  return `Mixed mid/high clouds (${w.effective_cloud_cover}% solar attenuation)`;
}

let cache = { timestamp: 0, data: null };

async function buildDashboardData(forceRefresh = false, forceNewVersion = false) {
  const now = Date.now();
  if (!forceRefresh && !forceNewVersion && cache.data && now - cache.timestamp < 60 * 1000) {
    return cache.data;
  }

  const token = getHAToken();
  await Promise.all([resolveLocation(token), detectSolarEntities(token)]);
  const todayStr = getTodayDateStr();

  // 1. Fetch Home Assistant hourly stats from Aug 20, 2026 to now
  const [haStats, liveStates] = await Promise.all([
    fetchHAStats(token, '2026-08-20T00:00:00Z', new Date(now + 86400000).toISOString()),
    fetchCurrentStates(token)
  ]);

  const powerStats = haStats[detectedEntities.power] || [];
  const genStats = haStats[detectedEntities.energy] || [];

  const haByDay = {};
  for (const p of powerStats) {
    const { date, hour } = getLocalDateHour(p.start);
    if (!haByDay[date]) {
      haByDay[date] = {
        hours: Array(24).fill(0),
        powerSum: 0,
        genSum: 0,
        recordedHours: 0
      };
    }
    const val = Math.max(0, p.mean || 0);
    haByDay[date].hours[hour] = +val.toFixed(3);
    haByDay[date].powerSum += val;
    haByDay[date].recordedHours += 1;
  }

  for (const g of genStats) {
    const { date } = getLocalDateHour(g.start);
    if (!haByDay[date]) {
      haByDay[date] = {
        hours: Array(24).fill(0),
        powerSum: 0,
        genSum: 0,
        recordedHours: 0
      };
    }
    if (typeof g.change === 'number' && g.change > 0) {
      haByDay[date].genSum += g.change;
    }
  }

  // 2. Fetch Open-Meteo Observed Archive (Aug 21 to 3 days ago) + Live HRRR/GFS (past 3 days + 16-day forecast + 15-min high-res radiation)
  // Note: archive-api (ERA5) has a 3-5 day reanalysis lag; api.open-meteo.com/v1/forecast (past_days=3) has live hourly & 15-minute NOAA HRRR 3km satellite/radar observations for recent days & today!
  const threeDaysAgoStr = getLocalDateHour(now - 3 * 86400000).date;
  const lat = locationConfig.latitude;
  const lon = locationConfig.longitude;
  const tz = encodeURIComponent(locationConfig.timezone || 'America/New_York');
  const archUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=2026-08-21&end_date=${todayStr}&hourly=shortwave_radiation,direct_radiation,diffuse_radiation,sunshine_duration,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,weather_code&daily=sunshine_duration,daylight_duration,shortwave_radiation_sum,weather_code,cloud_cover_mean,temperature_2m_max,temperature_2m_min&timezone=${tz}`;
  const foreUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&minutely_15=shortwave_radiation,direct_radiation,diffuse_radiation,sunshine_duration&hourly=shortwave_radiation,direct_radiation,diffuse_radiation,sunshine_duration,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,weather_code&daily=sunshine_duration,daylight_duration,shortwave_radiation_sum,weather_code,cloud_cover_mean,temperature_2m_max,temperature_2m_min&past_days=3&forecast_days=16&timezone=${tz}`;

  const [archRes, foreRes] = await Promise.all([fetch(archUrl), fetch(foreUrl)]);
  const [archJson, foreJson] = await Promise.all([archRes.json(), foreRes.json()]);

  const weatherByDay = {};
  const ingestOpenMeteo = (om, isForecastModel = false) => {
    if (!om || !om.daily || !om.daily.time) return;
    om.daily.time.forEach((dt, idx) => {
      // Keep ERA5 archive for dates older than 3 days ago; use live NOAA HRRR/GFS (foreJson) for the last 3 days, today, and future
      if (
        isForecastModel &&
        dt < threeDaysAgoStr &&
        weatherByDay[dt] &&
        weatherByDay[dt].radiation_sum > 0
      ) {
        return;
      }
      const rawSunHrs = (om.daily.sunshine_duration[idx] || 0) / 3600;
      const dayHrs = (om.daily.daylight_duration[idx] || 12 * 3600) / 3600;
      // Calibrate GFS forecast sunshine duration to match ERA5 observed archive scale (~1.08x at low sun angles)
      const sunHrs = isForecastModel
        ? Math.min(dayHrs * 0.965, rawSunHrs * 1.08)
        : rawSunHrs;
      const wcode = om.daily.weather_code?.[idx] ?? 2;
      weatherByDay[dt] = {
        date: dt,
        sunshine_hours: +sunHrs.toFixed(2),
        daylight_hours: +dayHrs.toFixed(2),
        sunshine_pct: +Math.min(100, (sunHrs / dayHrs) * 100).toFixed(1),
        radiation_sum: +(om.daily.shortwave_radiation_sum?.[idx] || 0).toFixed(2),
        cloud_cover_24h: Math.round(om.daily.cloud_cover_mean?.[idx] || 0),
        cloud_cover: Math.round(om.daily.cloud_cover_mean?.[idx] || 0),
        effective_cloud_cover: Math.round(om.daily.cloud_cover_mean?.[idx] || 0),
        cloud_low_pct: 0,
        cloud_mid_pct: 0,
        cloud_high_pct: 0,
        sky_note: '',
        temp_max_c: om.daily.temperature_2m_max?.[idx],
        temp_max_f:
          om.daily.temperature_2m_max?.[idx] != null
            ? Math.round((om.daily.temperature_2m_max[idx] * 9) / 5 + 32)
            : null,
        weather_code: wcode,
        weather_label: 'Partly Sunny',
        weather_icon: '⛅',
        hourly_radiation: Array(24).fill(0),
        hourly_direct: Array(24).fill(0),
        hourly_sunshine: Array(24).fill(0),
        hourly_cloud: Array(24).fill(0),
        hourly_cloud_low: Array(24).fill(0),
        hourly_cloud_mid: Array(24).fill(0),
        hourly_cloud_high: Array(24).fill(0),
        hourly_wcode: Array(24).fill(0),
        minutely_15_rad: []
      };
    });

    if (om.minutely_15 && om.minutely_15.time) {
      om.minutely_15.time.forEach((iso, idx) => {
        const [dt, timePart] = iso.split('T');
        if (weatherByDay[dt]) {
          weatherByDay[dt].minutely_15_rad.push({
            time: iso,
            hhmm: timePart.slice(0, 5),
            rad_wm2: Math.round(om.minutely_15.shortwave_radiation?.[idx] || 0),
            direct_wm2: Math.round(om.minutely_15.direct_radiation?.[idx] || 0)
          });
        }
      });
    }

    if (om.hourly && om.hourly.time) {
      om.hourly.time.forEach((iso, idx) => {
        const [dt, hrPart] = iso.split('T');
        if (isForecastModel && dt < threeDaysAgoStr && weatherByDay[dt]?.hourly_radiation?.some((v) => v > 0)) {
          return;
        }
        const hr = parseInt(hrPart.split(':')[0], 10);
        if (weatherByDay[dt] && hr >= 0 && hr < 24) {
          weatherByDay[dt].hourly_radiation[hr] = om.hourly.shortwave_radiation?.[idx] || 0;
          weatherByDay[dt].hourly_direct[hr] = om.hourly.direct_radiation?.[idx] || 0;
          weatherByDay[dt].hourly_sunshine[hr] = +((om.hourly.sunshine_duration?.[idx] || 0) / 3600).toFixed(2);
          weatherByDay[dt].hourly_cloud[hr] = om.hourly.cloud_cover?.[idx] ?? 0;
          weatherByDay[dt].hourly_cloud_low[hr] = om.hourly.cloud_cover_low?.[idx] ?? 0;
          weatherByDay[dt].hourly_cloud_mid[hr] = om.hourly.cloud_cover_mid?.[idx] ?? 0;
          weatherByDay[dt].hourly_cloud_high[hr] = om.hourly.cloud_cover_high?.[idx] ?? 0;
          weatherByDay[dt].hourly_wcode[hr] = om.hourly.weather_code?.[idx] ?? 0;
        }
      });
    }

    // Compute Daytime Cloud Cover, Solar-Weighted Effective Cloud Cover (Low/Mid/High), & Sky Note
    const solarWeights = { 8: 0.4, 9: 0.8, 10: 1.0, 11: 1.2, 12: 1.2, 13: 1.1, 14: 0.9, 15: 0.5, 16: 0.2 };
    Object.values(weatherByDay).forEach((w) => {
      let rawSum = 0, effSum = 0, lowSum = 0, midSum = 0, highSum = 0, wSum = 0;
      for (let hr = 8; hr <= 16; hr++) {
        const wt = solarWeights[hr] || 0;
        const tot = w.hourly_cloud[hr] || 0;
        const low = w.hourly_cloud_low[hr] || 0;
        const mid = w.hourly_cloud_mid[hr] || 0;
        const high = w.hourly_cloud_high[hr] || 0;
        // Low stratus/cumulus blocks ~100% direct beam, Mid altostratus ~60%, High thin cirrus ~20%
        const eff = Math.min(100, Math.max(low, mid * 0.6, high * 0.2, low * 0.75 + mid * 0.4 + high * 0.15));
        rawSum += tot * wt;
        effSum += eff * wt;
        lowSum += low * wt;
        midSum += mid * wt;
        highSum += high * wt;
        wSum += wt;
      }
      w.cloud_cover = Math.round(rawSum / wSum);
      w.effective_cloud_cover = Math.round(effSum / wSum);
      w.cloud_low_pct = Math.round(lowSum / wSum);
      w.cloud_mid_pct = Math.round(midSum / wSum);
      w.cloud_high_pct = Math.round(highSum / wSum);

      const daytimeWcodes = w.hourly_wcode.slice(8, 17);
      const info = getDaytimeWeatherInfo(
        w.effective_cloud_cover,
        w.cloud_cover,
        w.cloud_low_pct,
        w.cloud_high_pct,
        w.sunshine_pct,
        daytimeWcodes
      );
      w.weather_label = info.label;
      w.weather_icon = info.icon;
      w.sky_note = getSkySummaryNote(w);
    });
  };

  ingestOpenMeteo(archJson, false);
  ingestOpenMeteo(foreJson, true);

  // 3. Build unified historical days (Aug 21, 2026 -> today) & Tree Counterfactual Model
  // Clear-sky baseline profiles before and after Sept 23 tree removal:
  const postClear = { 11: 5.21, 12: 5.73, 13: 5.49, 14: 4.82, 15: 3.93, 16: 1.53 };
  const preClearSep = { 11: 5.27, 12: 5.10, 13: 3.41, 14: 1.92, 15: 1.48, 16: 1.43 };
  const preClearAug = { 11: 5.82, 12: 5.18, 13: 3.96, 14: 2.59, 15: 1.53, 16: 1.47 };

  const cachedActuals = {};
  try {
    const dbRows = db.prepare('SELECT * FROM daily_actuals').all();
    for (const r of dbRows) {
      cachedActuals[r.date] = r;
    }
  } catch (_) {}

  const allDates = Object.keys(weatherByDay).sort();
  const historicalDays = [];

  for (const dt of allDates) {
    if (dt < '2026-08-21' || dt > todayStr) continue;
    const ha = haByDay[dt];
    const cached = cachedActuals[dt];
    const w = weatherByDay[dt];
    const clearSkyMax = +getClearSkyPotential(dt, w.temp_max_f).toFixed(2);

    let actualKwh = 0;
    let recordedHours = Array(24).fill(0);

    if (ha && (ha.genSum > 0.5 || ha.powerSum > 0.5)) {
      actualKwh = +(ha.genSum > 0.5 ? ha.genSum : ha.powerSum).toFixed(2);
      recordedHours = ha.hours;
    } else if (cached && cached.actual_kwh > 0) {
      actualKwh = cached.actual_kwh;
      try {
        recordedHours = JSON.parse(cached.hours_actual_json || '[]');
      } catch (_) {
        recordedHours = Array(24).fill(0);
      }
    } else if (dt === todayStr) {
      const liveGen = liveStates[detectedEntities.energy]?.state;
      if (liveGen != null && !isNaN(liveGen) && liveGen > 0) {
        actualKwh = +liveGen.toFixed(2);
      }
    }

    const isPreTree = dt <= '2026-09-22';
    const unshadedHours = [...recordedHours];
    let treeLostKwh = 0;

    if (isPreTree) {
      const dayIndex = (new Date(dt) - new Date('2026-08-21')) / 86400000;
      const t = Math.min(1, Math.max(0, dayIndex / 33)); // 0 on Aug 21 -> 1 on Sep 23
      const seasonalScale = 1.10 * (1 - t) + 1.0 * t;

      for (const h of [12, 13, 14, 15, 16]) {
        const actualH = recordedHours[h] || 0;
        const preClearH = preClearAug[h] * (1 - t) + preClearSep[h] * t;
        const postClearH = postClear[h] * seasonalScale;

        const ratioToShadedCeiling = Math.min(1.08, actualH / preClearH);
        const sunFactor = w.hourly_sunshine[h + 1] ?? w.hourly_sunshine[h] ?? 0;
        const clearness = Math.max(
          ratioToShadedCeiling * 0.75 + sunFactor * 0.25,
          ratioToShadedCeiling * 0.85
        );
        const estUnshadedH = Math.max(
          actualH,
          actualH + (postClearH - preClearH) * Math.pow(Math.min(1.05, clearness), 1.1)
        );
        const gainH = Math.max(0, estUnshadedH - actualH);
        unshadedHours[h] = +(actualH + gainH).toFixed(2);
        treeLostKwh += gainH;
      }
    }

    treeLostKwh = +treeLostKwh.toFixed(2);
    const counterfactualKwh = +(actualKwh + treeLostKwh).toFixed(2);

    const morningKwh = +(
      (recordedHours[8] || 0) +
      (recordedHours[9] || 0) +
      (recordedHours[10] || 0) +
      (recordedHours[11] || 0)
    ).toFixed(2);
    const afternoonKwh = +(
      (recordedHours[12] || 0) +
      (recordedHours[13] || 0) +
      (recordedHours[14] || 0) +
      (recordedHours[15] || 0)
    ).toFixed(2);
    const counterfactualAfternoonKwh = +(
      (unshadedHours[12] || 0) +
      (unshadedHours[13] || 0) +
      (unshadedHours[14] || 0) +
      (unshadedHours[15] || 0)
    ).toFixed(2);

    historicalDays.push({
      date: dt,
      period: isPreTree ? 'pre_tree' : 'post_tree',
      is_today: dt === todayStr,
      actual_kwh: actualKwh,
      tree_lost_kwh: treeLostKwh,
      counterfactual_kwh: counterfactualKwh,
      clear_sky_potential_kwh: clearSkyMax,
      morning_8_12_kwh: morningKwh,
      afternoon_12_16_kwh: afternoonKwh,
      counterfactual_afternoon_12_16_kwh: counterfactualAfternoonKwh,
      hours_actual: recordedHours.map((v) => +v.toFixed(2)),
      hours_counterfactual: unshadedHours.map((v) => +v.toFixed(2)),
      ...w
    });
  }

  // 4. Reference pool of complete post-tree-removal days
  // If it is after 5 PM local time (sun has set), today's solar production is complete and included in the historical reference pool
  const currentLocalHour = getLocalDateHour(now).hour;
  const isTodayComplete = currentLocalHour >= 17;
  const postTreePool = historicalDays.filter(
    (d) =>
      d.date >= '2026-09-23' &&
      (d.date < todayStr || (d.date === todayStr && isTodayComplete)) &&
      d.actual_kwh > 0.5
  );

  // Helper to predict solar for any target date & weather using similar past sunlight days
  function forecastForDay(w) {
    const clearSkyTarget = getClearSkyPotential(w.date, w.temp_max_f);
    const targetRadIndex = w.radiation_sum / Math.max(1, clearSkyTarget);

    // Score every post-tree day (excluding the target date itself) by similarity in sunshine_hours, effective_cloud_cover, and normalized solar radiation
    const scoredMatches = postTreePool
      .filter((past) => past.date !== w.date)
      .map((past) => {
        const sunHoursDiff = Math.abs(past.sunshine_hours - w.sunshine_hours);
        const effCloudDiff = Math.abs((past.effective_cloud_cover || 0) - (w.effective_cloud_cover || 0)) / 12;
        const pastRadIndex = past.radiation_sum / Math.max(1, past.clear_sky_potential_kwh);
        const radIndexDiff = Math.abs(pastRadIndex - targetRadIndex) * 14;
        const distance = sunHoursDiff * 0.35 + effCloudDiff * 0.35 + radIndexDiff * 0.30;

        // Seasonal + radiation clearness adjustment:
        // Scale past day's actual output by target date's astronomical potential AND relative radiation clearness on cloudy days
        const seasonalRatio = clearSkyTarget / past.clear_sky_potential_kwh;
        const radClearnessRatio =
          pastRadIndex > 0.08
            ? Math.min(1.25, Math.max(0.35, targetRadIndex / pastRadIndex))
            : 1.0;
        // On clear days (effCloud < 35%), rely primarily on seasonalRatio; on overcast/rainy days, weight radClearnessRatio heavily
        const cloudBlend = Math.min(1, (w.effective_cloud_cover || 0) / 80);
        const combinedScale =
          seasonalRatio * (1 - cloudBlend * 0.65 + cloudBlend * 0.65 * radClearnessRatio);
        const seasonallyAdjustedKwh = +Math.min(
          clearSkyTarget,
          past.actual_kwh * combinedScale
        ).toFixed(2);

        return {
          date: past.date,
          sunshine_hours: past.sunshine_hours,
          daylight_hours: past.daylight_hours,
          sunshine_pct: past.sunshine_pct,
          radiation_sum: past.radiation_sum,
          cloud_cover: past.cloud_cover,
          weather_icon: past.weather_icon,
          weather_label: past.weather_label,
          effective_cloud_cover: past.effective_cloud_cover,
          cloud_low_pct: past.cloud_low_pct,
          cloud_high_pct: past.cloud_high_pct,
          sky_note: past.sky_note,
          actual_kwh: past.actual_kwh,
          clear_sky_potential_kwh: past.clear_sky_potential_kwh,
          seasonally_adjusted_kwh: seasonallyAdjustedKwh,
          seasonal_scale_factor: +seasonalRatio.toFixed(3),
          sunshine_diff_hrs: +(past.sunshine_hours - w.sunshine_hours).toFixed(2),
          distance: +distance.toFixed(3),
          hours_actual: past.hours_actual
        };
      })
      .sort((a, b) => a.distance - b.distance);

    const topMatches = scoredMatches.slice(0, 5);
    const weights = topMatches.map((m) => 1 / (m.distance + 0.35));
    const weightSum = weights.reduce((acc, v) => acc + v, 0) || 0;

    // 1. Raw average of similar sunlight past days
    const rawSimilarKwh =
      weightSum > 0
        ? +(
            topMatches.reduce((acc, m, idx) => acc + m.actual_kwh * weights[idx], 0) / weightSum
          ).toFixed(1)
        : 0;

    // 2. Seasonally adjusted similar-sunlight forecast
    const seasonalMatchKwh =
      weightSum > 0
        ? topMatches.reduce((acc, m, idx) => acc + m.seasonally_adjusted_kwh * weights[idx], 0) /
          weightSum
        : 0;

    // 3. Physics / radiation clearness model cross-check
    // On clear post-tree days, radiation_sum / clearSkyTarget is ~0.55 - 0.58 MJ/m2 per kWh
    const radRatioToClear = Math.min(1.0, targetRadIndex / 0.56);
    const sunFraction = Math.min(1, (w.sunshine_hours || 0) / Math.max(1, (w.daylight_hours || 10) * 0.94));
    const physicsKwh = Math.min(
      clearSkyTarget,
      clearSkyTarget * (radRatioToClear * 0.65 + Math.pow(sunFraction, 0.85) * 0.35)
    );

    let projectedKwh =
      weightSum > 0
        ? +(seasonalMatchKwh * 0.60 + physicsKwh * 0.40).toFixed(1)
        : +physicsKwh.toFixed(1);

    if (isNaN(projectedKwh) || projectedKwh == null) {
      projectedKwh = +(physicsKwh || 5.0).toFixed(1);
    }
    projectedKwh = Math.max(0.2, Math.min(clearSkyTarget, projectedKwh));

    const minKwh =
      topMatches.length > 0
        ? +Math.max(
            0.5,
            Math.min(...topMatches.slice(0, 3).map((m) => m.seasonally_adjusted_kwh)) * 0.92
          ).toFixed(1)
        : +(projectedKwh * 0.75).toFixed(1);

    const maxKwh =
      topMatches.length > 0
        ? +Math.min(
            clearSkyTarget,
            Math.max(...topMatches.slice(0, 3).map((m) => m.seasonally_adjusted_kwh)) * 1.06
          ).toFixed(1)
        : +Math.min(clearSkyTarget, projectedKwh * 1.25).toFixed(1);

    // Build calibrated hour-level projected curve (0..23):
    // Blend DST-aligned matched historical hourly profiles with Open-Meteo hour-level irradiance (at hr+1) & cloud layers
    const baseShape = getClearSkyHourlyShape(w.date);
    const matchedHourlyAvg = Array(24).fill(0);
    topMatches.forEach((m, idx) => {
      const aligned = alignHoursForDST(m.hours_actual, m.date, w.date);
      const scale = m.seasonal_scale_factor * (weights[idx] / weightSum);
      for (let h = 0; h < 24; h++) {
        matchedHourlyAvg[h] += (aligned[h] || 0) * scale;
      }
    });

    const maxRad = Math.max(250, ...w.hourly_radiation);
    const rawHourly = baseShape.map((sh, hr) => {
      if (sh <= 0 && matchedHourlyAvg[hr] <= 0.02) return 0;
      // Open-Meteo hourly timestamp hr+1 represents average radiation over [hr:00, hr+1:00]
      const omIdx = Math.min(23, hr + 1);
      const rad = w.hourly_radiation[omIdx] ?? w.hourly_radiation[hr] ?? 0;
      const lowCld = w.hourly_cloud_low?.[omIdx] ?? 0;
      const midCld = w.hourly_cloud_mid?.[omIdx] ?? 0;
      const highCld = w.hourly_cloud_high?.[omIdx] ?? 0;
      const effCld = Math.min(100, Math.max(lowCld, midCld * 0.6, highCld * 0.2));
      const cloudTransmittance = 1 - (effCld / 100) * 0.68;
      const radShape = sh * 0.65 * cloudTransmittance + (rad / maxRad) * sh * 0.35;
      // Blend 50% empirical matched-days hourly curve + 50% hourly radiation/cloud physics shape
      return matchedHourlyAvg[hr] * 0.5 + radShape * projectedKwh * 0.5;
    });
    const rawHourlySum = rawHourly.reduce((a, b) => a + b, 0) || 1;
    const hourlyProjected = rawHourly.map((v) => +((v / rawHourlySum) * projectedKwh).toFixed(2));

    // Also build per-hour detail objects (6:00 to 18:00) for the Hour-Level Inspector
    const hourlyBreakdown = Array.from({ length: 24 }, (_, hr) => {
      const omIdx = Math.min(23, hr + 1);
      const low = w.hourly_cloud_low?.[omIdx] ?? 0;
      const mid = w.hourly_cloud_mid?.[omIdx] ?? 0;
      const high = w.hourly_cloud_high?.[omIdx] ?? 0;
      const eff = Math.round(Math.min(100, Math.max(low, mid * 0.6, high * 0.2)));
      return {
        hour: hr,
        label: `${String(hr).padStart(2, '0')}:00`,
        projected_kwh: hourlyProjected[hr],
        radiation_wm2: Math.round(w.hourly_radiation[omIdx] ?? w.hourly_radiation[hr] ?? 0),
        direct_wm2: Math.round(w.hourly_direct[omIdx] ?? w.hourly_direct[hr] ?? 0),
        sunshine_hrs: w.hourly_sunshine[omIdx] ?? w.hourly_sunshine[hr] ?? 0,
        effective_cloud_pct: eff,
        cloud_low_pct: Math.round(low),
        cloud_mid_pct: Math.round(mid),
        cloud_high_pct: Math.round(high)
      };
    });

    // Build 15-minute high-resolution forecast curve (06:00 to 18:00, 48 points per day, or 96 for full day)
    // Uses Open-Meteo native minutely_15 shortwave_radiation where available, or smooth cubic/linear sub-hourly interpolation
    const tzOffset = (w.date >= '2026-11-01' || w.date < '2026-03-08') ? '-05:00' : '-04:00';
    const raw15m = [];
    for (let hr = 0; hr < 24; hr++) {
      const currHrKw = hourlyProjected[hr] || 0;
      const nextHrKw = hourlyProjected[Math.min(23, hr + 1)] || 0;
      const prevHrKw = hourlyProjected[Math.max(0, hr - 1)] || 0;

      for (let q = 0; q < 4; q++) {
        const minStr = String(q * 15).padStart(2, '0');
        const hhmm = `${String(hr).padStart(2, '0')}:${minStr}`;
        const m15Entry = (w.minutely_15_rad || []).find((x) => x.hhmm === hhmm);

        // Smooth sub-hourly curve across the 4 quarters of hour hr
        const frac = (q + 0.5) / 4; // 0.125, 0.375, 0.625, 0.875
        let interpKw = currHrKw;
        if (frac < 0.5) {
          interpKw = currHrKw * (0.5 + frac) + prevHrKw * (0.5 - frac);
        } else {
          interpKw = currHrKw * (1.5 - frac) + nextHrKw * (frac - 0.5);
        }

        // Modulate by native 15-minute radiation variation within the hour if present
        const hrAvgRad = w.hourly_radiation[Math.min(23, hr + 1)] || w.hourly_radiation[hr] || 0;
        const qRad = m15Entry ? m15Entry.rad_wm2 : Math.round(hrAvgRad);
        if (m15Entry && hrAvgRad > 25) {
          const radMod = Math.min(1.35, Math.max(0.4, qRad / hrAvgRad));
          interpKw = interpKw * (0.65 + 0.35 * radMod);
        }

        raw15m.push({
          time: `${w.date}T${hhmm}:00${tzOffset}`,
          hhmm,
          hour: hr,
          raw_kw: Math.max(0, interpKw),
          rad_wm2: qRad
        });
      }
    }

    // Normalize 15-minute kW values so sum(kw * 0.25h) === projectedKwh, and compute cumulative kWh at each 15-minute mark
    const sum15mKwh = raw15m.reduce((acc, p) => acc + p.raw_kw * 0.25, 0) || 1;
    const scale15m = projectedKwh / sum15mKwh;
    let runningCumKwh = 0;
    const forecast15m = raw15m.map((p) => {
      const kw = +(p.raw_kw * scale15m).toFixed(2);
      runningCumKwh += kw * 0.25;
      return {
        time: p.time,
        hhmm: p.hhmm,
        hour: p.hour,
        kw,
        cumulative_kwh: +Math.min(projectedKwh, runningCumKwh).toFixed(2),
        rad_wm2: p.rad_wm2
      };
    });

    return {
      ...w,
      is_today: w.date === todayStr,
      clear_sky_potential_kwh: +clearSkyTarget.toFixed(1),
      projected_kwh: projectedKwh,
      raw_similar_days_kwh: rawSimilarKwh,
      min_kwh: minKwh,
      max_kwh: maxKwh,
      hourly_projected: hourlyProjected,
      hourly_breakdown: hourlyBreakdown,
      forecast_15m: forecast15m,
      similar_past_days: topMatches.map((m) => ({
        ...m,
        hours_aligned: alignHoursForDST(m.hours_actual, m.date, w.date).map((v) => +v.toFixed(2))
      }))
    };
  }

  // 5. Build 16-Day Future Forecast (starting from today)
  const forecastDays = [];
  for (const dt of allDates) {
    if (dt < todayStr) continue;
    const f = forecastForDay(weatherByDay[dt]);
    if (dt === todayStr) {
      const todayHist = historicalDays.find((d) => d.date === todayStr);
      f.actual_so_far_kwh = todayHist ? todayHist.actual_kwh : 0;
      f.hours_actual_today = todayHist ? todayHist.hours_actual : Array(24).fill(0);
    }
    forecastDays.push(f);
  }

  // Save/update immutable versioned forecast snapshots and historical actuals in SQLite
  const { nowIso: dbUpdatedAt, newVersionsInserted } = saveToSQLite(
    todayStr,
    isTodayComplete,
    historicalDays,
    forecastDays,
    forceNewVersion
  );
  const lockedLedger = querySQLiteLedger(todayStr, isTodayComplete);
  const totalVersionsCount = db.prepare('SELECT COUNT(*) as c FROM forecast_versions').get().c;

  // Ensure Today on /forecast uses the locked forecast from SQLite so /forecast, /tracker, and HA sensors always match
  const todayLedgerEntry = lockedLedger.find((r) => r.target_date === todayStr);
  if (todayLedgerEntry && forecastDays[0]?.date === todayStr) {
    const oldProj = forecastDays[0].projected_kwh || 1;
    const newProj = todayLedgerEntry.locked_forecast.projected_kwh;
    const ratio = newProj / oldProj;
    forecastDays[0].recalibrated_kwh = oldProj;
    forecastDays[0].projected_kwh = newProj;
    if (todayLedgerEntry.hourly_projected?.length === 24) {
      forecastDays[0].hourly_projected = todayLedgerEntry.hourly_projected;
    }
    if (forecastDays[0].forecast_15m?.length) {
      let runCum = 0;
      forecastDays[0].forecast_15m = forecastDays[0].forecast_15m.map((p) => {
        const kw = +(p.kw * ratio).toFixed(2);
        runCum += kw * 0.25;
        return {
          ...p,
          kw,
          cumulative_kwh: +Math.min(newProj, runCum).toFixed(2)
        };
      });
    }
  }

  // Also compute Leave-One-Out Historical Backtest for Sept 23 -> Today (including hourly actual vs projected)
  const backtestDays = postTreePool.map((d) => {
    const sim = forecastForDay(weatherByDay[d.date]);
    const diffKwh = +(d.actual_kwh - sim.projected_kwh).toFixed(2);
    const absErr = +Math.abs(diffKwh).toFixed(2);
    return {
      target_date: d.date,
      projected_kwh: sim.projected_kwh,
      raw_similar_days_kwh: sim.raw_similar_days_kwh,
      actual_kwh: d.actual_kwh,
      diff_kwh: diffKwh,
      abs_error_kwh: absErr,
      sunshine_hours: d.sunshine_hours,
      radiation_sum: d.radiation_sum,
      effective_cloud_cover: d.effective_cloud_cover,
      weather_label: d.weather_label,
      weather_icon: d.weather_icon,
      hourly_projected: sim.hourly_projected,
      hourly_breakdown: sim.hourly_breakdown,
      hours_actual: d.hours_actual
    };
  });

  const meanAbsError = +(
    backtestDays.reduce((a, b) => a + b.abs_error_kwh, 0) / Math.max(1, backtestDays.length)
  ).toFixed(2);
  const totalBacktestPred = +backtestDays.reduce((a, b) => a + b.projected_kwh, 0).toFixed(1);
  const totalBacktestAct = +backtestDays.reduce((a, b) => a + b.actual_kwh, 0).toFixed(1);

  // 6. Summary Rollups for Tree Removal Analysis (Aug 21 - Sept 22 & Full Sept)
  const augPreDays = historicalDays.filter((d) => d.date >= '2026-08-21' && d.date <= '2026-08-31');
  const sepPreDays = historicalDays.filter((d) => d.date >= '2026-09-01' && d.date <= '2026-09-22');
  const sepPostDays = historicalDays.filter((d) => d.date >= '2026-09-23' && d.date <= '2026-09-30');
  const fullSepDays = historicalDays.filter((d) => d.date >= '2026-09-01' && d.date <= '2026-09-30');
  const allPreTreeDays = [...augPreDays, ...sepPreDays];

  const sumField = (arr, field) => +arr.reduce((acc, x) => acc + (x[field] || 0), 0).toFixed(1);

  const treeImpactSummary = {
    aug_21_31: {
      days_count: augPreDays.length,
      actual_kwh: sumField(augPreDays, 'actual_kwh'),
      lost_kwh: sumField(augPreDays, 'tree_lost_kwh'),
      counterfactual_kwh: sumField(augPreDays, 'counterfactual_kwh'),
      pct_gain: +(
        (sumField(augPreDays, 'tree_lost_kwh') / Math.max(1, sumField(augPreDays, 'actual_kwh'))) *
        100
      ).toFixed(1),
      days_over_34_actual: augPreDays.filter((d) => d.actual_kwh >= 33.5).length,
      days_over_34_counterfactual: augPreDays.filter((d) => d.counterfactual_kwh >= 33.5).length
    },
    sep_01_22: {
      days_count: sepPreDays.length,
      actual_kwh: sumField(sepPreDays, 'actual_kwh'),
      lost_kwh: sumField(sepPreDays, 'tree_lost_kwh'),
      counterfactual_kwh: sumField(sepPreDays, 'counterfactual_kwh'),
      pct_gain: +(
        (sumField(sepPreDays, 'tree_lost_kwh') / Math.max(1, sumField(sepPreDays, 'actual_kwh'))) *
        100
      ).toFixed(1),
      days_over_33_actual: sepPreDays.filter((d) => d.actual_kwh >= 33.0).length,
      days_over_33_counterfactual: sepPreDays.filter((d) => d.counterfactual_kwh >= 33.0).length
    },
    sep_full_month: {
      days_count: fullSepDays.length,
      actual_kwh: sumField(fullSepDays, 'actual_kwh'),
      lost_kwh: sumField(fullSepDays, 'tree_lost_kwh'),
      counterfactual_kwh: sumField(fullSepDays, 'counterfactual_kwh'),
      sep_23_30_actual_kwh: sumField(sepPostDays, 'actual_kwh')
    },
    total_aug21_sep22: {
      days_count: allPreTreeDays.length,
      actual_kwh: sumField(allPreTreeDays, 'actual_kwh'),
      lost_kwh: sumField(allPreTreeDays, 'tree_lost_kwh'),
      counterfactual_kwh: sumField(allPreTreeDays, 'counterfactual_kwh'),
      pct_gain: +(
        (sumField(allPreTreeDays, 'tree_lost_kwh') /
          Math.max(1, sumField(allPreTreeDays, 'actual_kwh'))) *
        100
      ).toFixed(1),
      est_value_usd_at_25c: +(sumField(allPreTreeDays, 'tree_lost_kwh') * 0.25).toFixed(2)
    },
    benchmark_sep23: historicalDays.find((d) => d.date === '2026-09-23') || null,
    benchmark_aug21: historicalDays.find((d) => d.date === '2026-08-21') || null
  };

  // Build 15-minute cumulative curves (06:00 to 18:00) for Today Actual, Yesterday Actual, and 7-Day Average
  // so both the main dashboard and /ha-card can plot the full 7 AM - 5 PM intraday cumulative S-curves ahead of time!
  function build15mCumulativeFromHourly(hoursArr, stopAtHour = 24) {
    const pts = [];
    let cum = 0;
    for (let hr = 6; hr <= 18; hr++) {
      const hrKwh = hoursArr?.[hr] || 0;
      for (let q = 0; q < 4; q++) {
        const hhmm = `${String(hr).padStart(2, '0')}:${String(q * 15).padStart(2, '0')}`;
        if (hr > stopAtHour || (hr === stopAtHour && q > 0)) {
          pts.push({ hhmm, hour: hr, cumulative_kwh: null });
        } else {
          if (hr < stopAtHour) {
            cum += hrKwh * 0.25;
          }
          pts.push({ hhmm, hour: hr, cumulative_kwh: +cum.toFixed(2) });
        }
      }
    }
    return pts;
  }

  const yesterdayHist = historicalDays.length >= 2
    ? historicalDays[historicalDays.length - 2]
    : historicalDays[0];
  const last7Hist = historicalDays.slice(-8, -1);
  const avg7Hours = Array(24).fill(0);
  if (last7Hist.length > 0) {
    for (let h = 0; h < 24; h++) {
      avg7Hours[h] = last7Hist.reduce((acc, d) => acc + (d.hours_actual?.[h] || 0), 0) / last7Hist.length;
    }
  }
  const todayHistObj = historicalDays.find((d) => d.date === todayStr);
  const stopHr = isTodayComplete ? 24 : currentLocalHour;

  const intradayCumulative = {
    labels_15m: (forecastDays[0]?.forecast_15m || [])
      .filter((p) => p.hour >= 6 && p.hour <= 18)
      .map((p) => p.hhmm),
    today_actual_kwh: todayHistObj?.actual_kwh || 0,
    today_actual_15m: build15mCumulativeFromHourly(todayHistObj?.hours_actual || Array(24).fill(0), stopHr).map(
      (p) => p.cumulative_kwh
    ),
    today_forecast_kwh: forecastDays[0]?.projected_kwh || 0,
    today_forecast_15m: (forecastDays[0]?.forecast_15m || [])
      .filter((p) => p.hour >= 6 && p.hour <= 18)
      .map((p) => p.cumulative_kwh),
    tomorrow_date: forecastDays[1]?.date || '',
    tomorrow_forecast_kwh: forecastDays[1]?.projected_kwh || 0,
    tomorrow_forecast_15m: (forecastDays[1]?.forecast_15m || [])
      .filter((p) => p.hour >= 6 && p.hour <= 18)
      .map((p) => p.cumulative_kwh),
    yesterday_date: yesterdayHist?.date || '',
    yesterday_kwh: yesterdayHist?.actual_kwh || 0,
    yesterday_15m: build15mCumulativeFromHourly(yesterdayHist?.hours_actual || Array(24).fill(0), 24).map(
      (p) => p.cumulative_kwh
    ),
    avg_7d_kwh: +avg7Hours.reduce((a, b) => a + b, 0).toFixed(2),
    avg_7d_15m: build15mCumulativeFromHourly(avg7Hours, 24).map((p) => p.cumulative_kwh)
  };

  const result = {
    generated_at: new Date().toISOString(),
    today_date: todayStr,
    location: {
      latitude: locationConfig.latitude,
      longitude: locationConfig.longitude,
      timezone: locationConfig.timezone,
      name: locationConfig.name
    },
    live_states: liveStates,
    live_summary: {
      solar_power_kw: liveStates[detectedEntities.power]?.state ?? null,
      battery_soc_pct: liveStates[detectedEntities.soc]?.state ?? null,
      load_power_kw: liveStates[detectedEntities.load]?.state ?? null,
      grid_power_kw: liveStates[detectedEntities.grid]?.state ?? null
    },
    intraday_cumulative: intradayCumulative,
    tree_impact_summary: treeImpactSummary,
    historical_days: historicalDays,
    forecast_days: forecastDays,
    post_tree_reference_days: postTreePool,
    forecast_tracking: {
      storage_file: DB_FILE,
      storage_engine: 'SQLite Append-Only Versioned (forecast_versions)',
      updated_at: dbUpdatedAt,
      new_versions_inserted: newVersionsInserted,
      total_versions_count: totalVersionsCount,
      locked_count: lockedLedger.length,
      locked_ledger: lockedLedger,
      backtest_summary: {
        days_evaluated: backtestDays.length,
        mae_kwh: meanAbsError,
        total_projected_kwh: totalBacktestPred,
        total_actual_kwh: totalBacktestAct,
        cumulative_accuracy_pct: +(
          (1 - Math.abs(totalBacktestAct - totalBacktestPred) / Math.max(1, totalBacktestAct)) *
          100
        ).toFixed(1)
      },
      backtest_days: backtestDays
    }
  };

  // Push ahead-of-time 15-minute & daily forecast sensors directly into Home Assistant
  await publishSensorsToHA(token, forecastDays, result.forecast_tracking.backtest_summary);

  cache = { timestamp: now, data: result };
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/solar-dashboard') {
    try {
      const force = url.searchParams.get('refresh') === '1';
      const snap = url.searchParams.get('snapshot') === '1';
      const data = await buildDashboardData(force || snap, snap);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error('Error building dashboard data:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Serve static files from public/, falling back to index.html for SPA routes (/forecast, /tree-impact, /simulator, /tracker)
  if (url.pathname === '/ha-card') {
    const haCardPath = path.join(__dirname, 'public', 'ha-card.html');
    fs.readFile(haCardPath, (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(content);
    });
    return;
  }
  const spaRoutes = new Set(['/', '/forecast', '/tree', '/tree-impact', '/simulator', '/correlation', '/tracker', '/tracking']);
  const requestedPath = spaRoutes.has(url.pathname) ? 'index.html' : url.pathname;
  let filePath = path.join(__dirname, 'public', requestedPath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    const mime =
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json'
      }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(content);
  });
});

let lastBackgroundSyncMs = 0;
let lastBackgroundSyncDate = '';

async function runBackgroundSyncIfNeeded() {
  const now = Date.now();
  const todayStr = getTodayDateStr();
  const hoursElapsed = (now - lastBackgroundSyncMs) / 3600000;

  // Trigger immediately on startup, when waking from MacBook sleep after >= 3 hours of wall-clock time,
  // or as soon as the calendar date rolls over (or after 5 PM sunset to finalize today's actuals)
  const currentHour = getLocalDateHour(now).hour;
  const lastHour = lastBackgroundSyncMs > 0 ? getLocalDateHour(lastBackgroundSyncMs).hour : -1;
  const crossedSunset = currentHour >= 17 && lastHour < 17;

  if (
    lastBackgroundSyncMs === 0 ||
    todayStr !== lastBackgroundSyncDate ||
    hoursElapsed >= 3.0 ||
    crossedSunset
  ) {
    lastBackgroundSyncMs = now;
    lastBackgroundSyncDate = todayStr;
    try {
      await buildDashboardData(true, false);
    } catch (err) {
      console.error('Background sync error:', err.message);
    }
  } else if (cache.data) {
    // Re-publish HA sensors (including current 15-minute slot kW) every 60s/5m so standard HA graphs & HA restarts stay populated
    try {
      await publishSensorsToHA(
        getHAToken(),
        cache.data.forecast_days,
        cache.data.forecast_tracking?.backtest_summary
      );
    } catch (_) {}
  }
}

server.listen(PORT, () => {
  console.log(`Solar Intelligence Dashboard running at http://localhost:${PORT}`);
  // Initial sync on startup
  runBackgroundSyncIfNeeded();
  // Check wall-clock time every 60 seconds so waking a MacBook Air from sleep immediately triggers a sync
  // without waiting for monotonic timers or requiring the user to open the browser GUI
  setInterval(runBackgroundSyncIfNeeded, 60 * 1000);
});

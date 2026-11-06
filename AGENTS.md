# Home Assistant Pi Agent Guidelines

This directory is configured to interface with a local Home Assistant instance using Python or Node.js scripts via Home Assistant's REST and WebSocket APIs.

---

## 📌 Agent Rules & Maintenance

- **Entity Documentation & Freshness Rule:**
  - **Document New Entities:** Whenever discovering, querying, or discussing a sensor, switch, light, climate control, automation, or other entity, immediately record it in **Section 3: Key Entities & Setup Context** with its entity ID, friendly name, and what it measures or controls.
  - **Keep It Up-to-Date:** Continuously maintain and refine this file as new information emerges. If an entity's name, role, unit, room mapping, or behavior changes (or if an entity is removed or replaced), update the documentation in this file to reflect current reality.
  - **Maintain Context Notes:** Record operational baselines, physical changes (e.g., equipment additions, tree trimmings, hardware updates), and analytical insights so future sessions retain full context.

---

## 1. Connection & Credentials

- **Base URL:** `http://homeassistant.local:8123`
- **Authentication:** Long-Lived Access Token.
- **Token Location:** Supplied dynamically via 1Password Developer Environment through the `.env` file (`HOME_ASSISTANT_TOKEN`).
  - *Important note on `.env`:* `.env` is a UNIX named pipe (FIFO) managed by 1Password. Standard file reads (`cat .env`, Node `fs.readFileSync('.env')`, Python `open('.env').read()`) work seamlessly, but avoid non-blocking or stat-dependent file watchers.

### Reading Token Example (Node.js)
```javascript
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const token = env.split('\n')
  .find(line => line.startsWith('HOME_ASSISTANT_TOKEN='))
  ?.split('=')[1]?.trim()?.replace(/^["']|["']$/g, '');
```

### Reading Token Example (Python)
```python
import subprocess

env_out = subprocess.run(['cat', '.env'], capture_output=True, text=True, timeout=5).stdout
token = None
for line in env_out.splitlines():
    if line.startswith('HOME_ASSISTANT_TOKEN='):
        token = line.split('=', 1)[1].strip().strip('\"\'')
        break
```

---

## 2. API Usage Patterns

### A. REST API (Current State & Quick Queries)
All REST requests require the header:
```
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
Content-Type: application/json
```

- **Check API Status:**
  `GET http://homeassistant.local:8123/api/`
- **List All Entity States:**
  `GET http://homeassistant.local:8123/api/states`
- **Get Specific Entity:**
  `GET http://homeassistant.local:8123/api/states/<entity_id>`
- **Short-Term History (Recorder):**
  `GET http://homeassistant.local:8123/api/history/period/<ISO_TIMESTAMP>?filter_entity_id=<entity_id>&minimal_response=true&no_attributes=true`
- **Call Service:**
  `POST http://homeassistant.local:8123/api/services/<domain>/<service>` with JSON payload.

### B. WebSocket API (Long-Term Statistics / LTS)
Home Assistant retains hourly statistics (`mean`, `min`, `max`, `sum`, `state`, `change`) permanently. Use Node's built-in `WebSocket` to query historical trends going back weeks, months, or years.

- **WebSocket URL:** `ws://homeassistant.local:8123/api/websocket`
- **Handshake Flow:**
  1. Receive `{"type": "auth_required"}`
  2. Send `{"type": "auth", "access_token": token}`
  3. Receive `{"type": "auth_ok"}`
- **Query Hourly Statistics Message:**
  ```json
  {
    "id": 1,
    "type": "recorder/statistics_during_period",
    "start_time": "2026-08-01T00:00:00Z",
    "end_time": "2026-10-23T23:59:59Z",
    "period": "hour",
    "statistic_ids": [
      "sensor.solar_power",
      "sensor.solar_generated"
    ]
  }
  ```

---

## 3. Key Entities & Setup Context

### Powerwall & Solar Setup
- `sensor.solar_power`: Real-time solar production rate (kW).
- `sensor.solar_generated`: Cumulative solar energy produced (kWh).
- `sensor.grid_power`: Real-time grid flow (negative = exporting to grid, kW).
- `sensor.battery_power`: Real-time Powerwall battery charging/discharging (kW).
- `sensor.percentage_charged`: Current Powerwall battery SOC (%).
- `sensor.home_usage`: Cumulative house consumption (kWh).
- `sensor.load_power`: Real-time whole-house power load (kW).
- `sensor.solar_yesterday`: Yesterday's cumulative solar generation at the current time of day (kWh).
- `sensor.solar_expected_today_7d_avg`: 7-day average cumulative expected solar at the current time of day (kWh).
- `sensor.solar_expected_today_30d_avg`: 30-day average cumulative expected solar at the current time of day (kWh).
- `sensor.solar_expected_today_weather_forecast`: Intraday cumulative expected solar at the current time of day (kWh) based on our Open-Meteo weather forecast model, updated every 60 seconds from `0.00 kWh` at sunrise up to the full-day projected `kWh` at sunset (`friendly_name: "Solar Expected Today (Weather Forecast)"`, designed to sit alongside `sensor.solar_generated`, `sensor.solar_yesterday`, `sensor.solar_expected_today_7d_avg`, and `sensor.solar_expected_today_30d_avg` on the `solar generated (12h)` History Graph card).
- `sensor.powerwall_1_average_daily_solar_7d`: 7-day average daily solar production.
- `sensor.solar_forecast_today`: Today's projected solar generation (kWh) published by `dashboard/server.js`; includes ahead-of-time 15-minute power series in `attributes.forecast_15m` (`[{time, kw, rad_wm2}, ...]`) and 48-hour 15-minute series in `attributes.forecast_48h_15m`.
- `sensor.solar_forecast_tomorrow`: Tomorrow's projected solar generation (kWh) published by `dashboard/server.js`; includes ahead-of-time 15-minute power series in `attributes.forecast_15m`.
- `sensor.solar_forecast_7d`: Next 7 days cumulative projected solar generation (kWh) published by `dashboard/server.js`; includes 16-day daily forecast array in `attributes.forecast_days`.

### Backup / Portable Power Station
- `sensor.solix_f3800_solar_power`: Anker SOLIX F3800 portable solar power (W).
- `sensor.solix_f3800_solar_pv1`: SOLIX PV input 1 (W).
- `sensor.solix_f3800_solar_pv2`: SOLIX PV input 2 (W).
- `sensor.solix_f3800_battery_energy`: SOLIX battery capacity/energy stored (Wh).

### Energy Monitoring & Major Appliances
- `sensor.current_consumption`: Helper group summing sub-metered active device power (W).
- `sensor.hpwh_daily_energy`: Heat pump water heater daily energy (kWh).
- `sensor.water_heater_esphome_power`: Real-time heat pump water heater power draw (W).
- `sensor.water_heater_esphome_energy`: Cumulative water heater ESPHome monitor (kWh).
- `sensor.charger_1_power_minute_average`: Real-time EV Charger power (W).
- `sensor.charger_1_energy_today`: EV Charger energy today (kWh).
- `sensor.charger_1_energy_this_month`: EV Charger energy this month (kWh).
- `sensor.master_air_conditioner_energy_today`: Master bedroom AC energy today (Wh).
- `sensor.living_room_paul_side_outlet_energy`: Living room outlet energy monitor (kWh).
- `sensor.basement_fan_strip_hpwh_monitor_energy`: Basement energy monitor (kWh).
- `sensor.national_grid_current_bill`: National Grid electric utility bill tracking ($) (redacted account ID).
- `sensor.net_grid_usage_today`: Net grid electricity consumption today (kWh).

### Climate & Heating (Nest)
- `climate.google_nest`: Google Nest thermostat entity (HVAC mode, target temperature; action reported in attribute `hvac_action`: `heating`, `idle`, `off`).
- `sensor.google_nest_temperature`: Ambient room temperature measured by Nest (°F).
- `sensor.google_nest_humidity`: Relative humidity measured by Nest (%).
- `binary_sensor.nest_heating`: Template binary sensor indicating if the furnace is actively firing (`on` when `hvac_action == 'heating'`).
- `sensor.nest_heating_today`: Total daily heating run time (`history_stats`, hours).
- `sensor.nest_heating_weekly`: Weekly cumulative heating run time (hours).
- `sensor.nest_heating_month`: Monthly cumulative heating run time (hours).
- *Integration Notes:* Google SDM integration uses Google Cloud OAuth & Cloud Pub/Sub. The Google Cloud OAuth consent app was moved from "Testing" (which enforces a 7-day token expiration causing Pub/Sub dropouts like the flatline on Oct 27-28) to "Published/Production" to ensure perpetual refresh tokens.

### Solar Geometry & Shading Notes
- **August 21 Event (First Day of Allowed Exporting):** Produced **34.0 kWh** actual on the first day of allowed grid export (`2026-08-21`), despite the afternoon shading tree still standing (clipping 2 PM to 2.59 kW and 3 PM to 1.84 kW before rebounding to 2.34 kW at 5 PM once the sun passed the west side of the tree). Because late August had 13.66 hours of daylight and ~60° solar elevation, extra early-morning and late-afternoon output compensated for the afternoon shade. Without the tree, August 21 would have produced **~43.3 kWh**.
- **September 23 Event (Tree Removal):** A shading tree on the property was removed by noon on September 23. This increased afternoon solar production from 12:30 PM to 4:00 PM by ~7.5 to 9.5 kWh per sunny day (jumping daily sunny output from ~24–27 kWh in Sept 1–22 back up to **34.2 kWh** on Sept 23).
- **Counterfactual Tree Loss (Aug 21 – Sept 22):**
  - **Sept 1 – Sept 22 (22 days):** Produced **454.3 kWh** actual; would have produced **~596.4 kWh** without the tree (**+142.2 kWh** lost, or +31.3%). Full September 2026 would have been **~751.1 kWh** instead of **608.9 kWh**, with 8 additional days in Sept 1–22 exceeding 33+ kWh.
  - **Aug 21 – Aug 31 (11 days):** Produced **283.6 kWh** actual; would have produced **~369.2 kWh** without the tree (**+85.6 kWh** lost).
  - **Combined (Aug 21 – Sept 22, 33 days):** **+227.7 kWh** lost to afternoon tree shade (`737.9 kWh` actual vs `965.6 kWh` unshaded).
- **Seasonal Fall Progression:** Solar output in fall declines steadily into the Winter Solstice (~Dec 21). Morning production starts progressively later due to daylight hours shrinking and solar elevation dropping from ~48° (late Sept) down to ~24° (late Dec). Peak midday power also decreases proportionally (~5.7 kW in Sept to ~4.5 kW in late Oct).

---

## 4. Local Solar Forecast & Counterfactual Dashboard

A local web application and background snapshot service is installed in `dashboard/` and served at **`http://localhost:3030`**.

### Architecture & File Paths
- **Backend Server:** `dashboard/server.js` (Node.js HTTP server + `node:sqlite` + Home Assistant WebSocket/REST + Open-Meteo APIs).
- **Frontend UI:** `dashboard/public/index.html` (4-tab interactive Chart.js dashboard).
- **SQLite Database:** `dashboard/data/solar_forecasts.db` (WAL mode, native `node:sqlite`).
  - `forecast_versions` table: Append-only, immutable versioned 16-day forecast snapshots (`UNIQUE(target_date, version)`). Records `projected_kwh`, `raw_similar_days_kwh`, `sunshine_hours`, `daylight_hours`, `radiation_sum`, `effective_cloud_cover` (weighted by `cloud_low_pct`, `cloud_mid_pct`, `cloud_high_pct` across peak solar hours 8 AM – 4 PM), `lead_days`, `lead_hours`, and `change_reason`. Never overwrites prior versions; inserts `version = vN + 1` whenever the weather forecast changes or a new day rolls over.
  - `daily_actuals` table: Stores daily actual solar generation (`actual_kwh`), tree-loss counterfactual (`tree_lost_kwh`, `counterfactual_kwh`), and observed archive weather from `2026-08-21` onward.
- **API Endpoints:**
  - `GET http://localhost:3030/api/solar-dashboard`: Returns cached/fresh dashboard payload.
  - `GET http://localhost:3030/api/solar-dashboard?refresh=1`: Forces live refresh from Home Assistant & Open-Meteo (inserting new forecast versions if weather shifted).
  - `GET http://localhost:3030/api/solar-dashboard?snapshot=1`: Forces a new immutable version snapshot for all upcoming forecast days.

### Persistent Background Service (`launchd`)
- **Plist Location:** `~/Library/LaunchAgents/com.13iowa.solar-dashboard.plist`
- **Service Label:** `com.13iowa.solar-dashboard` (`RunAtLoad: true`, `KeepAlive: true`, automatic 6-hour background snapshot timer).
- **Logs:** `logs/dashboard.log` and `logs/dashboard.error.log`
- **Management Commands:**
  - Check status: `launchctl list | grep com.13iowa.solar-dashboard`
  - Restart service: `launchctl kickstart -k gui/$(id -u)/com.13iowa.solar-dashboard`
  - Stop service: `launchctl unload ~/Library/LaunchAgents/com.13iowa.solar-dashboard.plist`
  - Start service: `launchctl load ~/Library/LaunchAgents/com.13iowa.solar-dashboard.plist`

### Native Home Assistant Add-on (`addons/13iowa_solar_forecast/`)
A standalone Home Assistant Docker Add-on runs directly on the Home Assistant server 24/7 with zero dependence on the MacBook:
- **GitHub Repository:** [https://github.com/borcherspm/home-assistant-solar-forecast](https://github.com/borcherspm/home-assistant-solar-forecast)
- **Directory:** `addons/13iowa_solar_forecast/`
- **Installed Slug:** `cad53091_solar_forecast`
- **Update Entity:** `update.13_iowa_solar_forecast_update`
- **Files:** `config.yaml`, `Dockerfile` (`node:22-alpine` multi-stage), `run.sh`, `server.js`, and `public/`.
- **Ingress Enabled:** Adds a native **☀️ Solar Forecast** tab to the Home Assistant left sidebar (and HA mobile companion apps) via `ingress: true`.
- **Automatic HA Auth & Backup:** Uses internal `SUPERVISOR_TOKEN` at `http://supervisor/core` and stores persistent SQLite database in `/data/solar_forecasts.db` (included in automatic HA backups).
- **Repository Metadata:** Root `repository.yaml` enables adding this git repository directly to Home Assistant under **Settings → Add-ons → Add-on Store → Repositories**.

#### How to Check for Updates and Rebuild/Restart via API

##### 1. Refresh Add-on Store (Fetch New GitHub Commits)
Via WebSocket API:
```json
{
  "id": 1,
  "type": "supervisor/api",
  "endpoint": "/store/reload",
  "method": "post"
}
```

##### 2. Install Add-on Update (REST Service Call)
```bash
POST http://homeassistant.local:8123/api/services/update/install
Authorization: Bearer <HOME_ASSISTANT_TOKEN>
Content-Type: application/json

{"entity_id": "update.13_iowa_solar_forecast_update"}
```

##### 3. Rebuild or Restart Add-on via WebSocket Supervisor API
```json
{
  "id": 2,
  "type": "supervisor/api",
  "endpoint": "/addons/cad53091_solar_forecast/rebuild",
  "method": "post"
}
```
Or restart:
```json
{
  "id": 3,
  "type": "supervisor/api",
  "endpoint": "/addons/cad53091_solar_forecast/restart",
  "method": "post"
}
```

##### 4. Check Add-on Status & Version via WebSocket
```json
{
  "id": 4,
  "type": "supervisor/api",
  "endpoint": "/addons/cad53091_solar_forecast/info",
  "method": "get"
}
```

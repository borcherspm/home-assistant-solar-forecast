# Solar Forecast & Intelligence Engine

A high-resolution solar generation forecasting engine and tree removal counterfactual analyzer for Home Assistant. Combines historical Long-Term Statistics (LTS) from a Tesla Powerwall 2 array with Open-Meteo's free, no-key high-resolution weather models (NOAA HRRR & GFS) and native SQLite storage.

Runs as a **Home Assistant Add-on** (with Ingress sidebar support) or as a standalone local Node.js application.

---

## 🌟 Key Features

- **16-Day High-Resolution Solar Forecast:** Projects daily `kWh` and 15-minute `kW` power curves using Open-Meteo's 15-minute solar irradiance, daylight duration, and cloud altitude layers (low thick stratus vs. high thin cirrus).
- **Similar Past Sunlight Days Matching:** Automatically matches upcoming days against post-tree-removal historical days with similar sunshine duration and solar irradiance, scaled by astronomical solar elevation.
- **Tree Removal Counterfactual ("What If?"):** Analyzes historical generation from August 21 onward, calculating the exact `kWh` clipped by the afternoon tree before its removal on September 23.
- **Home Assistant Sensor Publisher:** Automatically publishes live `sensor.*` entities to Home Assistant via MQTT Discovery:
  - `sensor.solar_expected_today_weather_forecast` (cumulative intraday `kWh` curve updated every 60s for History Graph cards)
  - `sensor.solar_forecast_today` (with `forecast_15m` and `forecast_48h_15m` attributes)
  - `sensor.solar_forecast_tomorrow` (with `forecast_15m` attributes)
  - `sensor.solar_forecast_7d` (with 16-day daily forecast attributes)
- **Append-Only Versioned SQLite Database:** Every forecast run is immutably versioned (`v1, v2, v3...`) in `solar_forecasts.db`, preserving the exact forecast evolution and scoring variance against final Home Assistant actuals.
- **Interactive Web Dashboard:** 4 tabs accessible directly via URL routing:
  - `/forecast` — 16-day forecast, similar days table, and 15-minute curves
  - `/tree-impact` — August & September 2026 tree removal counterfactual inspector
  - `/simulator` — Interactive sunlight hours & seasonal potential slider
  - `/tracker` — SQLite version ledger & leave-one-out historical model backtest
  - `/ha-card` — Embeddable full-day cumulative S-curve graph for Home Assistant

---

## 📦 Installation as a Home Assistant Add-on

### Method A: Add as Custom Repository (Recommended)
1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**.
2. Click the **3 dots in the top right corner → Repositories**.
3. Add the repository URL:
   ```text
   https://github.com/borcherspm/home-assistant-solar-forecast
   ```
4. Find **Solar Forecast & Intelligence** in the Add-on Store, click **Install**, enable **Show in sidebar**, and click **Start**.

### Method B: Local Add-on via Samba / SSH
1. Copy the `addons/solar_forecast` directory to your Home Assistant `/addons/` folder.
2. In Home Assistant, go to **Settings → Add-ons → Add-on Store → 3 dots → Check for updates**.
3. Install from the **Local add-ons** section.

---

## 💻 Local Standalone Running (macOS / Linux)

### Requirements
- Node.js v22.5.0+ (for built-in `node:sqlite`)
- Home Assistant Long-Lived Access Token in `.env` (`HOME_ASSISTANT_TOKEN=...`)

### Running
```bash
node dashboard/server.js
```
Open [http://localhost:3030](http://localhost:3030) in your browser.

---

## 📊 Home Assistant Dashboard Card

Embed the full-day cumulative `kWh` curve (6:00 AM – 6:00 PM ahead of time) into any Lovelace dashboard using the built-in Webpage card:

```yaml
type: webpage
title: Solar Generated (Full Day + Future Forecast)
url: http://localhost:3030/ha-card
aspect_ratio: 75%
```

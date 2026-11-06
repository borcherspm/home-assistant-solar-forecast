# Solar Hourly Performance & Tree Removal Impact Report

**Date:** 2026-10-23  
**System:** Tesla Powerwall 2 + Solar Array
**Data Sources:** Home Assistant WebSocket LTS API (`sensor.solar_power`, `sensor.solar_generated`)

---

## Question 1: Is 12:00 PM – 1:00 PM always the best performing hour?

### Data

**Peak Hour Frequency across all productive days (Mid-August to Late October):**
- **12:00 PM – 1:00 PM:** 33 days (~50%)
- **11:00 AM – 12:00 PM:** 21 days (~32%)
- **1:00 PM – 2:00 PM:** 7 days (~11%)
- **Other hours:** 8 days (due to passing midday cloud cover)

**Average Hourly Output on Clearest/Sunniest Days by Month (kW):**

| Hour | August | September | October |
| :--- | :--- | :--- | :--- |
| **10:00 AM – 11:00 AM** | 4.31 kW | 4.16 kW | 3.69 kW |
| **11:00 AM – 12:00 PM** | **5.82 kW (Peak)** | 5.17 kW | 4.47 kW |
| **12:00 PM – 1:00 PM** | 5.18 kW | **5.54 kW (Peak)** | **5.05 kW (Peak)** |
| **1:00 PM – 2:00 PM** | 3.96 kW | 4.72 kW | 4.91 kW |
| **2:00 PM – 3:00 PM** | 2.59 kW | 3.74 kW | 4.26 kW |

### Summary
* **12:00 PM – 1:00 PM is the single most common peak hour**, accounting for roughly half of all days.
* **The peak shifted seasonally:** In August, peak production occurred earlier (11:00 AM – 12:00 PM) because summer rooftop heat caused thermal panel derating in the early afternoon. In September and October, cooler ambient temperatures minimized thermal loss, aligning the peak with true astronomical solar noon (~12:40 PM EDT).

---

## Question 2: Is solar production starting earlier now that leaves are falling from the trees?

### Data

**Morning Production Profile on Clear Days (kW):**

| Hour Window | August (Clear Days) | September (Clear Days) | October (Clear Days) |
| :--- | :--- | :--- | :--- |
| **6:00 AM – 7:00 AM** | 0.01 kW | 0.00 kW | 0.00 kW |
| **7:00 AM – 8:00 AM** | **0.31 kW** | **0.16 kW** | **0.04 kW** |
| **8:00 AM – 9:00 AM** | **0.62 kW** | **0.53 kW** | **0.25 kW** |
| **9:00 AM – 10:00 AM** | 1.44 kW | 1.34 kW | 1.24 kW |

### Summary
* **No, mornings are not starting earlier in clock time.** Morning generation is starting noticeably later and weaker in October compared to August.
* **Reason:** Astronomical changes override any tree effects in the morning. Sunrise shifted from ~5:50 AM in August to ~7:15 AM in late October. At 8:00 AM in October, the sun is only ~8° above the horizon (vs. ~25° in August), meaning minimal direct solar irradiance hits the panels before 9:00 AM.

---

## Question 3: What was the exact impact of the tree taken down on September 23 by noon?

### Data

**Hourly Production Surrounding the September 23 Tree Removal (kW):**

| Date | Condition | 11:00 AM | 12:00 PM | **1:00 PM** | **2:00 PM** | **3:00 PM** | 4:00 PM | **Daily Total** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Sep 21** | Before removal (Clear) | 4.14 kW | 4.86 kW | **3.46 kW** | **1.53 kW** | **1.08 kW** | 0.99 kW | **22.2 kWh** |
| **Sep 22** | Before removal (Clear) | 5.09 kW | 4.76 kW | **2.44 kW** | **2.03 kW** | **1.72 kW** | 1.38 kW | **24.8 kWh** |
| **Sep 23** | **Tree down at noon** | 5.25 kW | 5.75 kW | **5.66 kW** | **4.91 kW** | **4.02 kW** | 1.47 kW | **34.2 kWh** |
| **Sep 24** | After removal (Clear) | 5.14 kW | 5.74 kW | **5.65 kW** | **4.99 kW** | **4.01 kW** | 1.35 kW | **33.9 kWh** |
| **Sep 25** | After removal (Clear) | 5.25 kW | 5.70 kW | **5.18 kW** | **4.55 kW** | **3.75 kW** | 1.78 kW | **33.7 kWh** |

### Summary
* **Shadow Timing Identified:** Prior to removal, the tree began casting shade on the array starting around 12:30 PM, severely clipping production between 1:00 PM and 3:30 PM down to 1.0–2.0 kW.
* **Immediate Afternoon Surge:** Starting the exact afternoon the tree came down (Sept 23), production doubled and tripled:
  - 1:00 PM jumped from ~2.5 kW to **5.66 kW** (+125%)
  - 2:00 PM jumped from ~1.8 kW to **4.95 kW** (+175%)
  - 3:00 PM jumped from ~1.4 kW to **4.02 kW** (+185%)
* **Net Value:** Removing the tree added **~9.5 to 10 kWh of production every single sunny day**, lifting daily totals from ~24 kWh to ~34 kWh.

---

## Question 4: Are mornings getting better or worse, and will output keep declining each day into the fall?

### Data

**Progression of Full Clear Sunny Days (Post-Tree Removal: Sept 24 to Oct 23):**

| Date | 7:00 AM | 8:00 AM | 9:00 AM | 10:00 AM | 11:00 AM | 12:00 PM | 1:00 PM | 2:00 PM | 3:00 PM | **Daily Total** |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Sep 24** | 0.20 kW | 0.43 kW | 1.22 kW | 4.22 kW | 5.14 kW | 5.74 kW | 5.65 kW | 4.99 kW | 4.01 kW | **33.9 kWh** |
| **Oct 03** | 0.09 kW | 0.31 kW | 1.04 kW | 3.95 kW | 4.65 kW | 5.37 kW | 5.14 kW | 4.50 kW | 3.69 kW | **30.2 kWh** |
| **Oct 07** | 0.09 kW | 0.33 kW | 1.23 kW | 3.90 kW | 4.72 kW | 5.02 kW | 4.96 kW | 4.30 kW | 3.49 kW | **30.2 kWh** |
| **Oct 15** | 0.00 kW | 0.43 kW | 1.35 kW | 3.00 kW | 4.08 kW | 4.69 kW | 4.77 kW | 4.04 kW | 3.34 kW | **27.3 kWh** |
| **Oct 18** | 0.00 kW | 0.06 kW | 1.26 kW | 3.69 kW | 4.39 kW | 4.83 kW | 4.60 kW | 3.94 kW | 3.27 kW | **27.1 kWh** |
| **Oct 20** | 0.00 kW | 0.11 kW | 1.19 kW | 3.59 kW | 4.26 kW | 4.73 kW | 4.55 kW | 3.86 kW | 3.22 kW | **26.3 kWh** |
| **Oct 22** | 0.00 kW | 0.06 kW | 1.21 kW | 3.57 kW | 4.20 kW | 4.61 kW | 4.35 kW | 3.63 kW | 2.87 kW | **25.1 kWh** |
| **Oct 23** | 0.01 kW | 0.24 kW | 1.19 kW | 3.50 kW | 3.92 kW | 4.56 kW | 4.33 kW | 3.77 kW | -- | **~25 kWh** |

### Summary
* **Mornings are getting worse:** 
  - 7:00 AM production dropped to 0.00 kW.
  - 8:00 AM production dropped from ~0.50 kW to ~0.10–0.24 kW.
  - 10:00 AM production dropped from ~4.3 kW down to ~3.5 kW.
* **Continuous Fall Decline is Expected:** 
  - Total clear-day production dropped from **34 kWh** (late Sept) to **30 kWh** (early Oct) to **25 kWh** (late Oct).
  - This decline will continue through the **Winter Solstice (December 21)** due to:
    1. Sun midday elevation dropping from ~48° (Sept) to ~35° (Oct) to ~24° (Dec).
    2. Daily daylight shrinking from 12 hours (Sept) to ~9 hours (Dec).
    3. Peak clear midday generation continuing to decline toward ~3.2–3.8 kW.
* **Reversal:** Production will bottom out around the end of December (~14–18 kWh/day clear baseline) before beginning its annual ascent in January.

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Encoder, Profile } from "@garmin/fitsdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 45123;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/screenshots", express.static(path.join(__dirname, "screenshots")));

const CONFIG_PATH = path.join(__dirname, "public", "config.json");
const DEFAULT_WEATHER_CONFIG = {
  enabled: true,
  failOpen: true,
  provider: "qweather",
  timeoutMs: 4500,
  locationLabel: "route center",
  qweather: {
    forecastUrl: "https://devapi.qweather.com/v7/weather/24h",
    forecastHours: 24
  },
  openMeteo: {
    forecastUrl: "https://api.open-meteo.com/v1/forecast",
    archiveUrl: "https://archive-api.open-meteo.com/v1/archive",
    forecastPastDays: 92,
    forecastFutureDays: 16,
    timezone: "auto"
  }
};
const SERVER_CONFIG = readServerConfig();
const WEATHER_CONFIG = {
  ...DEFAULT_WEATHER_CONFIG,
  ...(SERVER_CONFIG.weather || {})
};
const DEFAULT_RUN_METRICS_CONFIG = {
  enabled: true,
  runnerWeightKg: 65,
  referenceSpeedMps: 2.78,
  targetStepLengthMm: 1050,
  stepLengthSpeedGainMmPerMps: 35,
  stepLengthWaveMm: 10,
  cadenceMinSpm: 130,
  cadenceMaxSpm: 196,
  stepLengthMinMm: 900,
  stepLengthMaxMm: 1200,
  powerFactorWattsPerKgMps: 1.36,
  powerMinWatts: 80,
  powerMaxWatts: 560
};
const RUN_METRICS_CONFIG = {
  ...DEFAULT_RUN_METRICS_CONFIG,
  ...(SERVER_CONFIG.runMetrics || {})
};
const WEATHER_CACHE = new Map();

function toSemicircles(deg) {
  return Math.round((deg * 2147483648) / 180);
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function buildClosedBasePoints(points) {
  if (!points || points.length < 2) return points || [];
  const first = points[0];
  const last = points[points.length - 1];
  const d = haversineDistance(first.lat, first.lng, last.lat, last.lng);
  if (d < 5) {
    return points;
  }
  const closed = points.slice();
  closed.push({ lat: first.lat, lng: first.lng });
  return closed;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function smoothStep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function readServerConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (error) {
    console.warn(`Unable to read ${CONFIG_PATH}: ${error.message}`);
    return {};
  }
}

function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function formatUtcDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ));
}

function getFiniteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInteger(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function pickWeatherEndpoint(startDate) {
  const openCfg = WEATHER_CONFIG.openMeteo || {};
  const today = startOfUtcDay(new Date());
  const activityDay = startOfUtcDay(startDate);
  const diffDays = Math.round((activityDay - today) / 86400000);
  const canUseForecast =
    diffDays >= -(openCfg.forecastPastDays || 92) &&
    diffDays <= (openCfg.forecastFutureDays || 16);

  return {
    url: canUseForecast ? openCfg.forecastUrl : openCfg.archiveUrl,
    type: canUseForecast ? "forecast" : "archive"
  };
}

function buildWeatherUrl(endpoint, point, startDate, endDate) {
  const openCfg = WEATHER_CONFIG.openMeteo || {};
  const forecastHourly = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation_probability",
    "precipitation",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m"
  ];
  const archiveHourly = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m"
  ];
  const params = new URLSearchParams({
    latitude: String(point.lat),
    longitude: String(point.lng),
    start_date: formatUtcDate(addDays(startDate, -1)),
    end_date: formatUtcDate(addDays(endDate, 1)),
    hourly: (endpoint.type === "forecast" ? forecastHourly : archiveHourly).join(","),
    timezone: openCfg.timezone || "auto",
    timeformat: "unixtime",
    temperature_unit: "celsius",
    wind_speed_unit: "ms",
    precipitation_unit: "mm"
  });
  return `${endpoint.url}?${params.toString()}`;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`weather HTTP ${res.status}: ${body.slice(0, 160)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseWeatherSeries(data) {
  const hourly = data?.hourly || {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const series = [];

  for (let i = 0; i < times.length; i++) {
    const unixSeconds = getFiniteNumber(times[i]);
    const temperature = getFiniteNumber(hourly.temperature_2m?.[i]);
    if (!Number.isFinite(unixSeconds) || !Number.isFinite(temperature)) continue;

    series.push({
      timeMs: unixSeconds * 1000,
      temperature,
      apparentTemperature: getFiniteNumber(hourly.apparent_temperature?.[i]),
      relativeHumidity: getFiniteNumber(hourly.relative_humidity_2m?.[i]),
      precipitationProbability: getFiniteNumber(hourly.precipitation_probability?.[i]),
      precipitation: getFiniteNumber(hourly.precipitation?.[i]),
      weatherCode: getFiniteNumber(hourly.weather_code?.[i]),
      windSpeed: getFiniteNumber(hourly.wind_speed_10m?.[i]),
      windDirection: getFiniteNumber(hourly.wind_direction_10m?.[i])
    });
  }

  return series;
}

function wmoCodeToFitCondition(code, windSpeed) {
  if (Number.isFinite(windSpeed) && windSpeed >= 10 && (!Number.isFinite(code) || code <= 3)) {
    return "windy";
  }

  switch (Math.round(code)) {
    case 0:
      return "clear";
    case 1:
      return "partlyCloudy";
    case 2:
      return "mostlyCloudy";
    case 3:
      return "cloudy";
    case 45:
    case 48:
      return "fog";
    case 51:
    case 53:
    case 56:
    case 61:
    case 66:
      return "lightRain";
    case 55:
    case 63:
    case 80:
      return "rain";
    case 65:
    case 67:
    case 81:
    case 82:
      return "heavyRain";
    case 71:
    case 73:
    case 77:
    case 85:
      return "lightSnow";
    case 75:
    case 86:
      return "heavySnow";
    case 95:
      return "thunderstorms";
    case 96:
    case 99:
      return "scatteredThunderstorms";
    default:
      return null;
  }
}

/* ── QWeather provider ── */

function qweatherWindDirToDegrees(dir) {
  const map = {
    "北风": 0, "东北风": 45, "东风": 90, "东南风": 135,
    "南风": 180, "西南风": 225, "西风": 270, "西北风": 315
  };
  if (map[dir] !== undefined) return map[dir];
  for (const [key, deg] of Object.entries(map)) {
    if (dir && dir.includes(key)) return deg;
  }
  return null;
}

function qweatherConditionToFit(iconCode, text) {
  const code = Math.round(Number(iconCode));
  if (code >= 300 && code <= 399) {
    if (code <= 304) return "lightRain";
    if (code <= 310) return "rain";
    return "heavyRain";
  }
  if (code >= 400 && code <= 499) {
    if (code <= 404) return "lightRain";
    if (code <= 410) return "rain";
    return "heavyRain";
  }
  if (code >= 500 && code <= 599) return "fog";
  if (code >= 600 && code <= 699) return "lightSnow";
  if (code >= 700 && code <= 799) return "heavySnow";
  if (code >= 800 && code <= 899) return "thunderstorms";
  if (code >= 900 && code <= 999) return "scatteredThunderstorms";
  if (text) {
    if (text.includes("霾") || text.includes("沙") || text.includes("浮尘")) return "fog";
  }
  if (code === 100) return "clear";
  if (code === 101 || code === 103) return "mostlyCloudy";
  if (code === 102) return "partlyCloudy";
  if (code === 104) return "cloudy";
  return null;
}

function parseQWeatherSeries(data) {
  if (data.code !== "200" || !Array.isArray(data.hourly)) return [];
  return data.hourly.map((h) => {
    const timeMs = new Date(h.fxTime).getTime();
    const temperature = getFiniteNumber(h.temp);
    if (!Number.isFinite(timeMs) || !Number.isFinite(temperature)) return null;
    return {
      timeMs,
      temperature,
      relativeHumidity: getFiniteNumber(h.humidity),
      precipitationProbability: getFiniteNumber(h.pop),
      precipitation: getFiniteNumber(h.precip),
      windSpeed: getFiniteNumber(h.windSpeed) !== null
        ? getFiniteNumber(h.windSpeed) / 3.6
        : null,
      windDirection: qweatherWindDirToDegrees(h.windDir),
      weatherIcon: getFiniteNumber(h.icon),
      weatherText: h.text || null
    };
  }).filter(Boolean);
}

async function fetchQWeather(point, startDate) {
  const apiKey = process.env.QWEATHER_KEY ||
    (WEATHER_CONFIG.qweather && WEATHER_CONFIG.qweather.key) ||
    "";
  if (!apiKey) {
    console.warn("QWeather API key not configured (set QWEATHER_KEY env var or config qweather.key)");
    return null;
  }

  const forecastHours = WEATHER_CONFIG.qweather?.forecastHours || 24;
  const hoursDiff = (startDate.getTime() - Date.now()) / 3600000;
  if (hoursDiff < -(forecastHours + 6) || hoursDiff > (forecastHours + 6)) {
    console.warn(`Activity date ${startDate.toISOString().slice(0,10)} is outside QWeather ${forecastHours}h forecast window`);
    return null;
  }

  const url = `${WEATHER_CONFIG.qweather.forecastUrl}?location=${point.lng},${point.lat}&key=${apiKey}`;
  const data = await fetchJsonWithTimeout(url, WEATHER_CONFIG.timeoutMs);
  const series = parseQWeatherSeries(data);
  if (!series.length) {
    throw new Error("QWeather response has no usable hourly data");
  }

  return {
    series,
    point,
    source: "QWeather"
  };
}

/* ── Open-Meteo provider ── */

async function fetchWeatherForActivity(startDate, endDate, points) {
  if (!WEATHER_CONFIG.enabled) return null;

  const point = points[Math.floor(points.length / 2)] || points[0];
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) {
    return null;
  }

  const provider = WEATHER_CONFIG.provider || "qweather";

  if (provider === "qweather") {
    try {
      return await fetchQWeather(point, startDate);
    } catch (error) {
      const message = `QWeather lookup failed: ${error?.message || "unknown error"}`;
      if (WEATHER_CONFIG.failOpen) {
        console.warn(message);
        return null;
      }
      throw new Error(message);
    }
  }

  if (provider === "openMeteo") {
    const openCfg = WEATHER_CONFIG.openMeteo || {};
    const preferredEndpoint = pickWeatherEndpoint(startDate);
    const fallbackEndpoint = preferredEndpoint.type === "forecast"
      ? { url: openCfg.archiveUrl, type: "archive" }
      : { url: openCfg.forecastUrl, type: "forecast" };
    const endpoints = [preferredEndpoint, fallbackEndpoint];
    let lastError = null;

    for (const endpoint of endpoints) {
      const url = buildWeatherUrl(endpoint, point, startDate, endDate);
      try {
        if (!WEATHER_CACHE.has(url)) {
          WEATHER_CACHE.set(url, fetchJsonWithTimeout(url, WEATHER_CONFIG.timeoutMs));
        }
        const data = await WEATHER_CACHE.get(url);
        const series = parseWeatherSeries(data);
        if (!series.length) {
          throw new Error("weather response has no usable hourly data");
        }

        return {
          series,
          point,
          source: `Open-Meteo ${endpoint.type}`
        };
      } catch (error) {
        WEATHER_CACHE.delete(url);
        lastError = error;
      }
    }

    const message = `Open-Meteo lookup failed: ${lastError?.message || "unknown error"}`;
    if (WEATHER_CONFIG.failOpen) {
      console.warn(message);
      return null;
    }
    throw new Error(message);
  }

  console.warn(`Unknown weather provider: ${provider}`);
  return null;
}

function getNearestWeather(series, timestamp) {
  if (!series?.length) return null;
  const timeMs = timestamp.getTime();
  let best = series[0];
  let bestDelta = Math.abs(best.timeMs - timeMs);

  for (let i = 1; i < series.length; i++) {
    const delta = Math.abs(series[i].timeMs - timeMs);
    if (delta < bestDelta) {
      best = series[i];
      bestDelta = delta;
    }
  }

  return bestDelta <= 6 * 3600 * 1000 ? best : null;
}

function buildWeatherConditionsMesg(weather, startDate) {
  const observed = getNearestWeather(weather.series, startDate);
  if (!observed) return null;

  const message = {
    timestamp: startDate,
    weatherReport: "current",
    temperature: clampInteger(observed.temperature, -127, 127),
    condition: (weather.source === "QWeather"
      ? qweatherConditionToFit(observed.weatherIcon, observed.weatherText)
      : wmoCodeToFitCondition(observed.weatherCode, observed.windSpeed)),
    observedAtTime: new Date(observed.timeMs),
    observedLocationLat: toSemicircles(weather.point.lat),
    observedLocationLong: toSemicircles(weather.point.lng),
    location: WEATHER_CONFIG.locationLabel || "route center"
  };

  const feelsLike = clampInteger(observed.apparentTemperature, -127, 127);
  const humidity = clampInteger(observed.relativeHumidity, 0, 100);
  const precipitationProbability = clampInteger(observed.precipitationProbability, 0, 100);
  const windDirection = clampInteger(observed.windDirection, 0, 360);

  if (feelsLike !== null) message.temperatureFeelsLike = feelsLike;
  if (humidity !== null) message.relativeHumidity = humidity;
  if (precipitationProbability !== null) {
    message.precipitationProbability = precipitationProbability;
  }
  if (windDirection !== null) message.windDirection = windDirection;
  if (Number.isFinite(observed.windSpeed)) message.windSpeed = observed.windSpeed;

  return Object.fromEntries(
    Object.entries(message).filter(([, value]) => value !== null && value !== undefined)
  );
}

function buildRunPaceStages(lapCount) {
  const lapTotal = Math.max(1, Number(lapCount) || 1);
  const cooldownFraction = clamp(0.5 / lapTotal, 0.04, 0.18);
  const cooldownStart = 1 - cooldownFraction;
  const warmupEnd = Math.min(0.2, Math.max(0.12, cooldownStart * 0.25));
  const sprintStart = Math.min(
    0.8,
    Math.max(warmupEnd + 0.45, cooldownStart - 0.14)
  );

  return { warmupEnd, sprintStart, cooldownStart };
}

function getSpeedTrendFactor(frac, stages) {
  if (frac < stages.warmupEnd) {
    const t = smoothStep(frac / stages.warmupEnd);
    return lerp(0.84, 0.96, t);
  }

  if (frac < stages.sprintStart) {
    const t = (frac - stages.warmupEnd) /
      Math.max(1e-6, stages.sprintStart - stages.warmupEnd);
    const settle = smoothStep(Math.min(1, t / 0.18));
    return lerp(0.98, 1.0, settle) + 0.006 * Math.sin(t * Math.PI * 2);
  }

  if (frac < stages.cooldownStart) {
    const t = smoothStep(
      (frac - stages.sprintStart) /
      Math.max(1e-6, stages.cooldownStart - stages.sprintStart)
    );
    return lerp(1.03, 1.13, t);
  }

  const t = smoothStep(
    (frac - stages.cooldownStart) /
    Math.max(1e-6, 1 - stages.cooldownStart)
  );
  return lerp(0.94, 0.78, t);
}

function getHeartRateIntensityBase(frac, stages) {
  if (frac < stages.warmupEnd) {
    return lerp(0.35, 0.7, smoothStep(frac / stages.warmupEnd));
  }

  if (frac < stages.sprintStart) {
    const t = (frac - stages.warmupEnd) /
      Math.max(1e-6, stages.sprintStart - stages.warmupEnd);
    return 0.74 + 0.03 * Math.sin(t * Math.PI);
  }

  if (frac < stages.cooldownStart) {
    const t = smoothStep(
      (frac - stages.sprintStart) /
      Math.max(1e-6, stages.cooldownStart - stages.sprintStart)
    );
    return lerp(0.82, 0.95, t);
  }

  const t = smoothStep(
    (frac - stages.cooldownStart) /
    Math.max(1e-6, 1 - stages.cooldownStart)
  );
  return lerp(0.86, 0.72, t);
}

function computeSamples(
  allPoints,
  distances,
  totalDist,
  paceSecondsPerKm,
  hrRestVal,
  hrMaxVal,
  lapCount = 1
) {
  const totalDistanceKm = totalDist / 1000;
  const targetDurationSec = totalDistanceKm * paceSecondsPerKm;

  const avgSpeedTarget = totalDist / targetDurationSec;
  const baseSpeedFactor = 0.99 + Math.random() * 0.02;
  const variationPhase1 = Math.random() * Math.PI * 2;
  const variationPhase2 = Math.random() * Math.PI * 2;
  const stages = buildRunPaceStages(lapCount);

  const n = allPoints.length;
  const instSpeedRaw = new Array(n);
  const hrValues = new Array(n);

  let currentHr = hrRestVal;

  for (let i = 0; i < n; i++) {
    const frac = distances[i] / totalDist;
    const trendFactor = getSpeedTrendFactor(frac, stages);
    const tinyVariation =
      0.008 * Math.sin(frac * Math.PI * 2 * 3 + variationPhase1) +
      0.004 * Math.sin(frac * Math.PI * 2 * 11 + variationPhase2) +
      (Math.random() - 0.5) * 0.004;
    const speedRaw =
      avgSpeedTarget *
      baseSpeedFactor *
      trendFactor *
      (1 + tinyVariation);
    instSpeedRaw[i] = speedRaw;

    const effort = Math.min(
      1,
      Math.max(0, speedRaw / (avgSpeedTarget || 1e-6))
    );

    const intensityBase = getHeartRateIntensityBase(frac, stages);

    const intensity = Math.min(
      1,
      Math.max(0, 0.7 * intensityBase + 0.3 * effort)
    );

    const hrTarget = hrRestVal + (hrMaxVal - hrRestVal) * intensity;
    currentHr += (hrTarget - currentHr) * 0.15;
    const hrJitter = (Math.random() - 0.5) * 3;
    const hrValue = Math.round(
      Math.min(hrMaxVal, Math.max(hrRestVal, currentHr + hrJitter))
    );
    hrValues[i] = hrValue;
  }

  const segDurationsRaw = new Array(Math.max(0, n - 1));
  let rawDuration = 0;
  for (let i = 1; i < n; i++) {
    const ds = distances[i] - distances[i - 1];
    const v = instSpeedRaw[i] > 0 ? instSpeedRaw[i] : avgSpeedTarget;
    const dt = ds / v;
    segDurationsRaw[i - 1] = dt;
    rawDuration += dt;
  }

  const scale = rawDuration > 0 ? targetDurationSec / rawDuration : 1;

  const samples = [];
  let t = 0;
  samples.push({
    timeSec: 0,
    distance: distances[0],
    speed: instSpeedRaw[0] / scale,
    heartRate: hrValues[0],
    lat: allPoints[0].lat,
    lng: allPoints[0].lng
  });

  for (let i = 1; i < n; i++) {
    const dt = segDurationsRaw[i - 1] * scale;
    t += dt;
    samples.push({
      timeSec: t,
      distance: distances[i],
      speed: instSpeedRaw[i] / scale,
      heartRate: hrValues[i],
      lat: allPoints[i].lat,
      lng: allPoints[i].lng
    });
  }

  const totalDurationSec = samples.length
    ? samples[samples.length - 1].timeSec
    : targetDurationSec;

  return { samples, totalDurationSec };
}

function computeRunningMetrics(samples, totalDist, totalDurationSec) {
  if (!RUN_METRICS_CONFIG.enabled || !samples.length || totalDurationSec <= 0) {
    return {
      samples,
      summary: {
        totalCalories: null,
        avgPower: null,
        maxPower: null,
        avgCadence: null,
        maxCadence: null,
        avgStepLength: null,
        totalCycles: null,
        avgHeartRate: null,
        maxHeartRate: null,
        maxSpeed: null
      }
    };
  }

  const weightKg = clampNumber(
    Number(RUN_METRICS_CONFIG.runnerWeightKg),
    35,
    130,
    DEFAULT_RUN_METRICS_CONFIG.runnerWeightKg
  );
  const avgSpeed = totalDist / totalDurationSec;
  const referenceSpeed = Math.max(0.1, Number(RUN_METRICS_CONFIG.referenceSpeedMps) || 2.78);
  const minStepLength = Number(RUN_METRICS_CONFIG.stepLengthMinMm);
  const maxStepLength = Number(RUN_METRICS_CONFIG.stepLengthMaxMm);
  const targetStepLength = clampNumber(
    Number(RUN_METRICS_CONFIG.targetStepLengthMm),
    minStepLength,
    maxStepLength,
    DEFAULT_RUN_METRICS_CONFIG.targetStepLengthMm
  );
  const cadencePhase1 = Math.random() * Math.PI * 2;
  const cadencePhase2 = Math.random() * Math.PI * 2;
  const powerPhase = Math.random() * Math.PI * 2;

  let totalCadenceTime = 0;
  let totalStepLengthTime = 0;
  let totalPowerTime = 0;
  let totalSteps = 0;
  let totalCalories = 0;
  let totalTime = 0;
  let totalHeartRateTime = 0;
  let maxCadence = 0;
  let maxPower = 0;
  let maxHeartRate = 0;
  let maxSpeed = 0;

  const enrichedSamples = samples.map((sample, index) => {
    const prevSample = index > 0 ? samples[index - 1] : sample;
    const dt = index > 0 ? Math.max(0, sample.timeSec - prevSample.timeSec) : 0;
    const frac = totalDist > 0 ? sample.distance / totalDist : 0;
    const speed = Math.max(0.1, sample.speed || avgSpeed || referenceSpeed);
    const speedDelta = speed - avgSpeed;
    const stepLengthWave =
      Number(RUN_METRICS_CONFIG.stepLengthWaveMm) *
        Math.sin(frac * Math.PI * 2 * 2 + cadencePhase1) +
      Number(RUN_METRICS_CONFIG.stepLengthWaveMm) *
        0.35 *
        Math.sin(frac * Math.PI * 2 * 7 + cadencePhase2);
    let stepLengthMm = clampInteger(
      targetStepLength +
        speedDelta * Number(RUN_METRICS_CONFIG.stepLengthSpeedGainMmPerMps) +
        stepLengthWave,
      minStepLength,
      maxStepLength
    );
    const cadence = clampInteger(
      (speed * 60 * 1000) / Math.max(1, stepLengthMm),
      Number(RUN_METRICS_CONFIG.cadenceMinSpm),
      Number(RUN_METRICS_CONFIG.cadenceMaxSpm)
    );
    stepLengthMm = clampInteger(
      (speed * 60 * 1000) / Math.max(1, cadence),
      minStepLength,
      maxStepLength
    );
    const powerVariation =
      0.018 * Math.sin(frac * Math.PI * 2 * 3 + powerPhase) +
      0.008 * Math.sin(frac * Math.PI * 2 * 11 + cadencePhase2);
    const power = clampInteger(
      weightKg *
        speed *
        Number(RUN_METRICS_CONFIG.powerFactorWattsPerKgMps) *
        (1 + powerVariation),
      Number(RUN_METRICS_CONFIG.powerMinWatts),
      Number(RUN_METRICS_CONFIG.powerMaxWatts)
    );

    if (dt > 0) {
      const speedMetersPerMinute = speed * 60;
      const oxygenMlKgMin = Math.max(3.5, 0.2 * speedMetersPerMinute + 3.5);
      const kcalPerMinute = (oxygenMlKgMin * weightKg) / 200;
      const steps = (cadence * dt) / 60;

      totalCalories += (kcalPerMinute * dt) / 60;
      totalCadenceTime += cadence * dt;
      totalStepLengthTime += stepLengthMm * dt;
      totalPowerTime += power * dt;
      totalSteps += steps;
      totalHeartRateTime += sample.heartRate * dt;
      totalTime += dt;
    }

    maxCadence = Math.max(maxCadence, cadence);
    maxPower = Math.max(maxPower, power);
    maxHeartRate = Math.max(maxHeartRate, sample.heartRate);
    maxSpeed = Math.max(maxSpeed, speed);

    return {
      ...sample,
      cadence,
      stepLength: stepLengthMm,
      power,
      calories: Math.max(0, Math.round(totalCalories))
    };
  });

  const avgCadence = totalTime > 0
    ? Math.round(totalCadenceTime / totalTime)
    : enrichedSamples[0].cadence;
  const avgPower = totalTime > 0
    ? Math.round(totalPowerTime / totalTime)
    : enrichedSamples[0].power;
  const avgStepLength = totalSteps > 0
    ? Math.round((totalDist / totalSteps) * 1000)
    : Math.round(totalStepLengthTime / Math.max(1, totalTime));

  return {
    samples: enrichedSamples,
    summary: {
      totalCalories: Math.max(1, Math.round(totalCalories)),
      avgPower,
      maxPower,
      avgCadence,
      maxCadence,
      avgStepLength: clampInteger(
        avgStepLength,
        minStepLength,
        maxStepLength
      ),
      totalCycles: Math.max(0, Math.round(totalSteps)),
      avgHeartRate: totalTime > 0
        ? Math.round(totalHeartRateTime / totalTime)
        : enrichedSamples[0].heartRate,
      maxHeartRate,
      maxSpeed
    }
  };
}

app.post("/api/preview", (req, res) => {
  try {
    const {
      startTime,
      points,
      paceSecondsPerKm,
      hrRest,
      hrMax,
      lapCount,
      pointsIncludeLaps
    } = req.body || {};

    if (!startTime || !points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({
        error: "缺少参数：需要 startTime、至少两个轨迹点 points"
      });
    }

    const startDate = new Date(startTime);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "startTime 格式不正确" });
    }

    const pace = Number(paceSecondsPerKm) > 0 ? Number(paceSecondsPerKm) : 360;
    const hrRestVal = Number.isFinite(Number(hrRest)) ? Number(hrRest) : 60;
    const hrMaxVal = Number.isFinite(Number(hrMax)) ? Number(hrMax) : 180;
    const lapsRaw = Number(lapCount);
    const laps = Number.isFinite(lapsRaw) && lapsRaw > 0 ? lapsRaw : 1;

    const basePoints = pointsIncludeLaps ? points : buildClosedBasePoints(points);
    const allPoints = [];
    const usedLaps = pointsIncludeLaps ? laps : Math.max(1, Math.floor(laps));

    if (pointsIncludeLaps) {
      allPoints.push(...basePoints);
    } else {
      for (let lapIndex = 0; lapIndex < usedLaps; lapIndex++) {
        for (let i = 0; i < basePoints.length; i++) {
          const p = basePoints[i];
          allPoints.push(p);
        }
      }
    }

    const distances = [0];
    let totalDist = 0;
    for (let i = 1; i < allPoints.length; i++) {
      const d = haversineDistance(
        allPoints[i - 1].lat,
        allPoints[i - 1].lng,
        allPoints[i].lat,
        allPoints[i].lng
      );
      totalDist += d;
      distances.push(totalDist);
    }

    if (totalDist === 0) {
      return res.status(400).json({ error: "轨迹距离为 0，请绘制更长的路线" });
    }

    const { samples, totalDurationSec } = computeSamples(
      allPoints,
      distances,
      totalDist,
      pace,
      hrRestVal,
      hrMaxVal,
      usedLaps
    );

    return res.json({
      totalDistanceMeters: totalDist,
      totalDurationSec,
      samples
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "生成预览失败" });
  }
});

app.post("/api/generate-fit", async (req, res) => {
  try {
    const {
      startTime,
      points,
      paceSecondsPerKm,
      hrRest,
      hrMax,
      lapCount,
      pointsIncludeLaps,
      variantIndex
    } = req.body || {};

    if (!startTime || !points || !Array.isArray(points) || points.length < 2) {
      return res.status(400).json({
        error: "缺少参数：需要 startTime、至少两个轨迹点 points"
      });
    }

    const startDate = new Date(startTime);
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "startTime 格式不正确" });
    }

    const pace = Number(paceSecondsPerKm) > 0 ? Number(paceSecondsPerKm) : 360;
    const hrRestVal = Number.isFinite(Number(hrRest)) ? Number(hrRest) : 60;
    const hrMaxVal = Number.isFinite(Number(hrMax)) ? Number(hrMax) : 180;
    const lapsRaw = Number(lapCount);
    const laps = Number.isFinite(lapsRaw) && lapsRaw > 0 ? lapsRaw : 1;
    const variantRaw = Number(variantIndex);
    const variant =
      Number.isFinite(variantRaw) && variantRaw > 0
        ? Math.floor(variantRaw)
        : 1;

    const basePoints = pointsIncludeLaps ? points : buildClosedBasePoints(points);
    const allPoints = [];
    const usedLaps = pointsIncludeLaps ? laps : Math.max(1, Math.floor(laps));

    if (pointsIncludeLaps) {
      allPoints.push(...basePoints);
    } else {
      for (let lapIndex = 0; lapIndex < usedLaps; lapIndex++) {
        for (let i = 0; i < basePoints.length; i++) {
          allPoints.push(basePoints[i]);
        }
      }
    }

    const distances = [0];
    let totalDist = 0;
    for (let i = 1; i < allPoints.length; i++) {
      const d = haversineDistance(
        allPoints[i - 1].lat,
        allPoints[i - 1].lng,
        allPoints[i].lat,
        allPoints[i].lng
      );
      totalDist += d;
      distances.push(totalDist);
    }

    if (totalDist === 0) {
      return res.status(400).json({ error: "轨迹距离为 0，请绘制更长的路线" });
    }

    const { samples: baseSamples, totalDurationSec } = computeSamples(
      allPoints,
      distances,
      totalDist,
      pace,
      hrRestVal,
      hrMaxVal,
      usedLaps
    );
    const runningMetrics = computeRunningMetrics(baseSamples, totalDist, totalDurationSec);
    const samples = runningMetrics.samples;
    const activitySummary = runningMetrics.summary;
    const sessionEnd = new Date(startDate.getTime() + totalDurationSec * 1000);
    const activityWeather = await fetchWeatherForActivity(startDate, sessionEnd, allPoints);

    const encoder = new Encoder();

    encoder.onMesg(Profile.MesgNum.FILE_ID, {
      manufacturer: "development",
      product: 1,
      timeCreated: startDate,
      type: "activity"
    });

    encoder.onMesg(Profile.MesgNum.DEVICE_INFO, {
      timestamp: startDate,
      manufacturer: "development",
      product: 1,
      serialNumber: 1
    });

    if (activityWeather && Profile.MesgNum.WEATHER_CONDITIONS !== undefined) {
      const weatherMesg = buildWeatherConditionsMesg(activityWeather, startDate);
      if (weatherMesg) {
        try {
          encoder.onMesg(Profile.MesgNum.WEATHER_CONDITIONS, weatherMesg);
        } catch (error) {
          console.warn(`Unable to write weather conditions: ${error.message}`);
        }
      }
    }

    const avgSpeed = totalDist / totalDurationSec;

    const sessionMesg = {
      timestamp: sessionEnd,
      startTime: startDate,
      totalElapsedTime: totalDurationSec,
      totalTimerTime: totalDurationSec,
      totalDistance: totalDist,
      sport: "running",
      subSport: "generic",
      avgSpeed
    };
    if (activitySummary.totalCalories !== null) sessionMesg.totalCalories = activitySummary.totalCalories;
    if (activitySummary.avgPower !== null) sessionMesg.avgPower = activitySummary.avgPower;
    if (activitySummary.maxPower !== null) sessionMesg.maxPower = activitySummary.maxPower;
    if (activitySummary.avgCadence !== null) sessionMesg.avgCadence = activitySummary.avgCadence;
    if (activitySummary.maxCadence !== null) sessionMesg.maxCadence = activitySummary.maxCadence;
    if (activitySummary.avgStepLength !== null) sessionMesg.avgStepLength = activitySummary.avgStepLength;
    if (activitySummary.totalCycles !== null) sessionMesg.totalCycles = activitySummary.totalCycles;
    if (activitySummary.avgHeartRate !== null) sessionMesg.avgHeartRate = activitySummary.avgHeartRate;
    if (activitySummary.maxHeartRate !== null) sessionMesg.maxHeartRate = activitySummary.maxHeartRate;
    if (activitySummary.maxSpeed !== null) sessionMesg.maxSpeed = activitySummary.maxSpeed;

    encoder.onMesg(Profile.MesgNum.SESSION, sessionMesg);

    const lapMesg = {
      ...sessionMesg,
      event: "lap",
      eventType: "stop",
      lapTrigger: "sessionEnd"
    };
    encoder.onMesg(Profile.MesgNum.LAP, lapMesg);

    encoder.onMesg(Profile.MesgNum.ACTIVITY, {
      timestamp: sessionEnd,
      totalTimerTime: totalDurationSec,
      numSessions: 1,
      type: "manual"
    });

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const timestamp = new Date(startDate.getTime() + s.timeSec * 1000);
      const weatherAtSample = activityWeather
        ? getNearestWeather(activityWeather.series, timestamp)
        : null;
      const temperature = clampInteger(weatherAtSample?.temperature, -127, 127);
      const recordMesg = {
        timestamp,
        positionLat: toSemicircles(allPoints[i].lat),
        positionLong: toSemicircles(allPoints[i].lng),
        distance: s.distance,
        speed: s.speed,
        heartRate: s.heartRate,
        cadence: s.cadence,
        cadence256: s.cadence,
        power: s.power,
        stepLength: s.stepLength,
        calories: s.calories
      };
      if (temperature !== null) recordMesg.temperature = temperature;

      encoder.onMesg(Profile.MesgNum.RECORD, recordMesg);
    }

    const uint8Array = encoder.close();
    const buffer = Buffer.from(uint8Array);

    res.setHeader("Content-Type", "application/vnd.ant.fit");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=run_${variant}.fit`
    );
    return res.send(buffer);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "生成 FIT 文件失败" });
  }
});

function renderMarkdownToHtml(md) {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = escaped.split("\n");
  const result = [];
  let inCodeBlock = false;
  let inTable = false;
  let inList = false;

  function endList() {
    if (inList) { result.push("</ul>"); inList = false; }
  }

  function endTable() {
    if (inTable) { result.push("</tbody></table>"); inTable = false; }
  }

  function endPara() {
    endList();
    endTable();
  }

  function parseInline(text) {
    let t = text;
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:8px 0;box-shadow:0 2px 8px rgba(0,0,0,0.12);">');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    return t;
  }

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Code block toggle
    if (line.startsWith("```")) {
      endPara();
      if (inCodeBlock) {
        result.push("</code></pre>");
        inCodeBlock = false;
      } else {
        result.push('<pre><code>');
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      result.push(rawLine);
      continue;
    }

    // Blank line
    if (line === "") {
      endPara();
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      endPara();
      const level = headingMatch[1].length;
      result.push(`<h${level} class="md-h${level}">${parseInline(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      endPara();
      result.push("<hr>");
      continue;
    }

    // Blockquote
    if (line.startsWith("&gt; ")) {
      endPara();
      result.push(`<blockquote>${parseInline(line.slice(5))}</blockquote>`);
      continue;
    }

    // Image on its own line
    const imgMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imgMatch) {
      endPara();
      result.push(`<p class="md-img-wrap">${parseInline(line)}</p>`);
      continue;
    }

    // Table row
    if (line.startsWith("|") && line.endsWith("|")) {
      endList();
      const cells = line.slice(1, -1).split("|").map(c => c.trim());
      if (cells.every(c => /^[-: ]+$/.test(c))) {
        // separator row, skip
        continue;
      }
      if (!inTable) {
        result.push('<table class="md-table"><thead>');
        result.push("<tr>" + cells.map(c => `<th>${parseInline(c)}</th>`).join("") + "</tr>");
        result.push("</thead><tbody>");
        inTable = true;
      } else {
        result.push("<tr>" + cells.map(c => `<td>${parseInline(c)}</td>`).join("") + "</tr>");
      }
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^[-*]\s+(.+)/);
    if (ulMatch) {
      endTable();
      if (!inList) { result.push("<ul>"); inList = true; }
      result.push(`<li>${parseInline(ulMatch[1])}</li>`);
      continue;
    }

    // Paragraph (default)
    endPara();
    result.push(`<p>${parseInline(line)}</p>`);
  }

  endPara();
  if (inCodeBlock) result.push("</code></pre>");

  return result.join("\n");
}

app.get("/usage", (req, res) => {
  try {
    const mdPath = path.join(__dirname, "USAGE.md");
    const md = fs.readFileSync(mdPath, "utf-8");
    const content = renderMarkdownToHtml(md);
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>使用说明 — FIT 轨迹生成工具</title>
<style>
  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f8fafc;
    color: #1e293b;
    font-size: 15px;
    line-height: 1.7;
  }
  .usage-container {
    max-width: 820px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }
  .usage-container h1 { font-size: 2em; margin: 0 0 0.3em; color: #0f172a; }
  .usage-container h2 {
    font-size: 1.4em; margin: 2em 0 0.6em; padding-bottom: 0.35em;
    border-bottom: 2px solid #e2e8f0; color: #0f172a;
  }
  .usage-container h3 { font-size: 1.15em; margin: 1.5em 0 0.5em; color: #334155; }
  .usage-container h4 { font-size: 1em; margin: 1.2em 0 0.4em; color: #475569; }
  .usage-container p { margin: 0.7em 0; }
  .usage-container ul { margin: 0.6em 0; padding-left: 1.5em; }
  .usage-container li { margin: 0.25em 0; }
  .usage-container code {
    background: #e2e8f0; padding: 2px 6px; border-radius: 4px;
    font-family: "SF Mono", "Fira Code", monospace; font-size: 0.9em;
  }
  .usage-container pre {
    background: #1e293b; color: #e2e8f0; padding: 16px 20px;
    border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.6;
  }
  .usage-container pre code { background: none; padding: 0; border-radius: 0; }
  .usage-container blockquote {
    margin: 12px 0; padding: 10px 16px;
    border-left: 4px solid #3b82f6; background: #eff6ff;
    border-radius: 0 6px 6px 0; color: #1e40af;
  }
  .usage-container hr { margin: 2em 0; border: none; border-top: 1px solid #e2e8f0; }
  .usage-container table {
    width: 100%; border-collapse: collapse; margin: 0.8em 0;
    font-size: 0.95em;
  }
  .usage-container th, .usage-container td {
    text-align: left; padding: 9px 14px;
    border-bottom: 1px solid #e2e8f0;
  }
  .usage-container th { background: #f1f5f9; font-weight: 700; color: #0f172a; }
  .usage-container td { color: #334155; }
  .usage-container img {
    max-width: 100%; border-radius: 8px; margin: 8px 0;
    box-shadow: 0 2px 12px rgba(0,0,0,0.1);
  }
  .usage-container a { color: #2563eb; text-decoration: none; }
  .usage-container a:hover { text-decoration: underline; }
  .usage-container .md-img-wrap { text-align: center; }
  .back-link {
    display: inline-block; margin-bottom: 24px; color: #64748b;
    font-size: 14px; text-decoration: none;
  }
  .back-link:hover { color: #1e293b; text-decoration: underline; }
  @media (max-width: 768px) {
    .usage-container { padding: 20px 16px 60px; }
    .usage-container h1 { font-size: 1.5em; }
  }
</style>
</head>
<body>
<div class="usage-container">
<p><a href="/" class="back-link">&larr; 返回工具</a></p>
${content}
</div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("无法加载使用说明");
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

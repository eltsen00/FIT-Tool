/* ── Runtime Config ── */
const CONFIG_URL = "./config.json";

let APP_CONFIG = {};
let DEFAULT_MAP_CENTER = [0, 0];
let DEFAULT_MAP_ZOOM = 1;
let DEFAULT_STADIUM_STRAIGHT_METERS = 0;
let DEFAULT_STADIUM_WIDTH_METERS = 0;
let DEFAULT_ROUTE_BEARING_DEGREES = 0;
let DEFAULT_JITTER_METERS = 0;
let ROUTE_POINT_SPACING_METERS = 1;
let MIN_STADIUM_STRAIGHT_METERS = 0;
let MAX_STADIUM_STRAIGHT_METERS = Number.MAX_SAFE_INTEGER;
let MIN_STADIUM_WIDTH_METERS = 0;
let MAX_STADIUM_WIDTH_METERS = Number.MAX_SAFE_INTEGER;
let MIN_JITTER_METERS = 0;
let MAX_JITTER_METERS = Number.MAX_SAFE_INTEGER;
let DEFAULT_PACE_SECONDS_PER_KM = 1;
let MIN_PACE_SECONDS_PER_KM = 1;
let MAX_PACE_SECONDS_PER_KM = Number.MAX_SAFE_INTEGER;
let DEFAULT_HR_REST = 0;
let DEFAULT_HR_MAX = 0;
let DEFAULT_LAP_COUNT = 1;
let MIN_HR_REST = 0;
let MAX_HR_REST = Number.MAX_SAFE_INTEGER;
let MIN_HR_MAX = 0;
let MAX_HR_MAX = Number.MAX_SAFE_INTEGER;
let MIN_LAP_COUNT = 0.1;
let MAX_LAP_COUNT = Number.MAX_SAFE_INTEGER;
let LAP_COUNT_STEP = 0.1;
let DEFAULT_EXPORT_COUNT = 1;
let MAX_EXPORT_COUNT = 1;
let MIN_EVENING_START_MINUTES = 0;
let MAX_EVENING_START_MINUTES = 24 * 60 - 1;
let EXPORT_LAP_RANDOM_SPREAD = 0;
let HR_REST_RANDOM_SPREAD = 0;
let HR_MAX_RANDOM_SPREAD = 0;
let PACE_RANDOM_SPREAD_SECONDS = 0;
let LAP_SEAM_BLEND_METERS = 0;
let TRACK_TEMPLATES = [];

/* ── Global State ── */
let routePoints = [];
let routeCenter = { lat: 0, lng: 0 };
let polyline = null;
let centerMarker = null;
let singleLapDistanceMeters = 0;
let displayedLapCount = 0;
let currentTemplateId = "custom";
let map = null;
let MAP_COORD_SYSTEM = "wgs84";

/* ── Coordinate Conversion: WGS-84 ↔ GCJ-02 ── */
const GCJ02 = (() => {
  const PI = Math.PI;
  const A = 6378245.0;
  const EE = 0.00669342162296594323;

  function outOfChina(lat, lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  function transformLat(x, y) {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * PI) + 320.0 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return r;
  }

  function transformLng(x, y) {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return r;
  }

  function delta(lat, lng) {
    if (outOfChina(lat, lng)) return { lat: 0, lng: 0 };
    const dLat = transformLat(lng - 105.0, lat - 35.0);
    const dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * PI;
    const magic = Math.sin(radLat);
    const m = 1 - EE * magic * magic;
    const sqrtM = Math.sqrt(m);
    return {
      lat: (dLat * 180.0) / ((A * (1 - EE)) / (m * sqrtM) * PI),
      lng: (dLng * 180.0) / ((A / sqrtM) * Math.cos(radLat) * PI)
    };
  }

  return {
    toGCJ02(lat, lng) {
      if (outOfChina(lat, lng)) return { lat, lng };
      const d = delta(lat, lng);
      return { lat: lat + d.lat, lng: lng + d.lng };
    },
    toWGS84(lat, lng) {
      if (outOfChina(lat, lng)) return { lat, lng };
      let wgsLat = lat, wgsLng = lng;
      for (let i = 0; i < 5; i++) {
        const d = delta(wgsLat, wgsLng);
        wgsLat = lat - d.lat;
        wgsLng = lng - d.lng;
      }
      return { lat: wgsLat, lng: wgsLng };
    }
  };
})();

function toDisplayCoord(lat, lng) {
  if (MAP_COORD_SYSTEM === "gcj02") return GCJ02.toGCJ02(lat, lng);
  return { lat, lng };
}

function fromDisplayCoord(lat, lng) {
  if (MAP_COORD_SYSTEM === "gcj02") return GCJ02.toWGS84(lat, lng);
  return { lat, lng };
}

/* ── Utility Functions ── */
function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function readFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cloneConfigObject(value) {
  return value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
}

async function loadAppConfig() {
  const res = await fetch(CONFIG_URL, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`配置文件加载失败：${res.status}`);
  }
  return res.json();
}

function getLimitValue(limit, key, fallback) {
  return readFiniteNumber(limit?.[key], fallback);
}

function normalizeTemplates(config) {
  const templates = Array.isArray(config.track?.templates)
    ? config.track.templates.map((template) => cloneConfigObject(template))
    : [];
  if (!templates.some((template) => template.id === "custom")) {
    templates.push({ id: "custom", name: "自定义" });
  }
  return templates;
}

function applyRuntimeConfig(config) {
  APP_CONFIG = config;

  const trackDefaults = config.track?.defaults || {};
  const trackLimits = config.track?.limits || {};
  const motionDefaults = config.motionDefaults || {};
  const motionLimits = config.motionLimits || {};
  const exportConfig = config.export || {};
  const randomization = exportConfig.randomization || {};
  const mapCenter = config.map?.defaultCenter || {};

  MAP_COORD_SYSTEM = config.map?.coordSystem || "wgs84";
  DEFAULT_MAP_CENTER = [
    readFiniteNumber(mapCenter.lat, 0),
    readFiniteNumber(mapCenter.lng, 0)
  ];
  DEFAULT_MAP_ZOOM = readFiniteNumber(config.map?.defaultZoom, 1);

  DEFAULT_ROUTE_BEARING_DEGREES = readFiniteNumber(trackDefaults.bearing, 0);
  DEFAULT_STADIUM_STRAIGHT_METERS = readFiniteNumber(trackDefaults.straightMeters, 0);
  DEFAULT_STADIUM_WIDTH_METERS = readFiniteNumber(trackDefaults.widthMeters, 0);
  DEFAULT_JITTER_METERS = readFiniteNumber(trackDefaults.jitterMeters, 0);
  ROUTE_POINT_SPACING_METERS = readFiniteNumber(config.track?.pointSpacingMeters, 1);
  LAP_SEAM_BLEND_METERS = readFiniteNumber(config.track?.seamBlendMeters, 0);

  MIN_STADIUM_STRAIGHT_METERS = getLimitValue(trackLimits.straightMeters, "min", 0);
  MAX_STADIUM_STRAIGHT_METERS = getLimitValue(trackLimits.straightMeters, "max", Number.MAX_SAFE_INTEGER);
  MIN_STADIUM_WIDTH_METERS = getLimitValue(trackLimits.widthMeters, "min", 0);
  MAX_STADIUM_WIDTH_METERS = getLimitValue(trackLimits.widthMeters, "max", Number.MAX_SAFE_INTEGER);
  MIN_JITTER_METERS = getLimitValue(trackLimits.jitterMeters, "min", 0);
  MAX_JITTER_METERS = getLimitValue(trackLimits.jitterMeters, "max", Number.MAX_SAFE_INTEGER);

  DEFAULT_HR_REST = readFiniteNumber(motionDefaults.hrRest, 0);
  DEFAULT_HR_MAX = readFiniteNumber(motionDefaults.hrMax, 0);
  DEFAULT_LAP_COUNT = readFiniteNumber(motionDefaults.lapCount, 1);
  DEFAULT_PACE_SECONDS_PER_KM = readFiniteNumber(motionDefaults.paceSecondsPerKm, 1);

  MIN_HR_REST = getLimitValue(motionLimits.hrRest, "min", 0);
  MAX_HR_REST = getLimitValue(motionLimits.hrRest, "max", Number.MAX_SAFE_INTEGER);
  MIN_HR_MAX = getLimitValue(motionLimits.hrMax, "min", 0);
  MAX_HR_MAX = getLimitValue(motionLimits.hrMax, "max", Number.MAX_SAFE_INTEGER);
  MIN_LAP_COUNT = getLimitValue(motionLimits.lapCount, "min", 0.1);
  MAX_LAP_COUNT = getLimitValue(motionLimits.lapCount, "max", Number.MAX_SAFE_INTEGER);
  LAP_COUNT_STEP = getLimitValue(motionLimits.lapCount, "step", 0.1);
  MIN_PACE_SECONDS_PER_KM = getLimitValue(motionLimits.paceSecondsPerKm, "min", 1);
  MAX_PACE_SECONDS_PER_KM = getLimitValue(motionLimits.paceSecondsPerKm, "max", Number.MAX_SAFE_INTEGER);

  DEFAULT_EXPORT_COUNT = readFiniteNumber(exportConfig.defaultCount, 1);
  MAX_EXPORT_COUNT = readFiniteNumber(exportConfig.maxCount, 1);
  MIN_EVENING_START_MINUTES = readFiniteNumber(exportConfig.eveningStartMinutes, 0);
  MAX_EVENING_START_MINUTES = readFiniteNumber(exportConfig.eveningEndMinutes, 24 * 60 - 1);
  EXPORT_LAP_RANDOM_SPREAD = readFiniteNumber(randomization.lapSpread, 0);
  HR_REST_RANDOM_SPREAD = readFiniteNumber(randomization.hrRestSpread, 0);
  HR_MAX_RANDOM_SPREAD = readFiniteNumber(randomization.hrMaxSpread, 0);
  PACE_RANDOM_SPREAD_SECONDS = readFiniteNumber(randomization.paceSpreadSeconds, 0);

  TRACK_TEMPLATES = normalizeTemplates(config);
  currentTemplateId = config.track?.defaultTemplateId || TRACK_TEMPLATES[0]?.id || "custom";

  const currentTemplate = TRACK_TEMPLATES.find((template) => template.id === currentTemplateId);
  const center = currentTemplate?.center || config.map?.defaultCenter || { lat: 0, lng: 0 };
  routeCenter = {
    lat: readFiniteNumber(center.lat, 0),
    lng: readFiniteNumber(center.lng, 0)
  };
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function formatNumber(value, digits = 1) {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatLapCount(value) {
  return formatNumber(roundToStep(value, LAP_COUNT_STEP), 1);
}

function randomLapCountAroundDefault(defaultLapCount) {
  const minLapCount = Math.max(MIN_LAP_COUNT, defaultLapCount - EXPORT_LAP_RANDOM_SPREAD);
  const maxLapCount = Math.min(MAX_LAP_COUNT, defaultLapCount + EXPORT_LAP_RANDOM_SPREAD);
  let lapCount = roundToStep(
    randomBetween(minLapCount, maxLapCount),
    LAP_COUNT_STEP
  );

  if (Number.isInteger(lapCount) && maxLapCount - minLapCount >= LAP_COUNT_STEP) {
    const canMoveUp = lapCount + LAP_COUNT_STEP <= maxLapCount;
    const canMoveDown = lapCount - LAP_COUNT_STEP >= minLapCount;
    if (canMoveUp && (!canMoveDown || Math.random() < 0.5)) {
      lapCount += LAP_COUNT_STEP;
    } else if (canMoveDown) {
      lapCount -= LAP_COUNT_STEP;
    }
  }

  return clampNumber(
    roundToStep(lapCount, LAP_COUNT_STEP),
    MIN_LAP_COUNT,
    MAX_LAP_COUNT,
    defaultLapCount
  );
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function computeDistanceMeters(points) {
  if (!points || points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(
      points[i - 1].lat, points[i - 1].lng,
      points[i].lat, points[i].lng
    );
  }
  return total;
}

function dateToLocalInputValue(d) {
  const tzOffset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tzOffset * 60000);
  return local.toISOString().slice(0, 16);
}

function paceSecondsToParts(totalSeconds) {
  const seconds = Math.max(1, Number.isFinite(totalSeconds) ? totalSeconds : DEFAULT_PACE_SECONDS_PER_KM);
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round((seconds - minutes * 60) * 10) / 10;
  return { minutes, seconds: restSeconds };
}

function formatPace(seconds) {
  const parts = paceSecondsToParts(seconds);
  return `${parts.minutes}'${parts.seconds.toFixed(0).padStart(2, '0')}"`;
}

function formatExportDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${m}-${day} ${h}:${min}`;
}

function readPaceSeconds(minValue, secValue) {
  const minutes = parseFloat(minValue);
  const seconds = parseFloat(secValue);
  const total =
    (Number.isFinite(minutes) ? minutes : 0) * 60 +
    (Number.isFinite(seconds) ? seconds : 0);
  return Number.isFinite(total) && total > 0
    ? clampNumber(total, MIN_PACE_SECONDS_PER_KM, MAX_PACE_SECONDS_PER_KM, DEFAULT_PACE_SECONDS_PER_KM)
    : DEFAULT_PACE_SECONDS_PER_KM;
}

/* ── Message ── */
function updateMessage(text, isError = false) {
  const el = document.getElementById("message");
  if (!el) return;
  el.textContent = text || "";
  el.className = "message" + (isError ? " error" : "");
}

/* ── Input Readers ── */
function getRouteBearingDegrees() {
  const input = document.getElementById("routeBearing");
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : DEFAULT_ROUTE_BEARING_DEGREES;
}

function getJitterMeters() {
  const input = document.getElementById("jitterMeters");
  const value = Number(input?.value);
  if (!Number.isFinite(value)) return DEFAULT_JITTER_METERS;
  return clampNumber(value, MIN_JITTER_METERS, MAX_JITTER_METERS, DEFAULT_JITTER_METERS);
}

function getStadiumStraightMeters() {
  const input = document.getElementById("stadiumStraightMeters");
  const value = Number(input?.value);
  return clampNumber(value, MIN_STADIUM_STRAIGHT_METERS, MAX_STADIUM_STRAIGHT_METERS, DEFAULT_STADIUM_STRAIGHT_METERS);
}

function getStadiumWidthMeters() {
  const input = document.getElementById("stadiumWidthMeters");
  const value = Number(input?.value);
  return clampNumber(value, MIN_STADIUM_WIDTH_METERS, MAX_STADIUM_WIDTH_METERS, DEFAULT_STADIUM_WIDTH_METERS);
}

function getLapCount() {
  const input = document.getElementById("lapCount");
  const value = parseFloat(input?.value);
  return clampNumber(value, MIN_LAP_COUNT, MAX_LAP_COUNT, DEFAULT_LAP_COUNT);
}

function getDefaultPaceSeconds() {
  const minInput = document.getElementById("paceMinDefault");
  const secInput = document.getElementById("paceSecDefault");
  return readPaceSeconds(minInput?.value, secInput?.value);
}

function setDefaultPaceSeconds(seconds) {
  const parts = paceSecondsToParts(seconds);
  const minInput = document.getElementById("paceMinDefault");
  const secInput = document.getElementById("paceSecDefault");
  if (minInput) minInput.value = String(parts.minutes);
  if (secInput) secInput.value = formatNumber(parts.seconds);
}

function setInputAttributes(id, attributes) {
  const input = document.getElementById(id);
  if (!input) return;
  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      input.setAttribute(key, String(value));
    }
  });
}

function writeInputValue(id, value) {
  const input = document.getElementById(id);
  if (input && value !== undefined && value !== null) {
    input.value = String(value);
  }
}

function applyConfiguredInputAttributes() {
  const trackLimits = APP_CONFIG.track?.limits || {};
  const motionLimits = APP_CONFIG.motionLimits || {};

  setInputAttributes("centerLat", { step: 0.000001 });
  setInputAttributes("centerLng", { step: 0.000001 });
  setInputAttributes("routeBearing", trackLimits.bearing || {});
  setInputAttributes("stadiumStraightMeters", trackLimits.straightMeters || {});
  setInputAttributes("stadiumWidthMeters", trackLimits.widthMeters || {});
  setInputAttributes("jitterMeters", trackLimits.jitterMeters || {});
  setInputAttributes("hrRest", motionLimits.hrRest || {});
  setInputAttributes("hrMax", motionLimits.hrMax || {});
  setInputAttributes("lapCount", motionLimits.lapCount || {});
  setInputAttributes("paceMinDefault", motionLimits.paceMinutes || {});
  setInputAttributes("paceSecDefault", motionLimits.paceSeconds || {});
  setInputAttributes("exportCount", {
    min: 1,
    max: MAX_EXPORT_COUNT,
    step: 1
  });
}

function applyConfiguredFormValues() {
  const template = getTemplateById(currentTemplateId);
  const trackDefaults = APP_CONFIG.track?.defaults || {};

  writeInputValue("routeBearing", template?.bearing ?? trackDefaults.bearing ?? DEFAULT_ROUTE_BEARING_DEGREES);
  writeInputValue("stadiumStraightMeters", template?.straightMeters ?? trackDefaults.straightMeters ?? DEFAULT_STADIUM_STRAIGHT_METERS);
  writeInputValue("stadiumWidthMeters", template?.widthMeters ?? trackDefaults.widthMeters ?? DEFAULT_STADIUM_WIDTH_METERS);
  writeInputValue("jitterMeters", template?.jitterMeters ?? trackDefaults.jitterMeters ?? DEFAULT_JITTER_METERS);
  writeInputValue("hrRest", DEFAULT_HR_REST);
  writeInputValue("hrMax", DEFAULT_HR_MAX);
  writeInputValue("lapCount", formatLapCount(DEFAULT_LAP_COUNT));
  writeInputValue("exportCount", DEFAULT_EXPORT_COUNT);
  setDefaultPaceSeconds(DEFAULT_PACE_SECONDS_PER_KM);
}

function initializeMap() {
  const displayCenter = toDisplayCoord(DEFAULT_MAP_CENTER[0], DEFAULT_MAP_CENTER[1]);
  map = L.map("map").setView([displayCenter.lat, displayCenter.lng], DEFAULT_MAP_ZOOM);
  const tileLayer = APP_CONFIG.map?.tileLayer || {};
  L.tileLayer(tileLayer.url, {
    maxZoom: tileLayer.maxZoom,
    attribution: tileLayer.attribution,
    subdomains: tileLayer.subdomains || []
  }).addTo(map);
}

/* ── Coordinate Conversion ── */
function getMetersPerDegreeLng(lat) {
  const meters = 111320 * Math.cos((lat * Math.PI) / 180);
  return Math.max(1e-6, Math.abs(meters));
}

function metersToLatLng(center, eastMeters, northMeters) {
  return {
    lat: center.lat + northMeters / 111320,
    lng: center.lng + eastMeters / getMetersPerDegreeLng(center.lat)
  };
}

function rotateLocalPoint(point, bearingDegrees) {
  const angle = (bearingDegrees * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    east: point.x * cos - point.y * sin,
    north: point.x * sin + point.y * cos
  };
}

function localPointToLatLng(point, bearingDegrees) {
  const rotated = rotateLocalPoint(point, bearingDegrees);
  return metersToLatLng(routeCenter, rotated.east, rotated.north);
}

/* ── Stadium Geometry ── */
function pushLocalPoint(points, x, y) {
  const last = points[points.length - 1];
  if (last && Math.abs(last.x - x) < 0.001 && Math.abs(last.y - y) < 0.001) return;
  points.push({ x, y });
}

function buildBaseStadiumLocalPoints() {
  const straightLength = getStadiumStraightMeters();
  const routeWidth = getStadiumWidthMeters();
  const halfStraight = straightLength / 2;
  const radius = routeWidth / 2;
  const straightSteps = Math.ceil(straightLength / ROUTE_POINT_SPACING_METERS);
  const arcSteps = Math.ceil((Math.PI * radius) / ROUTE_POINT_SPACING_METERS);
  const points = [];

  for (let i = 0; i <= straightSteps; i++) {
    pushLocalPoint(points, -halfStraight + (straightLength * i) / straightSteps, radius);
  }
  for (let i = 1; i <= arcSteps; i++) {
    const theta = Math.PI / 2 - (Math.PI * i) / arcSteps;
    pushLocalPoint(points, halfStraight + radius * Math.cos(theta), radius * Math.sin(theta));
  }
  for (let i = 1; i <= straightSteps; i++) {
    pushLocalPoint(points, halfStraight - (straightLength * i) / straightSteps, -radius);
  }
  for (let i = 1; i <= arcSteps; i++) {
    const theta = -Math.PI / 2 + (Math.PI * i) / arcSteps;
    pushLocalPoint(points, -halfStraight - radius * Math.cos(theta), radius * Math.sin(theta));
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (first && last && Math.hypot(first.x - last.x, first.y - last.y) < 0.001) {
    points.pop();
  }
  return points;
}

/* ── Noise / Jitter ── */
function buildClosedNoise(count, amplitudeMeters, harmonicWeights) {
  const values = [];
  const waves = harmonicWeights.map(([frequency, weight]) => ({
    frequency, weight, phase: Math.random() * Math.PI * 2
  }));
  const weightTotal = waves.reduce((sum, wave) => sum + wave.weight, 0) || 1;

  for (let i = 0; i < count; i++) {
    const t = (Math.PI * 2 * i) / count;
    const value = waves.reduce(
      (sum, wave) => sum + Math.sin(t * wave.frequency + wave.phase) * wave.weight, 0
    );
    values.push((value / weightTotal) * amplitudeMeters);
  }
  return values;
}

function addNaturalRouteJitter(localPoints, jitterMeters) {
  if (!jitterMeters || jitterMeters <= 0) {
    return localPoints.map((p) => ({ x: p.x, y: p.y }));
  }

  const count = localPoints.length;
  const lateralNoise = buildClosedNoise(count, jitterMeters, [[1, 0.42], [2, 0.28], [4, 0.18], [7, 0.08]]);
  const forwardNoise = buildClosedNoise(count, jitterMeters * 0.18, [[2, 0.5], [3, 0.3], [6, 0.2]]);
  const strideNoise = buildClosedNoise(count, jitterMeters * 0.12, [[18, 0.6], [24, 0.4]]);

  const jitteredPoints = localPoints.map((point, index) => {
    const prev = localPoints[(index - 1 + count) % count];
    const next = localPoints[(index + 1) % count];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const tangentX = dx / len;
    const tangentY = dy / len;
    const normalX = -tangentY;
    const normalY = tangentX;

    return {
      x: point.x + normalX * (lateralNoise[index] + strideNoise[index]) + tangentX * forwardNoise[index],
      y: point.y + normalY * (lateralNoise[index] + strideNoise[index]) + tangentY * forwardNoise[index]
    };
  });

  const baseCenter = localPoints.reduce(
    (sum, p) => ({ x: sum.x + p.x / count, y: sum.y + p.y / count }), { x: 0, y: 0 }
  );
  const jitteredCenter = jitteredPoints.reduce(
    (sum, p) => ({ x: sum.x + p.x / count, y: sum.y + p.y / count }), { x: 0, y: 0 }
  );
  const offsetX = jitteredCenter.x - baseCenter.x;
  const offsetY = jitteredCenter.y - baseCenter.y;

  return jitteredPoints.map((p) => ({ x: p.x - offsetX, y: p.y - offsetY }));
}

/* ── Lap Building ── */
function buildLapLatLngs(basePoints, jitterMeters, bearing) {
  const jitteredPoints = addNaturalRouteJitter(basePoints, jitterMeters);
  return jitteredPoints.map((point) => localPointToLatLng(point, bearing));
}

function sliceClosedLapPoints(lapPoints, startIndex, lapFraction) {
  const count = lapPoints.length;
  if (!count) return [];
  const clampedFraction = Math.max(0, Math.min(1, lapFraction));
  const segmentCount = Math.max(1, Math.round(count * clampedFraction));
  const result = [];
  for (let step = 0; step <= segmentCount; step++) {
    result.push({ ...lapPoints[(startIndex + step) % count] });
  }
  return result;
}

function smoothStep(t) {
  return t * t * (3 - 2 * t);
}

function getLapSeamBlendPointCount(pointCount) {
  if (pointCount < 2) return 0;
  const preferredCount = Math.round(LAP_SEAM_BLEND_METERS / ROUTE_POINT_SPACING_METERS);
  return Math.min(pointCount - 1, Math.max(3, preferredCount));
}

function blendLapStartToPreviousEnd(lapPoints, previousEndPoint) {
  if (!previousEndPoint || lapPoints.length < 2) {
    return lapPoints.map((point) => ({ ...point }));
  }

  const blendPointCount = getLapSeamBlendPointCount(lapPoints.length);
  const start = lapPoints[0];
  const offsetX = previousEndPoint.x - start.x;
  const offsetY = previousEndPoint.y - start.y;

  return lapPoints.map((point, index) => {
    if (index > blendPointCount) return { ...point };

    const t = index / blendPointCount;
    const weight = 1 - smoothStep(t);
    return {
      x: point.x + offsetX * weight,
      y: point.y + offsetY * weight
    };
  });
}

function buildRoutePointsForParams(lapCount, jitterMeters) {
  const basePoints = buildBaseStadiumLocalPoints();
  const bearing = getRouteBearingDegrees();
  const laps = Math.max(0.1, Number.isFinite(lapCount) ? lapCount : getLapCount());
  const fullLaps = Math.floor(laps);
  const partialLap = laps - fullLaps;
  const lapSlices = fullLaps + (partialLap > 0.001 ? 1 : 0);
  const randomStartIndex = Math.floor(Math.random() * basePoints.length);
  const localRoutePoints = [];
  let firstLapDistanceMeters = 0;

  for (let lapIndex = 0; lapIndex < lapSlices; lapIndex++) {
    const lapPoints = addNaturalRouteJitter(basePoints, jitterMeters);
    const lapFraction = lapIndex < fullLaps ? 1 : partialLap;
    const slicedLapPoints = sliceClosedLapPoints(lapPoints, randomStartIndex, lapFraction);
    const previousEndPoint = localRoutePoints[localRoutePoints.length - 1];
    const blendedLapPoints = blendLapStartToPreviousEnd(
      slicedLapPoints,
      previousEndPoint
    );
    const appendPoints = lapIndex > 0 ? blendedLapPoints.slice(1) : blendedLapPoints;
    localRoutePoints.push(...appendPoints);

    if (lapIndex === 0) {
      firstLapDistanceMeters = computeDistanceMeters(
        sliceClosedLapPoints(lapPoints, randomStartIndex, 1).map((point) =>
          localPointToLatLng(point, bearing)
        )
      );
    }
  }

  const points = localRoutePoints.map((point) => localPointToLatLng(point, bearing));
  return { points, singleLapDistanceMeters: firstLapDistanceMeters };
}

/* ── Route Rendering ── */
function renderRoute() {
  const latLngs = routePoints.map((point) => {
    const gcj = toDisplayCoord(point.lat, point.lng);
    return [gcj.lat, gcj.lng];
  });
  if (polyline) {
    polyline.setLatLngs(latLngs);
  } else {
    polyline = L.polyline(latLngs, {
      color: "#f97316",
      weight: 4,
      opacity: 0.9
    }).addTo(map);
  }
}

function renderCenterMarker() {
  const gcj = toDisplayCoord(routeCenter.lat, routeCenter.lng);
  if (centerMarker) {
    centerMarker.setLatLng([gcj.lat, gcj.lng]);
  } else {
    centerMarker = L.marker([gcj.lat, gcj.lng], {
      draggable: true
    }).addTo(map);

    centerMarker.on("dragend", (event) => {
      const latLng = event.target.getLatLng();
      const wgs = fromDisplayCoord(latLng.lat, latLng.lng);
      markTemplateAsCustom();
      setRouteCenter(wgs.lat, wgs.lng, "已拖动中心点更新跑道位置");
    });
  }
}

function rebuildStadiumRoute(message, options = {}) {
  const built = buildRoutePointsForParams(
    options.lapCount ?? getLapCount(),
    options.jitterMeters ?? getJitterMeters()
  );
  routePoints = built.points;
  singleLapDistanceMeters = built.singleLapDistanceMeters;
  displayedLapCount = options.lapCount ?? getLapCount();
  renderRoute();
  renderCenterMarker();
  updateRouteMetrics();
  updateSummaryBar();
  updateMessage(message || "已生成足球场跑道轨迹");
}

/* ── Center Point Management ── */
function syncCenterInputsFromState() {
  const latInput = document.getElementById("centerLat");
  const lngInput = document.getElementById("centerLng");
  if (latInput) latInput.value = routeCenter.lat.toFixed(6);
  if (lngInput) lngInput.value = routeCenter.lng.toFixed(6);
}

function readCenterFromInputs() {
  const latInput = document.getElementById("centerLat");
  const lngInput = document.getElementById("centerLng");
  const lat = parseFloat(latInput?.value);
  const lng = parseFloat(lngInput?.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function updateCenterDisplay() {
  syncCenterInputsFromState();
  const topbarCenter = document.getElementById("topbarCenter");
  if (topbarCenter) {
    topbarCenter.textContent = `${routeCenter.lat.toFixed(6)}, ${routeCenter.lng.toFixed(6)}`;
  }
  const mapInfo = document.getElementById("mapInfo");
  if (mapInfo) {
    mapInfo.textContent = `中心: ${routeCenter.lat.toFixed(6)}, ${routeCenter.lng.toFixed(6)}`;
  }
}

function setRouteCenter(lat, lng, message) {
  routeCenter = { lat, lng };
  updateCenterDisplay();
  rebuildStadiumRoute(message);
}

function moveMapToRouteCenter() {
  if (!map) return;
  const currentZoom = map.getZoom();
  const zoom = Number.isFinite(currentZoom) ? currentZoom : DEFAULT_MAP_ZOOM;
  const gcj = toDisplayCoord(routeCenter.lat, routeCenter.lng);
  map.setView([gcj.lat, gcj.lng], zoom, { animate: true });
}

function handleCenterInputChange() {
  const center = readCenterFromInputs();
  if (!center) {
    updateMessage("中心点经纬度无效", true);
    return;
  }
  markTemplateAsCustom();
  setRouteCenter(center.lat, center.lng, "已按输入经纬度更新跑道中心");
}

/* ── Template Management ── */
function populateTemplateSelect() {
  const select = document.getElementById("templateSelect");
  if (!select) return;
  select.innerHTML = "";
  TRACK_TEMPLATES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  });
  select.value = currentTemplateId;
}

function getTemplateById(id) {
  return TRACK_TEMPLATES.find((t) => t.id === id) || null;
}

function applyTrackTemplate(templateId) {
  const template = getTemplateById(templateId);
  if (!template || template.id === "custom") return;

  currentTemplateId = templateId;
  const select = document.getElementById("templateSelect");
  if (select) select.value = templateId;

  if (template.center) {
    routeCenter = { ...template.center };
  }
  if (template.bearing != null) {
    const input = document.getElementById("routeBearing");
    if (input) input.value = String(template.bearing);
  }
  if (template.straightMeters != null) {
    const input = document.getElementById("stadiumStraightMeters");
    if (input) input.value = String(template.straightMeters);
  }
  if (template.widthMeters != null) {
    const input = document.getElementById("stadiumWidthMeters");
    if (input) input.value = String(template.widthMeters);
  }
  if (template.jitterMeters != null) {
    const input = document.getElementById("jitterMeters");
    if (input) input.value = String(template.jitterMeters);
  }

  updateCenterDisplay();
  updateCurrentTemplateLabel();
  rebuildStadiumRoute(`已套用模板：${template.name}`);
  moveMapToRouteCenter();
}

function markTemplateAsCustom() {
  if (currentTemplateId === "custom") return;
  currentTemplateId = "custom";
  const select = document.getElementById("templateSelect");
  if (select) select.value = "custom";
  updateCurrentTemplateLabel();
}

function updateCurrentTemplateLabel() {
  const label = document.getElementById("currentTemplateLabel");
  const template = getTemplateById(currentTemplateId);
  if (label) {
    label.textContent = template ? template.name : "自定义";
  }
  const summaryTemplate = document.getElementById("summaryTemplate");
  if (summaryTemplate) {
    summaryTemplate.textContent = `模板：${template ? template.name : "自定义"}`;
  }
}

/* ── Route Metrics & Summary ── */
function updateRouteMetrics() {
  const mapInfo = document.getElementById("mapInfo");
  if (mapInfo) {
    const lapKm = (singleLapDistanceMeters / 1000).toFixed(2);
    mapInfo.textContent = `中心: ${routeCenter.lat.toFixed(6)}, ${routeCenter.lng.toFixed(6)} | 单圈: ${lapKm} km`;
  }
}

function updateSummaryBar() {
  const lapEl = document.getElementById("summaryLap");
  const totalEl = document.getElementById("summaryTotal");
  const exportsEl = document.getElementById("summaryExports");
  const dateRangeEl = document.getElementById("summaryDateRange");
  const timeRangeEl = document.getElementById("summaryTimeRange");

  const lapKm = singleLapDistanceMeters ? (singleLapDistanceMeters / 1000).toFixed(2) : "--";
  if (lapEl) lapEl.textContent = `单圈约：${lapKm} km`;

  if (routePoints && routePoints.length >= 2) {
    const totalKm = (computeDistanceMeters(routePoints) / 1000).toFixed(2);
    if (totalEl) totalEl.textContent = `当前总距离：${totalKm} km`;
  } else {
    if (totalEl) totalEl.textContent = "当前总距离：-- km";
  }

  const exportInput = document.getElementById("exportCount");
  const count = parseInt(exportInput?.value, 10) || 1;
  if (exportsEl) exportsEl.textContent = `导出：${count} 份`;

  const { dates, times } = getExportDateRange();
  if (dateRangeEl) dateRangeEl.textContent = `日期：${dates}`;
  if (timeRangeEl) timeRangeEl.textContent = `时间：${times}`;
}

function getExportDateRange() {
  const container = document.getElementById("exportTimes");
  if (!container) return { dates: "--", times: "--" };

  const cards = Array.from(container.querySelectorAll(".export-file-card"));
  if (!cards.length) return { dates: "--", times: "--" };

  const dateValues = [];
  const timeValues = [];

  cards.forEach((card) => {
    const input = card.querySelector(".export-time-input");
    if (input && input.value) {
      const d = new Date(input.value);
      if (!Number.isNaN(d.getTime())) {
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        dateValues.push(`${m}-${day}`);
        const h = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        timeValues.push(`${h}:${min}`);
      }
    }
  });

  dateValues.sort();
  timeValues.sort();

  const dates = dateValues.length
    ? (dateValues.length > 1 ? `${dateValues[0]} 至 ${dateValues[dateValues.length - 1]}` : dateValues[0])
    : "--";
  const times = timeValues.length
    ? (timeValues.length > 1 ? `${timeValues[0]}-${timeValues[timeValues.length - 1]}` : timeValues[0])
    : "--";

  return { dates, times };
}

/* ── Default Motion Settings ── */
function collectDefaultMotionSettings() {
  return {
    hrRest: parseInt(document.getElementById("hrRest")?.value, 10) || DEFAULT_HR_REST,
    hrMax: parseInt(document.getElementById("hrMax")?.value, 10) || DEFAULT_HR_MAX,
    lapCount: getLapCount(),
    jitterMeters: getJitterMeters(),
    paceSecondsPerKm: getDefaultPaceSeconds()
  };
}

/* ── Export Card: Randomize ── */
function randomizeExportSettings(index) {
  const defaults = collectDefaultMotionSettings();
  const hrRest = Math.round(clampNumber(
    defaults.hrRest + randomBetween(-HR_REST_RANDOM_SPREAD, HR_REST_RANDOM_SPREAD),
    MIN_HR_REST,
    MAX_HR_REST,
    defaults.hrRest
  ));
  const hrMax = Math.round(clampNumber(
    defaults.hrMax + randomBetween(-HR_MAX_RANDOM_SPREAD, HR_MAX_RANDOM_SPREAD),
    Math.max(MIN_HR_MAX, hrRest + 35),
    MAX_HR_MAX,
    defaults.hrMax
  ));
  const lapCount = randomLapCountAroundDefault(defaults.lapCount);
  const paceSeconds = clampNumber(
    Math.round(defaults.paceSecondsPerKm + randomBetween(-PACE_RANDOM_SPREAD_SECONDS, PACE_RANDOM_SPREAD_SECONDS)),
    MIN_PACE_SECONDS_PER_KM,
    MAX_PACE_SECONDS_PER_KM,
    defaults.paceSecondsPerKm
  );

  return {
    startTime: dateToLocalInputValue(eveningDateForExport(index)),
    hrRest,
    hrMax,
    lapCount,
    jitterMeters: defaults.jitterMeters,
    paceSeconds
  };
}

function eveningDateForExport(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(0, 0, 0, 0);
  const startMinute = Math.round(randomBetween(MIN_EVENING_START_MINUTES, MAX_EVENING_START_MINUTES));
  d.setHours(Math.floor(startMinute / 60), startMinute % 60, 0, 0);
  return d;
}

function randomizeAllExportSettings() {
  const container = document.getElementById("exportTimes");
  if (!container) return;

  const cards = Array.from(container.querySelectorAll(".export-file-card"));
  cards.forEach((card, i) => {
    const settings = randomizeExportSettings(i);
    writeExportSettingsToCard(card, settings);
    updateExportCardSummary(card);
  });

  updateSummaryBar();
  updateMessage("已重新随机全部导出参数");
}

function writeExportSettingsToCard(card, settings) {
  const timeInput = card.querySelector(".export-time-input");
  if (timeInput) timeInput.value = settings.startTime;

  const hrRestInput = card.querySelector(".export-hr-rest");
  if (hrRestInput) hrRestInput.value = String(settings.hrRest);

  const hrMaxInput = card.querySelector(".export-hr-max");
  if (hrMaxInput) hrMaxInput.value = String(settings.hrMax);

  const lapInput = card.querySelector(".export-lap-count");
  if (lapInput) lapInput.value = formatLapCount(settings.lapCount);

  const jitterInput = card.querySelector(".export-jitter");
  if (jitterInput) jitterInput.value = formatNumber(settings.jitterMeters);

  const paceParts = paceSecondsToParts(settings.paceSeconds);
  const paceMinInput = card.querySelector(".export-pace-min");
  if (paceMinInput) paceMinInput.value = String(paceParts.minutes);
  const paceSecInput = card.querySelector(".export-pace-sec");
  if (paceSecInput) paceSecInput.value = formatNumber(paceParts.seconds);
}

/* ── Export Card: Build / Rebuild ── */
function createNumberInput(className, value, min, max, step = "1") {
  const input = document.createElement("input");
  input.type = "number";
  input.className = className;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  return input;
}

function createExportField(labelText, input, fullWidth = false) {
  const field = document.createElement("label");
  field.className = "export-field" + (fullWidth ? " export-full-width" : "");
  const label = document.createElement("span");
  label.textContent = labelText;
  field.appendChild(label);
  field.appendChild(input);
  return field;
}

function renderExportCard(index, settings, expanded) {
  const paceParts = paceSecondsToParts(settings.paceSeconds);
  const card = document.createElement("article");
  card.className = "export-file-card" + (expanded ? " expanded" : "");
  card.dataset.index = String(index);

  /* Summary button */
  const summary = document.createElement("button");
  summary.className = "export-card-summary";
  summary.type = "button";

  const titleSpan = document.createElement("span");
  titleSpan.className = "export-title";
  titleSpan.textContent = `第 ${index + 1} 份`;

  const dateSpan = document.createElement("span");
  dateSpan.className = "export-date";
  dateSpan.textContent = formatExportDateTime(settings.startTime);

  const metaSpan = document.createElement("span");
  metaSpan.className = "export-meta";
  metaSpan.textContent = `${formatLapCount(settings.lapCount)} 圈 · ${formatPace(settings.paceSeconds)} · HR ${settings.hrRest}-${settings.hrMax}`;

  const expandIcon = document.createElement("span");
  expandIcon.className = "export-expand-icon";
  expandIcon.textContent = "▶";

  summary.appendChild(titleSpan);
  summary.appendChild(dateSpan);
  summary.appendChild(metaSpan);
  summary.appendChild(expandIcon);

  summary.addEventListener("click", () => {
    toggleExportCard(card);
  });

  /* Details */
  const details = document.createElement("div");
  details.className = "export-card-details";

  const timeInput = document.createElement("input");
  timeInput.type = "datetime-local";
  timeInput.className = "export-time-input";
  timeInput.dataset.index = String(index);
  timeInput.value = settings.startTime;
  timeInput.addEventListener("change", () => updateExportCardSummary(card));

  const grid = document.createElement("div");
  grid.className = "export-card-grid";

  grid.appendChild(createExportField("开始时间", timeInput, true));
  grid.appendChild(createExportField("静息心率", createNumberInput("export-hr-rest", settings.hrRest, MIN_HR_REST, MAX_HR_REST)));
  grid.appendChild(createExportField("最大心率", createNumberInput("export-hr-max", settings.hrMax, MIN_HR_MAX, MAX_HR_MAX)));
  grid.appendChild(createExportField("圈数", createNumberInput("export-lap-count", formatLapCount(settings.lapCount), MIN_LAP_COUNT, MAX_LAP_COUNT, LAP_COUNT_STEP)));
  grid.appendChild(createExportField("扰动（米）", createNumberInput("export-jitter", formatNumber(settings.jitterMeters), MIN_JITTER_METERS, MAX_JITTER_METERS, APP_CONFIG.track?.limits?.jitterMeters?.step ?? 0.1)));

  /* Pace field */
  const paceField = document.createElement("label");
  paceField.className = "export-field export-full-width";
  const paceLabel = document.createElement("span");
  paceLabel.textContent = "平均配速";
  const paceInputsDiv = document.createElement("div");
  paceInputsDiv.className = "export-pace-inputs";
  const paceMinLimit = APP_CONFIG.motionLimits?.paceMinutes || {};
  const paceSecLimit = APP_CONFIG.motionLimits?.paceSeconds || {};
  const paceMinInput = createNumberInput("export-pace-min", paceParts.minutes, paceMinLimit.min ?? 0, paceMinLimit.max ?? 20, paceMinLimit.step ?? 1);
  const paceSecInput = createNumberInput("export-pace-sec", formatNumber(paceParts.seconds), paceSecLimit.min ?? 0, paceSecLimit.max ?? 59.9, paceSecLimit.step ?? 0.1);
  paceInputsDiv.appendChild(paceMinInput);
  const sep1 = document.createElement("span");
  sep1.className = "pace-sep";
  sep1.textContent = "'";
  paceInputsDiv.appendChild(sep1);
  paceInputsDiv.appendChild(paceSecInput);
  const sep2 = document.createElement("span");
  sep2.className = "pace-sep";
  sep2.textContent = '"';
  paceInputsDiv.appendChild(sep2);
  paceField.appendChild(paceLabel);
  paceField.appendChild(paceInputsDiv);
  grid.appendChild(paceField);

  /* Actions */
  const actions = document.createElement("div");
  actions.className = "export-card-actions";
  const randomBtn = document.createElement("button");
  randomBtn.type = "button";
  randomBtn.textContent = "重新随机此份";
  randomBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const idx = parseInt(card.dataset.index, 10);
    const newSettings = randomizeExportSettings(idx);
    writeExportSettingsToCard(card, newSettings);
    updateExportCardSummary(card);
    updateSummaryBar();
  });
  actions.appendChild(randomBtn);

  details.appendChild(grid);
  details.appendChild(actions);

  /* Listen for changes in details to update summary */
  details.addEventListener("input", () => {
    updateExportCardSummary(card);
    updateSummaryBar();
  });

  card.appendChild(summary);
  card.appendChild(details);
  return card;
}

function updateExportCardSummary(card) {
  const dateSpan = card.querySelector(".export-date");
  const metaSpan = card.querySelector(".export-meta");

  const timeInput = card.querySelector(".export-time-input");
  if (dateSpan && timeInput) {
    dateSpan.textContent = formatExportDateTime(timeInput.value);
  }

  if (metaSpan) {
    const lapCount = parseFloat(card.querySelector(".export-lap-count")?.value) || 0;
    const paceMin = parseFloat(card.querySelector(".export-pace-min")?.value) || 0;
    const paceSec = parseFloat(card.querySelector(".export-pace-sec")?.value) || 0;
    const paceSeconds = paceMin * 60 + paceSec;
    const hrRest = card.querySelector(".export-hr-rest")?.value || "--";
    const hrMax = card.querySelector(".export-hr-max")?.value || "--";
    metaSpan.textContent = `${formatLapCount(lapCount)} 圈 · ${formatPace(paceSeconds)} · HR ${hrRest}-${hrMax}`;
  }
}

function toggleExportCard(card) {
  card.classList.toggle("expanded");
}

function rebuildExportTimes() {
  const container = document.getElementById("exportTimes");
  const exportInput = document.getElementById("exportCount");
  if (!container || !exportInput) return;

  const count = Math.max(1, Math.min(MAX_EXPORT_COUNT, parseInt(exportInput.value, 10) || DEFAULT_EXPORT_COUNT));
  const existingSettings = collectExistingExportSettings();

  container.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const settings = existingSettings[i] || randomizeExportSettings(i);
    const card = renderExportCard(i, settings, i === 0);
    container.appendChild(card);
  }

  updateSummaryBar();
}

function collectExistingExportSettings() {
  const container = document.getElementById("exportTimes");
  if (!container || !container.querySelectorAll) return [];

  return Array.from(container.querySelectorAll(".export-file-card")).map((card) => ({
    startTime: card.querySelector(".export-time-input")?.value || "",
    hrRest: readCardNumber(card, ".export-hr-rest", DEFAULT_HR_REST),
    hrMax: readCardNumber(card, ".export-hr-max", DEFAULT_HR_MAX),
    lapCount: readCardNumber(card, ".export-lap-count", getLapCount()),
    jitterMeters: readCardNumber(card, ".export-jitter", getJitterMeters()),
    paceSeconds: readPaceSeconds(
      card.querySelector(".export-pace-min")?.value,
      card.querySelector(".export-pace-sec")?.value
    )
  }));
}

function readCardNumber(card, selector, fallback) {
  const value = parseFloat(card.querySelector(selector)?.value);
  return Number.isFinite(value) ? value : fallback;
}

/* ── Export Requests Collection ── */
function collectExportRequests(exportCount) {
  const exportTimesContainer = document.getElementById("exportTimes");
  const cards = exportTimesContainer
    ? Array.from(exportTimesContainer.querySelectorAll(".export-file-card"))
    : [];

  if (cards.length < exportCount) {
    return { error: "导出份数与参数卡片数量不一致" };
  }

  const requests = [];
  for (let i = 0; i < exportCount; i++) {
    const card = cards[i];
    const input = card.querySelector(".export-time-input");
    if (!input || !input.value) {
      return { error: `请为第 ${i + 1} 份设置开始日期时间` };
    }

    const fileStart = new Date(input.value);
    if (Number.isNaN(fileStart.getTime())) {
      return { error: `第 ${i + 1} 份的开始时间无效` };
    }

    const paceMinInput = card.querySelector(".export-pace-min");
    const paceSecInput = card.querySelector(".export-pace-sec");
    const paceMin = parseFloat(paceMinInput?.value);
    const paceSec = parseFloat(paceSecInput?.value);
    const paceSecondsPerKm =
      (Number.isFinite(paceMin) ? paceMin : 0) * 60 +
      (Number.isFinite(paceSec) ? paceSec : 0);
    if (!paceSecondsPerKm || paceSecondsPerKm <= 0) {
      return { error: `第 ${i + 1} 份的配速无效` };
    }

    const hrRest = Math.round(readCardNumber(card, ".export-hr-rest", DEFAULT_HR_REST));
    const hrMax = Math.round(readCardNumber(card, ".export-hr-max", DEFAULT_HR_MAX));
    if (hrMax <= hrRest) {
      return { error: `第 ${i + 1} 份的最大心率必须大于静息心率` };
    }

    requests.push({
      startTime: fileStart,
      paceSecondsPerKm,
      hrRest,
      hrMax,
      lapCount: clampNumber(readCardNumber(card, ".export-lap-count", getLapCount()), MIN_LAP_COUNT, MAX_LAP_COUNT, getLapCount()),
      jitterMeters: clampNumber(readCardNumber(card, ".export-jitter", getJitterMeters()), MIN_JITTER_METERS, MAX_JITTER_METERS, getJitterMeters())
    });
  }

  return { requests };
}

/* ── FIT Generation ── */
function getFitFileName(file, index, exportCount) {
  const timeTag = dateToLocalInputValue(file.startTime)
    .replace("T", "_")
    .replace(":", "-");
  return exportCount > 1
    ? `run_${index + 1}_${timeTag}.fit`
    : `run_${timeTag}.fit`;
}

function buildRouteForExport(file) {
  return buildRoutePointsForParams(file.lapCount, file.jitterMeters);
}

async function downloadFitFile(file, fileRoute, index, exportCount) {
  const res = await fetch("api/generate-fit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startTime: file.startTime.toISOString(),
      points: fileRoute.points,
      paceSecondsPerKm: file.paceSecondsPerKm,
      hrRest: file.hrRest,
      hrMax: file.hrMax,
      lapCount: file.lapCount,
      pointsIncludeLaps: true,
      variantIndex: index + 1
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || "生成失败");
  }

  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = getFitFileName(file, index, exportCount);
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

async function generateFit() {
  const exportInput = document.getElementById("exportCount");
  const exportCount = Math.max(1, Math.min(MAX_EXPORT_COUNT, parseInt(exportInput?.value, 10) || DEFAULT_EXPORT_COUNT));
  const { requests, error } = collectExportRequests(exportCount);

  if (error) {
    updateMessage(error, true);
    return;
  }

  try {
    let displayedFirstRoute = false;
    for (let i = 0; i < exportCount; i++) {
      updateMessage(`正在生成第 ${i + 1}/${exportCount} 个 FIT 文件，请稍候...`);
      const file = requests[i];
      const fileRoute = buildRouteForExport(file);

      if (fileRoute.points.length < 2) {
        updateMessage(`第 ${i + 1} 份的跑道轨迹生成失败`, true);
        return;
      }

      if (!displayedFirstRoute) {
        routePoints = fileRoute.points;
        singleLapDistanceMeters = fileRoute.singleLapDistanceMeters;
        displayedLapCount = file.lapCount;
        renderRoute();
        renderCenterMarker();
        updateRouteMetrics();
        displayedFirstRoute = true;
      }

      await downloadFitFile(file, fileRoute, i, exportCount);
    }
    updateMessage(`已生成 ${exportCount} 个 FIT 文件并开始下载`);
    updateSummaryBar();
  } catch (e) {
    console.error(e);
    updateMessage(e.message || "请求失败，请稍后重试", true);
  }
}

function fitRouteToMapCenter() {
  const center = map.getCenter();
  const wgs = fromDisplayCoord(center.lat, center.lng);
  markTemplateAsCustom();
  setRouteCenter(wgs.lat, wgs.lng, "已将跑道套到当前视野中心");
}

function setupEventListeners() {
  map.on("click", (e) => {
    const wgs = fromDisplayCoord(e.latlng.lat, e.latlng.lng);
    markTemplateAsCustom();
    setRouteCenter(wgs.lat, wgs.lng, "已将跑道中心移动到点击位置");
  });

  const routeBearingInput = document.getElementById("routeBearing");
  if (routeBearingInput) {
    routeBearingInput.addEventListener("input", () => {
      markTemplateAsCustom();
      rebuildStadiumRoute("已按新的方向角更新跑道轨迹");
    });
  }

  const stadiumStraightInput = document.getElementById("stadiumStraightMeters");
  if (stadiumStraightInput) {
    stadiumStraightInput.addEventListener("input", () => {
      markTemplateAsCustom();
      rebuildStadiumRoute("已按新的长边更新跑道轨迹");
    });
  }

  const stadiumWidthInput = document.getElementById("stadiumWidthMeters");
  if (stadiumWidthInput) {
    stadiumWidthInput.addEventListener("input", () => {
      markTemplateAsCustom();
      rebuildStadiumRoute("已按新的宽度更新跑道轨迹");
    });
  }

  const jitterInput = document.getElementById("jitterMeters");
  if (jitterInput) {
    jitterInput.addEventListener("input", () => {
      markTemplateAsCustom();
      rebuildStadiumRoute("已按新的扰动强度更新轨迹");
    });
  }

  const lapInputInit = document.getElementById("lapCount");
  if (lapInputInit) {
    lapInputInit.addEventListener("input", () => {
      rebuildStadiumRoute("已按新的圈数更新跑道轨迹");
    });
  }

  const exportInputInit = document.getElementById("exportCount");
  if (exportInputInit) {
    exportInputInit.addEventListener("input", rebuildExportTimes);
  }

  const centerLatInput = document.getElementById("centerLat");
  const centerLngInput = document.getElementById("centerLng");
  if (centerLatInput) centerLatInput.addEventListener("change", handleCenterInputChange);
  if (centerLngInput) centerLngInput.addEventListener("change", handleCenterInputChange);

  const templateSelect = document.getElementById("templateSelect");
  if (templateSelect) {
    templateSelect.addEventListener("change", () => {
      applyTrackTemplate(templateSelect.value);
    });
  }

  const fitToViewBtn = document.getElementById("fitToViewCenter");
  if (fitToViewBtn) {
    fitToViewBtn.addEventListener("click", fitRouteToMapCenter);
  }

  const genBtn = document.getElementById("generateFit");
  if (genBtn) {
    genBtn.addEventListener("click", generateFit);
  }

  const randomizeAllBtn = document.getElementById("randomizeAllExports");
  if (randomizeAllBtn) {
    randomizeAllBtn.addEventListener("click", randomizeAllExportSettings);
  }
}

/* ── Init ── */
async function initializeApp() {
  try {
    const config = await loadAppConfig();
    applyRuntimeConfig(config);
    applyConfiguredInputAttributes();
    applyConfiguredFormValues();
    initializeMap();
    populateTemplateSelect();
    setupEventListeners();
    updateCenterDisplay();
    updateCurrentTemplateLabel();
    rebuildExportTimes();
    rebuildStadiumRoute("已自动生成足球场跑道轨迹");
  } catch (error) {
    console.error(error);
    updateMessage(error.message || "配置加载失败", true);
  }
}

initializeApp();

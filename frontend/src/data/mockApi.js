// Простая имитация REST-API для прототипа интерфейса.
// Данные держатся в памяти и обновляются при каждом запросе, чтобы экран выглядел "живым".

const parameterMeta = {
  temperature: { label: 'Температура', unit: '°C', ref: [22, 25] },
  humidity: { label: 'Влажность', unit: '%', ref: [70, 80] },
  co2: { label: 'CO₂', unit: 'ppm', ref: [1000, 1500] },
  light: { label: 'Освещённость', unit: 'lx', ref: [9000, 18000] },
  ph: { label: 'Кислотность раствора (pH)', unit: 'pH', ref: [5.8, 6.2] },
  ec: { label: 'EC', unit: 'mS/см', ref: [1.5, 2.5] },
  rootHumidity: { label: 'Влажность в зоне корней', unit: '%', ref: [95, 100] },
  pressure: { label: 'Давление', unit: 'кПа', ref: [95, 105] },
  ndvi: { label: 'NDVI', unit: '', ref: [0.5, 0.75] },
};

const zones = [
  { id: 'z-1', name: 'Зона А1', row: 1, column: 1, technology: 'Гидропоника NFT', status: 'ok' },
  { id: 'z-2', name: 'Зона А2', row: 1, column: 2, technology: 'Гидропоника DWC', status: 'warn' },
  { id: 'z-3', name: 'Зона B1', row: 2, column: 1, technology: 'Аэропоника', status: 'ok' },
  { id: 'z-4', name: 'Зона B2', row: 2, column: 2, technology: 'Аэропоника', status: 'critical' },
];

const sensors = [
  { id: 1, serial: 'WB-MSW v.4', name: 'Комбинированный цифровой датчик', parameter: 'humidity', unit: '%', zoneId: 'z-1', min: 0, max: 95 },
  { id: 2, serial: 'NDVI S2-112-SS', name: 'Двухканальный датчик NDVI', parameter: 'ndvi', unit: '', zoneId: 'z-1', min: 0, max: 0 },
  { id: 3, serial: 'WB-MSW v.4', name: 'Комбинированный цифровой датчик', parameter: 'temperature', unit: '°C', zoneId: 'z-1', min: -40, max: 80 },
  { id: 4, serial: 'WB-MSW v.4', name: 'Комбинированный цифровой датчик', parameter: 'co2', unit: 'ppm', zoneId: 'z-1', min: 400, max: 10000 },
  { id: 5, serial: 'NDVI S2-112-РР', name: 'Двухканальный датчик NDVI', parameter: 'ndvi', unit: '', zoneId: 'z-3', min: 0, max: 0 },
  { id: 6, serial: 'AQ150-PH-2026-001', name: 'Промышленный контроллер pH', parameter: 'ph', unit: 'pH', zoneId: 'z-2', min: 0, max: 14 },
  { id: 7, serial: 'AQEC150-RS485-2026-001', name: 'Промышленный кондуктометр', parameter: 'ec', unit: 'мС/см', zoneId: 'z-2', min: 0.05, max: 200 },
  { id: 8, serial: 'EE310-RH-2026-001', name: 'Высококачественный датчик влажности и температуры', parameter: 'rootHumidity', unit: '%', zoneId: 'z-3', min: 0, max: 100 },
];

const actuators = [
  { id: 1, serial: 'BALLU-BFH-S10', name: 'Ballu BFH-S10', type: 'Тепловентилятор', status: 'on' },
  { id: 2, serial: 'DAIKIN-FTXM35R', name: 'Daikin FTXM35R', type: 'Кондиционер', status: 'on' },
  { id: 3, serial: 'TROTEC-TTK-350-S', name: 'Trotec TTK 350 S', type: 'Осушитель воздуха', status: 'on' },
  { id: 4, serial: 'DANFOSS-EV220B', name: 'Danfoss EV220B', type: 'Электромагнитный клапан подачи CO2', status: 'on' },
  { id: 5, serial: 'ROVDC-5-2026-001', name: 'Reef Octopus Varios-4 DC Pump', type: 'Насос подачи раствора', status: 'on' },
  { id: 7, serial: 'ASCO-238610-2026-001', name: 'ASCO 238610 Series Solenoid Valve', type: 'Электромагнитный клапан подачи раствора', status: 'on' },
  { id: 8, serial: 'HAOPAI-24V-UMK-2026-001', name: 'HaoPai 24V Ultrasonic Mist Maker', type: 'Ультразвуковой распылитель аэропонной системы', status: 'on' },
  { id: 9, serial: 'PURITY-PZ-50-125-40-2026-001', name: 'Purity PZ 50-125/40', type: 'Дренажный насос', status: 'on' },
];

const state = {
  history: {},
  errors: [],
  lastUpdated: Date.now(),
};

// Генерация случайного значения в заданном диапазоне.
const rand = (min, max) => +(Math.random() * (max - min) + min).toFixed(2);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clampToReference = (key, value) => {
  const ref = parameterMeta[key]?.ref;
  if (!Array.isArray(ref)) return value;
  return clamp(value, ref[0], ref[1]);
};

const parameterBaselines = {
  temperature: 23,
  humidity: 75,
  co2: 1250,
  light: 15000,
  ph: 6,
  ec: 2,
  rootHumidity: 97,
  pressure: 100,
  ndvi: 0.62,
};

const actuatorState = actuators.reduce((acc, a) => {
  acc[a.id] = a.status;
  return acc;
}, {});

// Получение начала часа для временной метки.
function startOfHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// Проверка принадлежности зоны к гидропонной технологии.
function isHydroZone(zone) {
  const tech = (zone?.technology || '').toLowerCase();
  return tech.includes('гидро') || tech.includes('hydro');
}

// Запись тестового восстановления NDVI после полива.
function writeNdviRecovery(zoneId) {
  const history = state.history[zoneId]?.ndvi;
  if (!history) return false;

  const start = startOfHour(Date.now());
  const end = start + 23 * 60 * 60 * 1000;
  const latest = Number(history.filter((p) => p.ts <= start).at(-1)?.value);
  const startValue = Math.min(Number.isFinite(latest) ? latest : 0.4, 0.61);
  const target = 0.62;
  state.history[zoneId].ndvi = history.filter((p) => p.ts < start || p.ts > end);

  for (let i = 0; i < 24; i += 1) {
    const ratio = i / 23;
    const eased = 1 - (1 - ratio) ** 2;
    const value = +(startValue + (target - startValue) * eased).toFixed(2);
    state.history[zoneId].ndvi.push({ ts: start + i * 60 * 60 * 1000, value });
  }
  state.history[zoneId].ndvi.sort((a, b) => a.ts - b.ts);
  return true;
}

// Заполнение начальной истории тестовых измерений.
function seedHistory() {
  const baseHour = startOfHour(Date.now());
  zones.forEach((zone) => {
    state.history[zone.id] = state.history[zone.id] || {};
    Object.keys(parameterMeta).forEach((key) => {
      state.history[zone.id][key] = [];
      const base = parameterBaselines[key] ?? 0;
      for (let i = 24; i >= 0; i -= 1) {
        const ts = baseHour - i * 60 * 60 * 1000;
        const noiseScale = key === 'ndvi' ? 0.02 : key === 'co2' ? 35 : 0.8;
        const driftScale = key === 'co2' ? 55 : key === 'humidity' ? 1.4 : 0.45;
        const noise = rand(-1, 1) * noiseScale;
        const drift = Math.sin(i / 4) * driftScale;
        const value = +clampToReference(key, base + noise + drift + rand(-0.2, 0.2)).toFixed(2);
        state.history[zone.id][key].push({ ts, value });
      }
    });
  });
}

// Добавление точки тестового временного ряда.
function pushPoint(zoneId, key, value, tsOverride) {
  const ts = tsOverride ?? Date.now();
  state.history[zoneId][key].push({ ts, value: +clampToReference(key, value).toFixed(2) });
  if (state.history[zoneId][key].length > 240) {
    state.history[zoneId][key].shift();
  }
}

// Добавление тестовой ошибки при отклонениях параметров.
function maybeAddError(zoneId) {
  const roll = Math.random();
  if (roll > 0.93) {
    const sensor = sensors.find((s) => s.zoneId === zoneId) || sensors[0];
    const code = roll > 0.97 ? 'CRIT' : 'WARN';
    const text = code === 'CRIT' ? 'Авария насоса питания' : 'Отклонение параметра';
    state.errors.unshift({
      id: `E-${Date.now()}`,
      ts: Date.now(),
      code,
      text,
      sensorId: sensor.id,
      zoneId,
      severity: code === 'CRIT' ? 'critical' : 'warning',
    });
    state.errors = state.errors.slice(0, 40);
  }
}

// Обновление тестовых данных одним шагом генерации.
function tick() {
  const now = Date.now();
  if (now - state.lastUpdated < 1500) return;
  const hourTs = startOfHour(now);
  const isHourBoundary = now - hourTs < 60 * 1000;
  zones.forEach((zone) => {
    const stress = zone.status === 'critical' ? 4 : zone.status === 'warn' ? 2 : 1;
    Object.keys(parameterMeta).forEach((key) => {
      if (key === 'ndvi') {
        const lastTs = state.history[zone.id][key].at(-1)?.ts ?? 0;
        if (!isHourBoundary || lastTs >= hourTs) return;
      }
      const base = parameterBaselines[key] ?? 0;
      const last = state.history[zone.id][key].at(-1)?.value ?? base;
      const noiseScale = key === 'ndvi' ? 0.01 : key === 'co2' ? 12 : 0.35;
      const trendScale = key === 'co2' ? 35 : key === 'humidity' ? 0.8 : 0.25;
      const correction = (base - last) * 0.08;
      const noise = rand(-1, 1) * noiseScale * stress;
      const trend = Math.sin(now / 1000 / 80) * trendScale;
      const next = last + correction + noise + trend;
      const tsOverride = key === 'ndvi' ? hourTs : undefined;
      pushPoint(zone.id, key, next, tsOverride);
    });
    maybeAddError(zone.id);
  });
  Object.keys(actuatorState).forEach((id) => {
    const roll = Math.random();
    if (roll > 0.97) actuatorState[id] = actuatorState[id] === 'on' ? 'off' : 'on';
    if (roll > 0.995) actuatorState[id] = 'standby';
  });
  state.lastUpdated = now;
}

seedHistory();

// Расчет среднего значения массива.
function avg(values) {
  if (!values.length) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return +(sum / values.length).toFixed(2);
}

// Получение тестовых данных главной панели.
export function getDashboard() {
  tick();
  const aggregates = {};
  Object.keys(parameterMeta).forEach((key) => {
    const latest = zones.map((z) => state.history[z.id][key].at(-1)?.value ?? 0);
    aggregates[key] = avg(latest);
  });
  const latestErrors = state.errors.slice(0, 4);
  const alertCount = latestErrors.filter((e) => e.severity === 'critical').length;
  const warnCount = latestErrors.filter((e) => e.severity === 'warning').length;
  return {
    updatedAt: state.lastUpdated,
    aggregates,
    errors: latestErrors,
    alertCount,
    warnCount,
  };
}

// Получение тестового списка зон.
export function getZones({ search = '', technology } = {}) {
  tick();
  const q = search.toLowerCase();
  // Получение текущих тестовых метрик зоны.
  const getMetrics = (zone) => {
    const tech = (zone.technology || '').toLowerCase();
    const isHydro = tech.includes('гидро') || tech.includes('hydro');
    const isAero = tech.includes('аэро') || tech.includes('aero');
    const metrics = {};
    if (isHydro) {
      metrics.pressure = state.history[zone.id].pressure.at(-1)?.value ?? 0;
      metrics.ec = state.history[zone.id].ec.at(-1)?.value ?? 0;
    } else if (isAero) {
      const rootHistory =
        state.history[zone.id].rootHumidity || state.history[zone.id].humidity || [];
      metrics.rootHumidity = rootHistory.at(-1)?.value ?? 0;
      metrics.ec = state.history[zone.id].ec.at(-1)?.value ?? 0;
    }
    return metrics;
  };
  let list = zones.map((z) => {
    const ndvi = state.history[z.id].ndvi.at(-1)?.value ?? parameterBaselines.ndvi;
    return { ...z, ndvi, isWatering: false, metrics: getMetrics(z) };
  });
  if (q) {
    list = list.filter((z) => z.name.toLowerCase().includes(q) || z.technology.toLowerCase().includes(q));
  }
  if (technology) {
    list = list.filter((z) => z.technology === technology);
  }
  return list;
}

// Получение тестовой подробной информации о зоне.
export function getZoneDetails(id, { hours = 24 } = {}) {
  tick();
  const zone = zones.find((z) => z.id === id);
  if (!zone) return null;
  const history = state.history[id];
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  // Выбор точек истории за указанный период.
  const slice = (key) => history[key].filter((p) => p.ts >= cutoff);
  const ndvi = history.ndvi.at(-1)?.value ?? parameterBaselines.ndvi;
  const relatedSensors = sensors.filter((s) => s.zoneId === id);
  const refs = Object.entries(parameterMeta).reduce((acc, [key, meta]) => {
    acc[key] = meta.ref;
    return acc;
  }, {});
  const current = Object.keys(parameterMeta).reduce((acc, key) => {
    acc[key] = history[key].at(-1)?.value ?? parameterBaselines[key];
    return acc;
  }, {});
  return {
    zone: { ...zone, ndvi },
    sensors: relatedSensors,
    references: refs,
    current,
    series: {
      microclimate: ['temperature', 'humidity', 'co2', 'light'].map((key) => ({
        key,
        label: parameterMeta[key].label,
        unit: parameterMeta[key].unit,
        data: slice(key),
      })),
      solution: ['ec', 'pressure'].map((key) => ({
        key,
        label: parameterMeta[key].label,
        unit: parameterMeta[key].unit,
        data: slice(key),
      })),
      ndvi: slice('ndvi'),
    },
    errors: state.errors.filter((e) => e.zoneId === id).slice(0, 6),
  };
}

// Получение тестового списка датчиков.
export function getSensors({ search = '', parameter } = {}) {
  tick();
  const q = search.toLowerCase();
  let list = sensors.map((s) => {
    const last = state.history[s.zoneId][s.parameter].at(-1)?.value ?? null;
    return { ...s, value: last };
  });
  if (q) {
    list = list.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      String(s.id).toLowerCase().includes(q) ||
      String(s.serial || '').toLowerCase().includes(q)
    );
  }
  if (parameter) {
    list = list.filter((s) => s.parameter === parameter);
  }
  return list;
}

// Получение тестового списка исполнительных устройств.
export function getActuators({ search = '' } = {}) {
  tick();
  const q = search.toLowerCase();
  let list = actuators.map((a) => ({ ...a, status: actuatorState[a.id] ?? a.status }));
  if (q) {
    list = list.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      String(a.id).toLowerCase().includes(q) ||
      String(a.serial || '').toLowerCase().includes(q)
    );
  }
  return list;
}

// Получение тестового журнала ошибок.
export function getErrors({ zoneId, severity } = {}) {
  tick();
  let list = [...state.errors];
  if (zoneId) list = list.filter((e) => e.zoneId === zoneId);
  if (severity) list = list.filter((e) => e.severity === severity);
  return list;
}

// Тестовый запуск принудительного полива нескольких зон.
export function forceWateringBatch(zoneIds = []) {
  tick();
  const uniqueIds = Array.from(new Set(zoneIds.map((id) => String(id))));
  const results = uniqueIds.map((id) => {
    const zone = zones.find((z) => String(z.id) === id);
    if (!zone) return { id, ok: false, error: 'Zone not found' };
    const ndviRecovery = isHydroZone(zone) ? writeNdviRecovery(zone.id) : false;
    return { id, ok: true, runId: null, ndviRecovery };
  });
  const success = results.filter((r) => r.ok).length;
  return { ok: success === results.length, success, failed: results.length - success, results };
}

// Получение тестового отчета по NDVI и ошибкам.
export function getReport({ fromHours = 168 } = {}) {
  tick();
  const cutoff = Date.now() - fromHours * 60 * 60 * 1000;
  const series = zones.map((zone) => {
    const ndviPoints = state.history[zone.id].ndvi.slice(-24);
    const avgNdvi = avg(ndviPoints.map((p) => p.value));
    const alerts = state.errors.filter((e) => e.zoneId === zone.id && e.ts >= cutoff);
    return {
      zone: zone.name,
      avgNdvi,
      alerts: alerts.length,
      critical: alerts.filter((a) => a.severity === 'critical').length,
    };
  });
  return { fromHours, series };
}

// Тестовое включение отопления.
export function setTemperatureHeating() {
  return { ok: true, heating: true };
}

// Тестовый сброс температурного сценария.
export function resetTemperatureScenario() {
  return { ok: true };
}

// Тестовое включение или отключение температурного сценария.
export function setTemperatureScenarioActive({ active } = {}) {
  return { ok: true, active: active !== false };
}

// Получение тестового состояния температурного сценария.
export function getTemperatureScenarioStatus() {
  return { active: true, phase: 'cooling' };
}

export const meta = parameterMeta;

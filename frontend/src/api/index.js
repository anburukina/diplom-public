import { meta as mockMeta } from '../data/mockApi';
import * as mock from '../data/mockApi';

const baseUrl = import.meta.env.VITE_API_URL;
const useMock = !baseUrl;
const apiBaseUrl = String(baseUrl || '').replace(/\/$/, '');

// Приведение значения к массиву.
const asArray = (value) => (Array.isArray(value) ? value : []);

// Чтение JSON-ответа от сервера.
async function readJson(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('API returned invalid JSON');
  }
}

// Выполнение HTTP-запроса к backend API.
async function request(path, options = {}) {
  const res = await fetch(`${apiBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status} ${res.statusText}`);
  }
  return readJson(res);
}

const realApi = {
  // Получение данных главной панели.
  async getDashboard() {
    const data = await request('/api/dashboard2');
    const aggregates = data?.aggregates ?? data ?? {};
    const errors = asArray(data?.errors);
    const alertCount = errors.filter((e) => (e.severity || e.status) === 'critical').length;
    const warnCount = errors.filter((e) => (e.severity || e.status) === 'warning').length;
    return { updatedAt: Date.now(), aggregates, errors, alertCount, warnCount };
  },

  // Получение списка зон.
  async getZones(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('q', params.search);
    if (params.technology) searchParams.set('technology', params.technology);
    const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const data = await request(`/api/zones${query}`);
    return data;
  },

  // Получение подробной информации о зоне.
  async getZoneDetails(id, { hours = 24 } = {}) {
    const [zone, errors, sensors, measurements, ndviRaw] = await Promise.all([
      request(`/api/zones/${id}`),
      request(`/api/errors?zoneId=${id}`),
      request(`/api/sensors?zoneId=${id}`),
      request(`/api/zones/${id}/measurements?hours=${Math.max(1, Math.ceil(hours))}`),
      request(`/api/zones/${id}/ndvi?limit=${Math.max(24, Math.ceil(hours))}`),
    ]);

    const paramMap = {
      '\u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u0430 \u0432\u043e\u0437\u0434\u0443\u0445\u0430': 'temperature',
      '\u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442\u0443\u0440\u0430': 'temperature',
      '\u0432\u043b\u0430\u0436\u043d\u043e\u0441\u0442\u044c \u0432\u043e\u0437\u0434\u0443\u0445\u0430': 'humidity',
      '\u0432\u043b\u0430\u0436\u043d\u043e\u0441\u0442\u044c': 'humidity',
      '\u0432\u043b\u0430\u0436\u043d\u043e\u0441\u0442\u044c \u0432 \u0437\u043e\u043d\u0435 \u043a\u043e\u0440\u043d\u0435\u0439': 'rootHumidity',
      co2: 'co2',
      '\u0443\u0433\u043b\u0435\u043a\u0438\u0441\u043b\u044b\u0439 \u0433\u0430\u0437': 'co2',
      '\u043a\u043e\u043d\u0446\u0435\u043d\u0442\u0440\u0430\u0446\u0438\u044f \u0443\u0433\u043b\u0435\u043a\u0438\u0441\u043b\u043e\u0433\u043e \u0433\u0430\u0437\u0430': 'co2',
      '\u043e\u0441\u0432\u0435\u0449\u0435\u043d\u043d\u043e\u0441\u0442\u044c': 'light',
      '\u043e\u0441\u0432\u0435\u0449\u0451\u043d\u043d\u043e\u0441\u0442\u044c': 'light',
      ec: 'ec',
      '\u0434\u0430\u0432\u043b\u0435\u043d\u0438\u0435': 'pressure',
    };

    // Нормализация названия параметра к внутреннему ключу.
    const normalizeKey = (name) => {
      const n = (name || '').toString().trim().toLowerCase();
      if (paramMap[n]) return paramMap[n];
      if (n.includes('\u0442\u0435\u043c\u043f\u0435\u0440\u0430\u0442')) return 'temperature';
      if (n.includes('\u0432\u043b\u0430\u0436\u043d\u043e\u0441\u0442\u044c \u0432 \u0437\u043e\u043d\u0435 \u043a\u043e\u0440\u043d\u0435\u0439') || n.includes('\u043a\u043e\u0440\u043d')) return 'rootHumidity';
      if (n.includes('\u0432\u043b\u0430\u0436\u043d')) return 'humidity';
      if (n.includes('co2') || n.includes('\u0443\u0433\u043b\u0435\u043a\u0438\u0441\u043b')) return 'co2';
      if (n.includes('\u043e\u0441\u0432\u0435\u0449')) return 'light';
      if (n === 'ec') return 'ec';
      if (n.includes('\u0434\u0430\u0432\u043b\u0435\u043d')) return 'pressure';
      return n;
    };

    const seriesMap = { temperature: [], humidity: [], co2: [], light: [], ec: [], pressure: [], rootHumidity: [] };
    // Преобразование даты измерения во временную метку.
    const toTs = (v) => {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.getTime();
    };
    asArray(measurements).forEach((m) => {
      const key = m.parameter_key || normalizeKey(m.parameter_name);
      if (!seriesMap[key]) return;
      const ts = toTs(m.ts || m.timestamp || m.time);
      if (ts == null) return;
      seriesMap[key].push({ ts, value: m.value ?? 0 });
    });

    const microKeys = ['temperature', 'humidity', 'co2', 'light'];
    const solutionKeys = ['ec', 'pressure', 'rootHumidity'];

    const ndviSeries =
      asArray(ndviRaw)
        ?.map((p) => {
          const ts = toTs(p.ts || p.timestamp || p.time);
          if (ts == null) return null;
          return { ts, value: p.value ?? p.ndvi ?? 0 };
        })
        .filter(Boolean) ?? [];

    const current = {};
    [...microKeys, ...solutionKeys, 'ndvi'].forEach((k) => {
      const source = k === 'ndvi' ? ndviSeries : seriesMap[k];
      current[k] = source?.at(-1)?.value ?? null;
    });

    const references = Object.entries(mockMeta).reduce((acc, [key, m]) => {
      acc[key] = m.ref;
      return acc;
    }, {});

    return {
      zone,
      sensors,
      references,
      current,
      series: {
        microclimate: microKeys.map((key) => ({
          key,
          label: mockMeta[key]?.label ?? key,
          unit: mockMeta[key]?.unit ?? '',
          data: seriesMap[key] ?? [],
        })),
        solution: solutionKeys.map((key) => ({
          key,
          label: mockMeta[key]?.label ?? key,
          unit: mockMeta[key]?.unit ?? '',
          data: seriesMap[key] ?? [],
        })),
        ndvi: ndviSeries,
      },
      errors: asArray(errors),
    };
  },

  // Получение списка датчиков.
  async getSensors(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('q', params.search);
    if (params.parameter) searchParams.set('parameter', params.parameter);
    const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const data = await request(`/api/sensors${query}`);
    return data;
  },

  // Получение списка исполнительных устройств.
  async getActuators() {
    const data = await request('/api/actuators');
    return data;
  },

  // Получение списка параметров системы.
  async getParameters() {
    const data = await request('/api/parameters');
    return data;
  },

  // Получение активного сотрудника.
  async getActiveEmployee() {
    const data = await request('/api/employee/active');
    return data;
  },

  // Получение уставок выбранного параметра.
  async getParameterReference(id) {
    const data = await request(`/api/parameters/${id}/reference`);
    return data;
  },

  // Обновление уставок выбранного параметра.
  async updateReference({ parameterId, min, max, employeeId }) {
    const data = await request('/api/reference', {
      method: 'POST',
      body: JSON.stringify({ parameterId, min_value: min, max_value: max, employeeId }),
    });
    return data;
  },

  // Управление включением отопления в температурном сценарии.
  async setTemperatureHeating({ on } = {}) {
    const data = await request('/api/sim/temperature/heating', {
      method: 'POST',
      body: JSON.stringify({ on }),
    });
    return data;
  },

  // Сброс температурного сценария.
  async resetTemperatureScenario() {
    const data = await request('/api/sim/temperature/reset', {
      method: 'POST',
    });
    return data;
  },

  // Включение или отключение температурного сценария.
  async setTemperatureScenarioActive({ active } = {}) {
    const data = await request('/api/sim/temperature/active', {
      method: 'POST',
      body: JSON.stringify({ active }),
    });
    return data;
  },

  // Получение состояния температурного сценария.
  async getTemperatureScenarioStatus() {
    const data = await request('/api/sim/temperature/status');
    return data;
  },

  // Авторизация сотрудника.
  async login({ firstName, lastName, password }) {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ firstName, lastName, password }),
    });
    return data;
  },

  // Получение журнала ошибок.
  async getErrors(params = {}) {
    const searchParams = new URLSearchParams();
    if (params.zoneId) searchParams.set('zoneId', params.zoneId);
    if (params.severity) searchParams.set('severity', params.severity);
    const query = searchParams.toString() ? `?${searchParams.toString()}` : '';
    const data = await request(`/api/errors${query}`);
    return data;
  },

  // Запуск принудительного полива одной зоны.
  async forceWatering(zoneId, payload = {}) {
    const data = await request(`/api/zones/${zoneId}/water/force`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return data;
  },

  // Запуск принудительного полива нескольких зон.
  async forceWateringBatch(zoneIds, payload = {}) {
    const data = await request(`/api/zones/water/force`, {
      method: 'POST',
      body: JSON.stringify({ zoneIds, ...payload }),
    });
    return data;
  },

  // Получение отчета по выбранному параметру.
  async getParameterReport(parameter) {
    const query = parameter ? `?parameter=${encodeURIComponent(parameter)}` : '';
    const data = await request(`/api/report${query}`);
    return data;
  },

  // Получение последних измерений.
  async getMeasurements() {
    const data = await request('/api/measurements');
    return data;
  },

  // Формирование сводного отчета по NDVI и ошибкам.
  async getReport({ fromHours = 168 } = {}) {
    const to = new Date();
    const from = new Date(to.getTime() - fromHours * 60 * 60 * 1000);
    const zones = asArray(await request('/api/zones'));
    const series = await Promise.all(
      zones.map(async (z) => {
        const ndviRaw = await request(
          `/api/zones/${z.id}/ndvi?limit=24&from=${from.toISOString()}&to=${to.toISOString()}`,
        );
        const ndvi = asArray(ndviRaw)
          .map((p) => {
            const ts = new Date(p.ts || p.timestamp || p.time).getTime();
            const value = Number(p.value ?? p.ndvi ?? 0);
            if (Number.isNaN(ts) || Number.isNaN(value)) return null;
            return { ts, value };
          })
          .filter(Boolean)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 24);
        const avgNdvi = ndvi.length ? ndvi.reduce((acc, n) => acc + n.value, 0) / ndvi.length : 0;
        const errors = asArray(await request(`/api/errors?zoneId=${z.id}&from=${from.toISOString()}&to=${to.toISOString()}`));
        return {
          zone: z.name ?? z.id,
          avgNdvi: +avgNdvi.toFixed(2),
          alerts: errors.length,
          critical: errors.filter((e) => (e.severity || e.status) === 'critical').length,
        };
      }),
    );
    return { fromHours, series };
  },
};

const mockApi = {
  meta: mockMeta,
  // Получение тестовых данных главной панели.
  async getDashboard() {
    return mock.getDashboard();
  },
  // Получение тестового списка зон.
  async getZones(params) {
    return mock.getZones(params);
  },
  // Получение тестовой подробной информации о зоне.
  async getZoneDetails(id, opts) {
    return mock.getZoneDetails(id, opts);
  },
  // Получение тестового списка датчиков.
  async getSensors(params) {
    return mock.getSensors(params);
  },
  // Получение тестового списка исполнительных устройств.
  async getActuators(params) {
    return mock.getActuators(params);
  },
  // Получение тестового списка параметров.
  async getParameters() {
    return mock.meta
      ? Object.entries(mock.meta).map(([id, m]) => ({ id, name: m.label, unit: m.unit }))
      : [];
  },

  // Получение тестового активного сотрудника.
  async getActiveEmployee() {
    return { id: 'mock-emp', name: 'Дежурный сотрудник' };
  },

  // Получение тестовых уставок параметра.
  async getParameterReference(id) {
    const meta = mockMeta[id];
    return {
      id,
      ref_min: meta?.ref?.[0] ?? 0,
      ref_max: meta?.ref?.[1] ?? 0,
      unit: meta?.unit ?? '',
    };
  },

  // Тестовое обновление уставок параметра.
  async updateReference({ parameterId, min, max }) {
    return { ok: true, parameterId, min_value: min, max_value: max };
  },
  // Тестовое управление отоплением.
  async setTemperatureHeating({ on } = {}) {
    return { ok: true, heating: on !== false };
  },
  // Тестовый сброс температурного сценария.
  async resetTemperatureScenario() {
    return { ok: true };
  },
  // Тестовое включение или отключение температурного сценария.
  async setTemperatureScenarioActive({ active } = {}) {
    return { ok: true, active: active !== false };
  },
  // Получение тестового состояния температурного сценария.
  async getTemperatureScenarioStatus() {
    return { active: true, phase: 'cooling' };
  },
  // Тестовая авторизация сотрудника.
  async login({ firstName, lastName }) {
    if (!firstName || !lastName) {
      throw new Error('Missing credentials');
    }
    return { id: 'mock-emp', name: `${firstName} ${lastName}`.trim() };
  },
  // Получение тестового журнала ошибок.
  async getErrors(params) {
    return mock.getErrors(params);
  },
  // Тестовый запуск принудительного полива одной зоны.
  async forceWatering() {
    return { ok: true, inserted: 0 };
  },
  // Тестовый запуск принудительного полива нескольких зон.
  async forceWateringBatch(zoneIds = []) {
    if (mock.forceWateringBatch) return mock.forceWateringBatch(zoneIds);
    return {
      ok: true,
      success: zoneIds.length,
      failed: 0,
      results: zoneIds.map((id) => ({ id, ok: true, runId: null, ndviRecovery: false })),
    };
  },
  // Получение тестового отчета по параметру.
  async getParameterReport(parameter) {
    return mock.getReport(parameter);
  },
  // Получение тестового сводного отчета.
  async getReport(params) {
    return mock.getReport(params);
  },
  // Получение тестовых последних измерений.
  async getMeasurements() {
    return [];
  },
};

const provider = useMock ? mockApi : realApi;
// Резервный переход на mock-данные при ошибке API.
const withMockFallback = (apiCall, mockCall, fallbackValue) =>
  Promise.resolve()
    .then(apiCall)
    .catch((err) => {
    console.error('API request failed', err);
    if (useMock) return mockCall();
    if (fallbackValue !== undefined) return fallbackValue;
    throw err;
  });

export const meta = mockMeta;
// Получение данных главной панели через выбранный источник.
export const getDashboard = (...args) =>
  withMockFallback(() => provider.getDashboard(...args), () => mock.getDashboard(...args));
// Получение зон через выбранный источник.
export const getZones = (...args) =>
  withMockFallback(() => provider.getZones(...args), () => mock.getZones(...args));
// Получение подробной информации о зоне через выбранный источник.
export const getZoneDetails = (...args) =>
  withMockFallback(() => provider.getZoneDetails(...args), () => mock.getZoneDetails(...args));
// Получение датчиков через выбранный источник.
export const getSensors = (...args) =>
  withMockFallback(() => provider.getSensors(...args), () => mock.getSensors(...args));
// Получение исполнительных устройств через выбранный источник.
export const getActuators = (...args) =>
  withMockFallback(() => provider.getActuators(...args), () => mock.getActuators(...args));
// Получение параметров через выбранный источник.
export const getParameters = (...args) =>
  withMockFallback(
    () => provider.getParameters(...args),
    () => (mock.meta ? Object.entries(mock.meta).map(([id, m]) => ({ id, name: m.label, unit: m.unit })) : []),
  );
// Получение активного сотрудника через выбранный источник.
export const getActiveEmployee = (...args) =>
  withMockFallback(() => provider.getActiveEmployee(...args), () => null, null);
// Получение уставок параметра через выбранный источник.
export const getParameterReference = (...args) =>
  withMockFallback(
    () => provider.getParameterReference(...args),
    () => ({ id: args?.[0], ref_min: null, ref_max: null, unit: '' }),
    { id: args?.[0], ref_min: null, ref_max: null, unit: '' },
  );
// Обновление уставок параметра через выбранный источник.
export const updateReference = (...args) =>
  withMockFallback(() => provider.updateReference(...args), () => ({ ok: false }), { ok: false });
// Управление отоплением через выбранный источник.
export const setTemperatureHeating = (...args) =>
  withMockFallback(
    () => provider.setTemperatureHeating(...args),
    () => (mock.setTemperatureHeating ? mock.setTemperatureHeating(...args) : { ok: false }),
    { ok: false },
  );
// Сброс температурного сценария через выбранный источник.
export const resetTemperatureScenario = (...args) =>
  withMockFallback(
    () => provider.resetTemperatureScenario(...args),
    () => (mock.resetTemperatureScenario ? mock.resetTemperatureScenario(...args) : { ok: false }),
    { ok: false },
  );
// Управление активностью температурного сценария через выбранный источник.
export const setTemperatureScenarioActive = (...args) =>
  withMockFallback(
    () => provider.setTemperatureScenarioActive(...args),
    () => (mock.setTemperatureScenarioActive ? mock.setTemperatureScenarioActive(...args) : { ok: false }),
    { ok: false },
  );
// Получение состояния температурного сценария через выбранный источник.
export const getTemperatureScenarioStatus = (...args) =>
  withMockFallback(
    () => provider.getTemperatureScenarioStatus(...args),
    () => (mock.getTemperatureScenarioStatus ? mock.getTemperatureScenarioStatus(...args) : { active: true }),
    { active: false },
  );
// Авторизация через выбранный источник.
export const login = (...args) => provider.login(...args);
// Получение ошибок через выбранный источник.
export const getErrors = (...args) =>
  withMockFallback(() => provider.getErrors(...args), () => mock.getErrors(...args), []);
// Запуск полива одной зоны через выбранный источник.
export const forceWatering = (...args) => provider.forceWatering(...args);
// Запуск полива нескольких зон через выбранный источник.
export const forceWateringBatch = (...args) => provider.forceWateringBatch(...args);
// Получение отчета по параметру через выбранный источник.
export const getParameterReport = (...args) =>
  withMockFallback(
    () => provider.getParameterReport(...args),
    () => ({ parameter: args?.[0] ?? null, name: args?.[0] ?? null, series: [], last10: [], stats: { count: 0, min: null, max: null, avg: null } }),
    { parameter: args?.[0] ?? null, name: args?.[0] ?? null, series: [], last10: [], stats: { count: 0, min: null, max: null, avg: null } },
  );
// Получение сводного отчета через выбранный источник.
export const getReport = (...args) =>
  withMockFallback(() => provider.getReport(...args), () => mock.getReport(...args));
// Получение дневных данных NDVI через выбранный источник.
export const getNdviDaily = (...args) =>
  withMockFallback(
    () => (provider.getNdviDaily ? provider.getNdviDaily(...args) : provider.getReport(...args)),
    () => mock.getReport(...args),
  );
// Получение измерений через выбранный источник.
export const getMeasurements = (...args) =>
  withMockFallback(() => provider.getMeasurements(...args), () => [], []);

import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import crypto from 'crypto';
import http from 'http';
import { WebSocketServer } from 'ws';

dotenv.config();

const {
  DB_HOST = 'localhost',
  DB_PORT = 3306,
  DB_USER = 'root',
  DB_PASS = '',
  DB_NAME = 'plants',
  DB_TZ = '+03:00',
  PORT = 3000,
} = process.env;

// Создание пула подключений к базе данных MySQL.
function createPool() {
  return mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    timezone: DB_TZ,
    waitForConnections: true,
    connectionLimit: 10,
  });
}

const poolPromise = createPool();

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Вспомогательные функции
// Получение списка колонок указанной таблицы.
async function getColumns(pool, table) {
  try {
    const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
    return cols.map((c) => c.Field);
  } catch (e) {
    return [];
  }
}

// Удаление лишних пробелов в строке.
const normalizeSpace = (value) => String(value || '').trim().replace(/\s+/g, ' ');

// Создание карты колонок для поиска без учета регистра.
const buildColumnMap = (cols) => {
  const map = new Map();
  cols.forEach((c) => map.set(c.toLowerCase(), c));
  return map;
};

// Выбор первой подходящей колонки из списка возможных названий.
const pickColumn = (map, candidates) => candidates.map((c) => map.get(c)).find(Boolean);

// Выбор всех найденных колонок из списка возможных названий.
const pickColumns = (map, candidates) => candidates.map((c) => map.get(c)).filter(Boolean);

// Поиск колонки таблицы sensors, в которой хранится зона датчика.
async function resolveSensorZoneColumn(pool) {
  const cols = await getColumns(pool, 'sensors');
  if (!cols.length) return null;
  const map = buildColumnMap(cols);
  return pickColumn(map, ['id_zone', 'zone_id', 'id_zones', 'zone']);
}

// Проверка пароля пользователя: обычный текст или scrypt-хеш.
const verifyPassword = (password, stored) => {
  const raw = String(stored || '');
  if (!raw) return false;
  if (raw.startsWith('scrypt$')) {
    const parts = raw.split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const expected = parts[2];
    if (!salt || !expected) return false;
    if (!/^[0-9a-f]+$/i.test(expected) || expected.length % 2 !== 0) return false;
    const derived = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(derived, 'hex'));
  }
  return raw === String(password || '');
};

// Запись действия оператора в журнал actions_log.
async function logAction(pool, { employeeId, parameterId, actionText }) {
  const cols = await getColumns(pool, 'actions_log');
  if (!cols.length) return;
  const empCol = cols.find((c) => ['id_employee', 'employee_id', 'id_user', 'user_id'].includes(c));
  const paramCol = cols.find((c) => ['id_parameter', 'parameter_id'].includes(c));
  const tsCol = cols.find((c) => ['timestamp', 'created_at', 'ts', 'time'].includes(c));
  const actionCol = cols.find((c) => ['action', 'event', 'description'].includes(c));
  const fields = [];
  const values = [];
  if (empCol) {
    fields.push(empCol);
    values.push(employeeId ?? null);
  }
  if (paramCol) {
    fields.push(paramCol);
    values.push(parameterId ?? null);
  }
  if (actionCol) {
    fields.push(actionCol);
    values.push(actionText ?? 'Изменение параметра');
  }
  if (tsCol) {
    fields.push(tsCol);
    values.push(new Date());
  }
  if (!fields.length) return;
  const placeholders = fields.map(() => '?').join(',');
  const sql = `INSERT INTO actions_log (${fields.join(',')}) VALUES (${placeholders})`;
  try {
    await pool.query(sql, values);
  } catch (e) {
    console.error('actions_log insert error', e);
  }
}

// Запись важного действия пользователя в audit_log.
async function logAudit(pool, { employeeId, action }) {
  const cols = await getColumns(pool, 'audit_log');
  if (!cols.length) return;
  const empCol = cols.find((c) => ['id_employee', 'employee_id', 'id_user', 'user_id'].includes(c));
  const actionCol = cols.find((c) => ['action', 'event', 'description'].includes(c));
  const tsCol = cols.find((c) => ['timestamp', 'created_at', 'ts', 'time'].includes(c));
  const fields = [];
  const values = [];
  if (empCol) {
    fields.push(empCol);
    values.push(employeeId ?? null);
  }
  if (actionCol) {
    fields.push(actionCol);
    values.push(action ?? 'Изменение параметра');
  }
  if (tsCol) {
    fields.push(tsCol);
    values.push(new Date());
  }
  if (!fields.length) return;
  const placeholders = fields.map(() => '?').join(',');
  const sql = `INSERT INTO audit_log (${fields.join(',')}) VALUES (${placeholders})`;
  try {
    await pool.query(sql, values);
  } catch (e) {
    console.error('audit_log insert error', e);
  }
}

// Запуск восстановления влажности после изменения уставки температуры.
async function startHumidityRecoveryAfterTemperatureReferenceUpdate(pool, parameterId) {
  if (Number(parameterId) !== 1) return;
  try {
    await pool.query(
      `UPDATE scenario_state
       SET text_value = 'recovering',
           updated_at = CURRENT_TIMESTAMP
       WHERE scenario_key = 'humidity_temperature_correction'
         AND COALESCE(numeric_value, 0) > 80`,
    );
  } catch (e) {
    if (e?.code !== 'ER_NO_SUCH_TABLE') {
      console.error('humidity recovery state update error', e);
    }
  }
}

// Преобразование значения в число или null.
const toNumber = (value) => {
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
};

// Формирование уникального ключа измерения по датчику и времени.
const measurementKey = (sensorId, ts) => {
  const time = new Date(ts).getTime();
  if (!sensorId || Number.isNaN(time)) return null;
  return `${sensorId}:${time}`;
};

// Определение уровня отклонения параметра от допустимого диапазона.
const getDeviationSeverity = (value, refMin, refMax) => {
  const val = toNumber(value);
  const min = toNumber(refMin);
  const max = toNumber(refMax);
  if (val === null || min === null || max === null) return null;
  if (val >= min && val <= max) return null;
  const delta = val < min ? min - val : val - max;
  const range = max - min;
  const threshold = Math.max(range * 0.05, 2);
  return delta <= threshold ? 'warning' : 'critical';
};

// Распознавание известных кодов предупреждений по CO2 и влажности.
const knownAlertByCode = (code) => {
  const normalized = String(code || '').toLowerCase();
  if (normalized.includes('co2')) {
    if (normalized.includes('alarm')) return { parameterId: 3, severity: 'critical' };
    if (normalized.includes('warning')) return { parameterId: 3, severity: 'warning' };
  }
  if (normalized.includes('hum')) {
    if (normalized.includes('alarm')) return { parameterId: 2, severity: 'critical' };
    if (normalized.includes('warning')) return { parameterId: 2, severity: 'warning' };
  }
  return null;
};

// Определение идентификатора параметра по коду ошибки.
const parameterIdFromErrorCode = (code) => {
  const known = knownAlertByCode(code);
  if (known?.parameterId) return known.parameterId;
  const match = String(code || '').match(/^OUT-(\d+)$/i);
  return match ? Number(match[1]) : null;
};

// Преобразование даты в формат, подходящий для SQL-запросов.
const formatSqlDate = (d) => {
  // Добавление ведущего нуля к числам даты и времени.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
};

// Загрузка последних измерений параметра отдельно по каждой зоне.
async function fetchPerZoneMeasurements(pool, { paramId, perZoneLimit = 20, maxRows = 2000 }) {
  if (!paramId) return [];
  let zoneCount = 0;
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM zones');
    zoneCount = Number(rows?.[0]?.cnt || 0);
  } catch {
    zoneCount = 0;
  }
  const sensorZoneCol = await resolveSensorZoneColumn(pool);
  const sensorZoneExpr = sensorZoneCol ? `s.${sensorZoneCol}` : 'NULL';
  const zoneExpr = sensorZoneCol ? `COALESCE(m.id_zone, ${sensorZoneExpr})` : 'm.id_zone';
  const limit = Math.min(
    maxRows,
    Math.max(perZoneLimit * Math.max(zoneCount, 1), perZoneLimit * 4),
  );
  // Сборка запроса измерений по таблице с учетом зоны датчика.
  const buildQuery = (table) => `SELECT m.timestamp AS ts,
              m.value,
              p.name_parameter AS name,
              u.unit_name AS unit,
              ${zoneExpr} AS zone_id,
              z.zone_name AS zone_name
       FROM ${table} m
       LEFT JOIN parameters p ON p.id_parameter = m.id_parameter
       LEFT JOIN sensors s ON s.id_sensor = m.id_sensors
       LEFT JOIN units u ON u.id_unit = s.id_units
       LEFT JOIN zones z ON z.id_zone = ${zoneExpr}
       WHERE m.id_parameter = ?
       ORDER BY m.timestamp DESC
       LIMIT ${limit}`;
  let rows = [];
  try {
    [rows] = await pool.query(buildQuery('sensors_measurements'), [paramId]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      try {
        [rows] = await pool.query(buildQuery('sensor_measurements'), [paramId]);
      } catch {
        rows = [];
      }
    } else {
      throw e;
    }
  }
  if (!rows.length) return [];
  const byZone = new Map();
  rows.forEach((row) => {
    const zoneId = row.zone_id ?? null;
    if (zoneId == null) return;
    const list = byZone.get(zoneId) || [];
    if (list.length >= perZoneLimit) return;
    list.push(row);
    byZone.set(zoneId, list);
  });
  const flat = Array.from(byZone.values()).flat();
  flat.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return flat;
}

// Получение зон, которые относятся к выбранной технологии выращивания.
async function fetchZonesByTechnology(pool, techId) {
  // Сборка запроса зон для разных вариантов названия колонки технологии.
  const buildSql = (techCol) =>
    `SELECT id_zone AS id, zone_name AS name
     FROM zones
     WHERE ${techCol} = ?`;
  let rows;
  try {
    [rows] = await pool.query(buildSql('id_technolog'), [techId]);
  } catch (e) {
    if (e?.code === 'ER_BAD_FIELD_ERROR') {
      try {
        [rows] = await pool.query(buildSql('id_tehnolog'), [techId]);
      } catch (inner) {
        if (inner?.code === 'ER_BAD_FIELD_ERROR') {
          [rows] = await pool.query(buildSql('id_technology'), [techId]);
        } else {
          throw inner;
        }
      }
    } else {
      throw e;
    }
  }
  return Array.isArray(rows) ? rows : [];
}

// Получение одной зоны по ее идентификатору.
async function fetchZoneById(pool, id) {
  // Сборка запроса одной зоны для разных вариантов названия колонки технологии.
  const buildSql = (techCol) =>
    `SELECT id_zone AS id, zone_name AS name, ${techCol} AS technology
     FROM zones
     WHERE id_zone = ?
     LIMIT 1`;
  let rows;
  try {
    [rows] = await pool.query(buildSql('id_technolog'), [id]);
  } catch (e) {
    if (e?.code === 'ER_BAD_FIELD_ERROR') {
      try {
        [rows] = await pool.query(buildSql('id_tehnolog'), [id]);
      } catch (inner) {
        if (inner?.code === 'ER_BAD_FIELD_ERROR') {
          [rows] = await pool.query(buildSql('id_technology'), [id]);
        } else {
          throw inner;
        }
      }
    } else {
      throw e;
    }
  }
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

// Поиск общего временного интервала с данными по всем выбранным зонам.
async function getCommonWindowByZones(pool, { paramId, zoneIds, points }) {
  if (!paramId || !Array.isArray(zoneIds) || !zoneIds.length) return null;
  const placeholders = buildInList(zoneIds);
  const query = `SELECT id_zone, MAX(timestamp) AS max_ts
                 FROM sensors_measurements
                 WHERE id_parameter = ? AND id_zone IN (${placeholders})
                 GROUP BY id_zone`;
  let rows = [];
  try {
    [rows] = await pool.query(query, [paramId, ...zoneIds]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      [rows] = await pool.query(fallback, [paramId, ...zoneIds]);
    } else {
      throw e;
    }
  }
  if (!rows.length || rows.length < zoneIds.length) return null;
  const maxTimes = rows
    .map((r) => new Date(r.max_ts).getTime())
    .filter((t) => Number.isFinite(t));
  if (maxTimes.length < zoneIds.length) return null;
  const minOfMax = Math.min(...maxTimes);
  const minuteMs = 60 * 1000;
  const end = new Date(minOfMax);
  const start = new Date(minOfMax - (points - 1) * minuteMs);
  return { start, end };
}

// Загрузка минутного ряда данных для графиков гидропонной технологии.
async function fetchHydroPerMinuteSeries(pool, { paramId, window }) {
  if (!paramId) return [];
  const minuteMs = 60 * 1000;
  const points = HYDRO_SAMPLE_COUNT;

  const sensorZoneCol = await resolveSensorZoneColumn(pool);
  const sensorZoneExpr = sensorZoneCol ? `s.${sensorZoneCol}` : 'NULL';
  const zoneExpr = sensorZoneCol ? `COALESCE(m.id_zone, ${sensorZoneExpr})` : 'm.id_zone';

  // Сборка запроса измерений для минутного графика.
  const buildQuery = (table) => `SELECT m.timestamp AS ts,
              m.value,
              ${zoneExpr} AS zone_id,
              z.zone_name AS zone_name
       FROM ${table} m
       LEFT JOIN sensors s ON s.id_sensor = m.id_sensors
       LEFT JOIN zones z ON z.id_zone = ${zoneExpr}
       WHERE m.id_parameter = ?
         AND m.timestamp BETWEEN ? AND ?
       ORDER BY m.timestamp ASC`;

  let zoneRows = [];
  try {
    zoneRows = await fetchZonesByTechnology(pool, 1);
  } catch {
    zoneRows = [];
  }
  if (!zoneRows.length) {
    zoneRows = [];
  }

  const zoneIds = zoneRows.map((z) => z.id).filter((id) => id != null);
  let effectiveWindow = window ?? null;
  if (zoneIds.length) {
    const common = await getCommonWindowByZones(pool, { paramId, zoneIds, points });
    if (common) effectiveWindow = common;
  }

  let startMs = effectiveWindow?.start ? new Date(effectiveWindow.start).getTime() : NaN;
  let endMs = effectiveWindow?.end ? new Date(effectiveWindow.end).getTime() : NaN;
  if (Number.isNaN(endMs)) endMs = Date.now();
  if (Number.isNaN(startMs)) startMs = endMs - (points - 1) * minuteMs;
  const buckets = Array.from({ length: points }, (_, i) => startMs + i * minuteMs);

  const queryStart = effectiveWindow?.start ?? new Date(startMs);
  const queryEnd = effectiveWindow?.end ?? new Date(startMs + points * minuteMs - 1);

  let rows = [];
  try {
    [rows] = await pool.query(buildQuery('sensors_measurements'), [paramId, queryStart, queryEnd]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      [rows] = await pool.query(buildQuery('sensor_measurements'), [paramId, queryStart, queryEnd]);
    } else {
      throw e;
    }
  }
  if (!rows.length) {
    try {
      [rows] = await pool.query(buildQuery('sensor_measurements'), [paramId, queryStart, queryEnd]);
    } catch {
      rows = [];
    }
  }

  if (!zoneRows.length && rows.length) {
    const map = new Map();
    rows.forEach((r) => {
      if (r.zone_id == null) return;
      if (!map.has(r.zone_id)) {
        map.set(r.zone_id, r.zone_name || `Зона ${r.zone_id}`);
      }
    });
    zoneRows = Array.from(map, ([id, name]) => ({ id, name }));
  }

  const zoneNameMap = new Map(zoneRows.map((z) => [z.id, z.name]));
  rows.forEach((r) => {
    if (r.zone_id == null || !r.zone_name) return;
    if (!zoneNameMap.has(r.zone_id)) zoneNameMap.set(r.zone_id, r.zone_name);
  });

  const byZone = new Map();
  rows.forEach((r) => {
    const zoneId = r.zone_id ?? null;
    if (zoneId == null) return;
    const tsMs = new Date(r.ts).getTime();
    if (Number.isNaN(tsMs)) return;
    const idx = Math.floor((tsMs - startMs) / minuteMs);
    if (idx < 0 || idx >= points) return;
    const bucketTs = startMs + idx * minuteMs;
    const zoneBuckets = byZone.get(zoneId) || new Map();
    const bucket = zoneBuckets.get(bucketTs) || { sum: 0, count: 0 };
    const value = Number(r.value);
    if (Number.isNaN(value)) return;
    bucket.sum += value;
    bucket.count += 1;
    zoneBuckets.set(bucketTs, bucket);
    byZone.set(zoneId, zoneBuckets);
  });

  const series = [];
  zoneRows.forEach((zone) => {
    const zoneId = zone.id;
    const zoneBuckets = byZone.get(zoneId) || new Map();
    const valuesByTs = new Map();
    zoneBuckets.forEach((bucket, ts) => {
      if (!bucket.count) return;
      valuesByTs.set(ts, +(bucket.sum / bucket.count).toFixed(2));
    });

    let firstValue;
    for (const ts of buckets) {
      if (valuesByTs.has(ts)) {
        firstValue = valuesByTs.get(ts);
        break;
      }
    }
    let lastValue = null;
    buckets.forEach((ts) => {
      let value;
      if (valuesByTs.has(ts)) {
        value = valuesByTs.get(ts);
        lastValue = value;
      } else if (lastValue != null) {
        value = lastValue;
      } else if (firstValue != null) {
        value = firstValue;
      } else {
        value = undefined;
      }
      series.push({
        ts,
        value,
        zone_id: zoneId,
        zone_name: zoneNameMap.get(zoneId) || zone.name || `Зона ${zoneId}`,
      });
    });
  });

  return series;
}

// Формирование снимка главной панели: текущие параметры и активные ошибки.
async function buildDashboardSnapshot(pool) {
  const aggregates = { temperature: null, humidity: null, co2: null };
  let errors = [];
  let updatedAt = Date.now();

  const paramIds = { temperature: 1, humidity: 2, co2: 3 };

  // Загрузка последних значений температуры, влажности и CO2.
  const fetchLatest = async () => {
    try {
      const [rows] = await pool.query(
        `SELECT id_parameter, value, timestamp, sensor_id
         FROM (
           SELECT m.id_parameter,
                  m.value,
                  m.timestamp,
                  m.id_sensors AS sensor_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY m.id_parameter
                    ORDER BY m.timestamp DESC, m.id_measurements DESC
                  ) AS rn
           FROM sensors_measurements m
           WHERE m.id_parameter IN (1, 2, 3)
             AND m.timestamp >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         ) latest
         WHERE rn = 1
         ORDER BY timestamp DESC`,
      );
      return rows;
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        try {
          const [rows] = await pool.query(
            `SELECT id_parameter, value, timestamp, sensor_id
             FROM (
               SELECT m.id_parameter,
                      m.value,
                      m.timestamp,
                      m.id_sensors AS sensor_id,
                      ROW_NUMBER() OVER (
                        PARTITION BY m.id_parameter
                        ORDER BY m.timestamp DESC
                      ) AS rn
               FROM sensor_measurements m
               WHERE m.id_parameter IN (1, 2, 3)
                 AND m.timestamp >= DATE_SUB(NOW(), INTERVAL 5 MINUTE)
             ) latest
             WHERE rn = 1
             ORDER BY timestamp DESC`,
          );
          return rows;
        } catch {
          return [];
        }
      }
      return [];
    }
  };

  const latest = await fetchLatest();
  if (latest?.[0]?.timestamp) {
    const ts = new Date(latest[0].timestamp).getTime();
    if (!Number.isNaN(ts)) updatedAt = ts;
  }
  const seen = new Set();
  const scenarioKeys = tempScenario.sampleKeys && tempScenario.sampleKeys.size ? tempScenario.sampleKeys : null;
  for (const row of latest) {
    const pid = Number(row.id_parameter);
    if (seen.has(pid)) continue;
    if (pid === paramIds.temperature) {
      if (tempScenario.active && scenarioKeys) {
        const key = measurementKey(row.sensor_id, row.timestamp);
        if (!key || !scenarioKeys.has(key)) {
          continue;
        }
      }
      aggregates.temperature = row.value;
    }
    else if (pid === paramIds.humidity) aggregates.humidity = row.value;
    else if (pid === paramIds.co2) aggregates.co2 = row.value;
    seen.add(pid);
    if (seen.size === 3) break;
  }
  if (tempScenario.active && Number.isFinite(tempScenario.value)) {
    aggregates.temperature = tempScenario.value;
  }

  try {
    const [errRows] = await pool.query(
      `SELECT id_sensor_error AS id,
              timestamp AS ts,
              error_code AS code,
              error_name AS text,
              id_sensor_number AS sensorId,
              'warning' AS severity
       FROM sensor_error
       ORDER BY timestamp DESC
       LIMIT 100`,
    );
    errors = errRows;
  } catch {
    errors = [];
  }

  return { aggregates, errors, updatedAt };
}

const AIR_TEMP_PARAM_ID = 1;
const AIR_TEMP_CRITICAL = 10;
const AIR_TEMP_DEFAULT_START = 21;
const AIR_TEMP_DEFAULT_NORMAL = 22;
const AIR_TEMP_RANGE_MIN = 22;
const AIR_TEMP_RANGE_MAX = 25;
const AIR_TEMP_SAMPLE_SECONDS = 2;
const AIR_TEMP_CHANGE_SECONDS = 30;
const AIR_TEMP_STEP_VALUE = 0.5;
const AIR_TEMP_HEATING_TARGET = 22;
const REPORT_AIR_TEMP_AGG_MS = 30000;
const REPORT_AIR_HUMID_AGG_MS = 30000;
const REPORT_CO2_AGG_MS = 30000;
const AIR_TEMP_COOLING_MINUTES = 60;
const AIR_TEMP_HEATING_MINUTES = 20;

const HYDRO_PARAM_IDS = [];
const AERO_PARAM_IDS = [];
const NDVI_PARAM_IDS = [10, 11];
const HYDRO_PARAM_MAP = {};
const AERO_PARAM_MAP = {};
const ZONE_PARAM_IDS = [...new Set([...HYDRO_PARAM_IDS, ...AERO_PARAM_IDS])];
const NDVI_PARAM_BY_TECH = { 1: 10, 2: 11 };
const HYDRO_WINDOW_SECONDS = 600;
const AERO_WINDOW_SECONDS = 10;
const HYDRO_SAMPLE_SECONDS = 60;
const HYDRO_SAMPLE_COUNT = Math.max(1, Math.round(HYDRO_WINDOW_SECONDS / HYDRO_SAMPLE_SECONDS));
const HYDRO_A2_NDVI_ZONE_CODE = 'a2';
const HYDRO_A2_NDVI_START = 0.62;
const HYDRO_A2_NDVI_END = 0.45;
const HYDRO_A2_NDVI_POINTS = 24;
const HYDRO_A2_NDVI_WARNING_CODE = 'OUT-10';
const HYDRO_STABLE_NDVI_POINTS = 24;
const HYDRO_VARIED_NDVI_ZONE_CODES = new Set(['a1', 'a3', 'a4']);
const HYDRO_NDVI_RECOVERY_POINTS = 24;
const HYDRO_NDVI_RECOVERY_TARGET = 0.62;
const AERO_NDVI_POINTS = 24;
const NDVI_NORMAL_MIN = 0.5;
const NDVI_NORMAL_MAX = 0.75;
const HOUR_MS = 60 * 60 * 1000;

// Создание списка плейсхолдеров для SQL-оператора IN.
const buildInList = (arr) => arr.map(() => '?').join(',');

// Поиск колонки sensors, в которой хранится параметр датчика.
async function resolveSensorParamColumn(pool) {
  const cols = await getColumns(pool, 'sensors');
  if (!cols.length) return null;
  const map = buildColumnMap(cols);
  return pickColumn(map, ['id_parameterss', 'id_parameter', 'id_parameters', 'parameter_id']);
}

// Получение случайного числа в заданном диапазоне.
const rand = (min, max) => Math.random() * (max - min) + min;
// Ограничение числа минимальным и максимальным значением.
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Расчет следующего обычного значения NDVI.
const nextNdviValue = (lastValue) => {
  const base = Number.isFinite(lastValue) ? lastValue : rand(0.6, 0.72);
  const drift = rand(-0.02, 0.02);
  return +clamp(base + drift, NDVI_NORMAL_MIN, NDVI_NORMAL_MAX).toFixed(3);
};

// Создание числового хеша строки для стабильной генерации данных.
const hashText = (value) =>
  String(value || '')
    .split('')
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 9973, 17);

// Приведение названия зоны к короткому коду без лишних символов.
const normalizeZoneCode = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[а]/g, 'a')
    .replace(/[^a-z0-9]/g, '');

// Получение кода гидропонной зоны, например a2.
const getHydroZoneCode = (zone) => normalizeZoneCode(zone?.name).match(/a\d+/)?.[0] || '';

// Проверка необходимости более изменчивого графика NDVI для зоны.
const isVariedHydroNdviZone = (zone) => HYDRO_VARIED_NDVI_ZONE_CODES.has(getHydroZoneCode(zone));

// Получение кода аэропонной зоны, например b1.
const getAeroZoneCode = (zone) => normalizeZoneCode(zone?.name).match(/b\d+/)?.[0] || '';

// Расчет значения NDVI для сценария снижения в зоне A2.
const hydroA2ScenarioValue = (index, total = HYDRO_A2_NDVI_POINTS) => {
  const ratio = total <= 1 ? 1 : index / (total - 1);
  const value = HYDRO_A2_NDVI_START - (HYDRO_A2_NDVI_START - HYDRO_A2_NDVI_END) * ratio;
  return +value.toFixed(3);
};

// Определение базового уровня NDVI для гидропонной зоны.
const stableHydroNdviBaseline = (zone) => {
  const code = getHydroZoneCode(zone);
  const match = code.match(/a(\d+)/);
  if (match) {
    const index = Math.max(0, Number(match[1]) - 1);
    return clamp(0.62 + index * 0.025, 0.6, 0.7);
  }
  const seed = hashText(`${zone?.id ?? ''}:${zone?.name ?? ''}`);
  return 0.62 + (seed % 4) * 0.025;
};

// Создание повторяемого небольшого отклонения для графиков.
const deterministicNoise = (seed, step) => {
  const value = Math.sin((step + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
};

// Расчет изменчивого значения NDVI для отдельных гидропонных зон.
const variedHydroNdviValue = (zone, index, endHourMs, total = HYDRO_STABLE_NDVI_POINTS) => {
  const seed = hashText(`${zone?.id ?? ''}:${zone?.name ?? ''}`);
  const hour = Math.floor(endHourMs / HOUR_MS);
  const step = hour - (total - 1 - index);
  const baseline = stableHydroNdviBaseline(zone);
  const progress = total <= 1 ? 0 : index / (total - 1);
  const trendDirection = seed % 2 === 0 ? 1 : -1;
  const trend = (progress - 0.5) * 0.018 * trendDirection;
  const slowWave = Math.sin((step + seed) / 4.2) * 0.018;
  const mediumWave = Math.sin((step * 1.7 + seed) / 2.6) * 0.012;
  const ripple = Math.sin(step * 2.35 + seed / 13) * 0.005;
  const noise = (deterministicNoise(seed, step) - 0.5) * 0.012;
  const pulse = Math.max(0, Math.sin((step + seed) / 1.9)) ** 8 * -0.014;
  return +clamp(
    clamp(
      baseline + trend + slowWave + mediumWave + ripple + noise + pulse,
      baseline - 0.055,
      baseline + 0.05,
    ),
    NDVI_NORMAL_MIN,
    NDVI_NORMAL_MAX,
  ).toFixed(3);
};

// Расчет обычного стабильного значения NDVI для гидропоники.
const stableHydroNdviValue = (zone, index, endHourMs, total = HYDRO_STABLE_NDVI_POINTS) => {
  if (isVariedHydroNdviZone(zone)) {
    return variedHydroNdviValue(zone, index, endHourMs, total);
  }
  const seed = hashText(`${zone?.id ?? ''}:${zone?.name ?? ''}`);
  const hour = Math.floor(endHourMs / HOUR_MS);
  const step = hour - (total - 1 - index);
  const baseline = stableHydroNdviBaseline(zone);
  const progress = total <= 1 ? 0 : index / (total - 1);
  const trendDirection = seed % 2 === 0 ? 1 : -1;
  const trend = (progress - 0.5) * 0.012 * trendDirection;
  const slowWave = Math.sin((step + seed) / 7) * 0.006;
  const tinyWave = Math.sin((step + seed * 3) / 3.5) * 0.002;
  return +clamp(
    clamp(baseline + trend + slowWave + tinyWave, baseline - 0.015, baseline + 0.015),
    NDVI_NORMAL_MIN,
    NDVI_NORMAL_MAX,
  ).toFixed(3);
};

// Определение базового уровня NDVI для аэропонной зоны.
const aeroNdviBaseline = (zone) => {
  const code = getAeroZoneCode(zone);
  const match = code.match(/b(\d+)/);
  if (match) {
    const index = Math.max(0, Number(match[1]) - 1);
    return clamp(0.64 + index * 0.02, 0.62, 0.7);
  }
  const seed = hashText(`${zone?.id ?? ''}:${zone?.name ?? ''}`);
  return 0.64 + (seed % 5) * 0.015;
};

// Расчет значения NDVI для аэропонной технологии.
const aeroNdviValue = (zone, index, endHourMs, total = AERO_NDVI_POINTS) => {
  const seed = hashText(`${zone?.id ?? ''}:${zone?.name ?? ''}:aero`);
  const hour = Math.floor(endHourMs / HOUR_MS);
  const step = hour - (total - 1 - index);
  const baseline = aeroNdviBaseline(zone);
  const progress = total <= 1 ? 0 : index / (total - 1);
  const trendDirection = seed % 2 === 0 ? 1 : -1;
  const trend = (progress - 0.5) * 0.012 * trendDirection;
  const slowWave = Math.sin((step + seed) / 5.8) * 0.023;
  const mediumWave = Math.sin((step * 1.25 + seed / 3) / 3.4) * 0.01;
  const noise = (deterministicNoise(seed, step) - 0.5) * 0.007;
  const dip = Math.max(0, Math.sin((step + seed / 11) / 2.7)) ** 6 * -0.018;
  return +clamp(
    clamp(
      baseline + trend + slowWave + mediumWave + noise + dip,
      baseline - 0.05,
      baseline + 0.045,
    ),
    NDVI_NORMAL_MIN,
    NDVI_NORMAL_MAX,
  ).toFixed(3);
};

// Поиск гидропонной зоны A2.
async function findHydroA2Zone(pool) {
  const hydroZones = await fetchZonesByTechnology(pool, 1);
  return (
    hydroZones.find((z) => normalizeZoneCode(z.name).includes(HYDRO_A2_NDVI_ZONE_CODE)) ||
    null
  );
}

// Поиск датчика, который измеряет выбранный параметр.
async function resolveSensorIdByParam(pool, paramId) {
  const sensorParamCol = await resolveSensorParamColumn(pool);
  if (!sensorParamCol) return null;
  const [rows] = await pool.query(
    `SELECT id_sensor AS id FROM sensors WHERE ${sensorParamCol} = ? ORDER BY id_sensor LIMIT 1`,
    [paramId],
  );
  return rows?.[0]?.id ?? null;
}

// Удаление старых измерений параметра за указанный интервал.
async function deleteMeasurementRange(pool, { paramId, zoneId, start, end }) {
  const query = `DELETE FROM sensors_measurements
                 WHERE id_parameter = ? AND id_zone = ? AND timestamp BETWEEN ? AND ?`;
  try {
    await pool.query(query, [paramId, zoneId, start, end]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      await pool.query(fallback, [paramId, zoneId, start, end]);
    } else {
      throw e;
    }
  }
}

// Добавление измерения, созданного учебным сценарием.
async function insertScenarioMeasurement(pool, { sensorId, paramId, zoneId, value, ts }) {
  const query = `INSERT INTO sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, timestamp)
                 VALUES (?, ?, ?, ?, NULL, ?)`;
  try {
    await pool.query(query, [sensorId, paramId, value, zoneId, ts]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      await pool.query(fallback, [sensorId, paramId, value, zoneId, ts]);
    } else {
      throw e;
    }
  }
}

// Удаление старых значений NDVI по зоне за указанный интервал.
async function deleteNdviRange(pool, { zoneId, start, end }) {
  const cols = await getColumns(pool, 'ndvi');
  if (!cols.length) return;
  const map = buildColumnMap(cols);
  const zoneCol = pickColumn(map, ['id_zone', 'zone_id', 'id_zones']);
  const tsCol = pickColumn(map, ['timestamp', 'ts', 'time', 'created_at']);
  if (!zoneCol || !tsCol) return;
  try {
    await pool.query(
      `DELETE FROM ndvi WHERE ${zoneCol} = ? AND ${tsCol} BETWEEN ? AND ?`,
      [zoneId, start, end],
    );
  } catch (e) {
    console.error('delete ndvi range error', e);
  }
}

// Добавление точки NDVI в отдельную таблицу ndvi.
async function insertNdviPoint(pool, { zoneId, value, ts }) {
  const cols = await getColumns(pool, 'ndvi');
  if (!cols.length) return;
  const map = buildColumnMap(cols);
  const zoneCol = pickColumn(map, ['id_zone', 'zone_id', 'id_zones']);
  const valueCol = pickColumn(map, ['ndvi_value', 'value', 'ndvi']);
  const tsCol = pickColumn(map, ['timestamp', 'ts', 'time', 'created_at']);
  if (!zoneCol || !valueCol || !tsCol) return;
  try {
    await pool.query(
      `INSERT INTO ndvi (${zoneCol}, ${valueCol}, ${tsCol}) VALUES (?, ?, ?)`,
      [zoneId, value, ts],
    );
  } catch (e) {
    console.error('insert ndvi point error', e);
  }
}

// Получение последнего известного значения NDVI для зоны.
async function getLatestNdviValue(pool, { zoneId, paramId }) {
  const cols = await getColumns(pool, 'ndvi');
  if (cols.length) {
    const map = buildColumnMap(cols);
    const zoneCol = pickColumn(map, ['id_zone', 'zone_id', 'id_zones']);
    const valueCol = pickColumn(map, ['ndvi_value', 'value', 'ndvi']);
    const tsCol = pickColumn(map, ['timestamp', 'ts', 'time', 'created_at']);
    if (zoneCol && valueCol && tsCol) {
      try {
        const [rows] = await pool.query(
          `SELECT ${valueCol} AS value
           FROM ndvi
           WHERE ${zoneCol} = ? AND ${tsCol} <= NOW()
           ORDER BY ${tsCol} DESC
           LIMIT 1`,
          [zoneId],
        );
        const value = Number(rows?.[0]?.value);
        if (Number.isFinite(value)) return value;
      } catch (e) {
        console.error('latest ndvi lookup error', e);
      }
    }
  }

  if (!paramId) return null;
  const query = `SELECT value
                 FROM sensors_measurements
                 WHERE id_parameter = ? AND id_zone = ? AND timestamp <= NOW()
                 ORDER BY timestamp DESC
                 LIMIT 1`;
  try {
    const [rows] = await pool.query(query, [paramId, zoneId]);
    const value = Number(rows?.[0]?.value);
    return Number.isFinite(value) ? value : null;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallback, [paramId, zoneId]);
      const value = Number(rows?.[0]?.value);
      return Number.isFinite(value) ? value : null;
    }
    throw e;
  }
}

// Проверка наличия недавнего ручного полива в выбранной зоне.
async function hasRecentManualIrrigation(pool, zoneId) {
  try {
    const [rows] = await pool.query(
      `SELECT id_run
       FROM irrigation_runs
       WHERE id_zone = ?
         AND trigger_type = 'MANUAL'
         AND started_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY started_at DESC, id_run DESC
       LIMIT 1`,
      [zoneId],
    );
    return rows.length > 0;
  } catch (e) {
    console.error('manual irrigation lookup error', e);
    return false;
  }
}

// Расчет плавного восстановления NDVI после полива.
const hydroNdviRecoveryValue = (startValue, index, total = HYDRO_NDVI_RECOVERY_POINTS) => {
  const ratio = total <= 1 ? 1 : index / (total - 1);
  const eased = 1 - (1 - ratio) ** 2;
  const value = startValue + (HYDRO_NDVI_RECOVERY_TARGET - startValue) * eased;
  return +clamp(value, 0, HYDRO_NDVI_RECOVERY_TARGET).toFixed(3);
};

// Запись сценария восстановления NDVI для гидропонной зоны.
async function writeHydroNdviRecovery(pool, zone) {
  const zoneId = zone?.id;
  const paramId = NDVI_PARAM_BY_TECH[1];
  if (!zoneId || !paramId) return false;

  const sensorId = await resolveSensorIdByParam(pool, paramId);
  if (!sensorId) return false;

  const latest = await getLatestNdviValue(pool, { zoneId, paramId });
  const startValue = clamp(
    Number.isFinite(latest) ? latest : HYDRO_A2_NDVI_END,
    0.3,
    HYDRO_NDVI_RECOVERY_TARGET - 0.01,
  );
  const start = new Date();
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + (HYDRO_NDVI_RECOVERY_POINTS - 1) * HOUR_MS);

  await deleteMeasurementRange(pool, { paramId, zoneId, start, end });
  await deleteNdviRange(pool, { zoneId, start, end });

  for (let i = 0; i < HYDRO_NDVI_RECOVERY_POINTS; i += 1) {
    const ts = new Date(start.getTime() + i * HOUR_MS);
    const value = hydroNdviRecoveryValue(startValue, i);
    await insertScenarioMeasurement(pool, { sensorId, paramId, zoneId, value, ts });
    await insertNdviPoint(pool, { zoneId, value, ts });
  }

  return true;
}

// Запись сценария снижения NDVI для зоны A2.
async function writeHydroA2NdviScenario(pool) {
  const zone = await findHydroA2Zone(pool);
  const paramId = NDVI_PARAM_BY_TECH[1];
  if (!zone?.id || !paramId) return;
  if (await hasRecentManualIrrigation(pool, zone.id)) return;
  const sensorId = await resolveSensorIdByParam(pool, paramId);
  if (!sensorId) return;

  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - (HYDRO_A2_NDVI_POINTS - 1) * 60 * 60 * 1000);
  const queryEnd = new Date(end.getTime() + 60 * 60 * 1000 - 1);

  await deleteMeasurementRange(pool, { paramId, zoneId: zone.id, start, end: queryEnd });
  await deleteNdviRange(pool, { zoneId: zone.id, start, end: queryEnd });

  for (let i = 0; i < HYDRO_A2_NDVI_POINTS; i += 1) {
    const ts = new Date(start.getTime() + i * 60 * 60 * 1000);
    const value = hydroA2ScenarioValue(i);
    await insertScenarioMeasurement(pool, { sensorId, paramId, zoneId: zone.id, value, ts });
    await insertNdviPoint(pool, { zoneId: zone.id, value, ts });
  }

  await insertSensorError(pool, {
    sensorId,
    code: HYDRO_A2_NDVI_WARNING_CODE,
    text: 'NDVI для зоны A2 низкое',
    ts: end,
  });
}

// Запись обычных значений NDVI для гидропонных зон.
async function writeStableHydroNdviSeries(pool) {
  const paramId = NDVI_PARAM_BY_TECH[1];
  if (!paramId) return;
  const sensorId = await resolveSensorIdByParam(pool, paramId);
  if (!sensorId) return;

  const hydroZones = await fetchZonesByTechnology(pool, 1);
  const zones = hydroZones.filter((zone) => !normalizeZoneCode(zone.name).includes(HYDRO_A2_NDVI_ZONE_CODE));
  if (!zones.length) return;

  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - (HYDRO_STABLE_NDVI_POINTS - 1) * HOUR_MS);
  const queryEnd = new Date(end.getTime() + HOUR_MS - 1);

  for (const zone of zones) {
    if (await hasRecentManualIrrigation(pool, zone.id)) continue;

    await deleteMeasurementRange(pool, { paramId, zoneId: zone.id, start, end: queryEnd });
    await deleteNdviRange(pool, { zoneId: zone.id, start, end: queryEnd });

    for (let i = 0; i < HYDRO_STABLE_NDVI_POINTS; i += 1) {
      const ts = new Date(start.getTime() + i * HOUR_MS);
      const value = stableHydroNdviValue(zone, i, end.getTime());
      await insertScenarioMeasurement(pool, { sensorId, paramId, zoneId: zone.id, value, ts });
      await insertNdviPoint(pool, { zoneId: zone.id, value, ts });
    }
  }
}

// Запись значений NDVI для аэропонных зон.
async function writeAeroNdviSeries(pool) {
  const paramId = NDVI_PARAM_BY_TECH[2];
  if (!paramId) return;
  const sensorId = await resolveSensorIdByParam(pool, paramId);
  if (!sensorId) return;

  const aeroZones = await fetchZonesByTechnology(pool, 2);
  if (!aeroZones.length) return;

  const end = new Date();
  end.setMinutes(0, 0, 0);
  const start = new Date(end.getTime() - (AERO_NDVI_POINTS - 1) * HOUR_MS);
  const queryEnd = new Date(end.getTime() + HOUR_MS - 1);

  for (const zone of aeroZones) {
    await deleteMeasurementRange(pool, { paramId, zoneId: zone.id, start, end: queryEnd });
    await deleteNdviRange(pool, { zoneId: zone.id, start, end: queryEnd });

    for (let i = 0; i < AERO_NDVI_POINTS; i += 1) {
      const ts = new Date(start.getTime() + i * HOUR_MS);
      const value = aeroNdviValue(zone, i, end.getTime());
      await insertScenarioMeasurement(pool, { sensorId, paramId, zoneId: zone.id, value, ts });
      await insertNdviPoint(pool, { zoneId: zone.id, value, ts });
    }
  }
}

// Группировка измерений по временным интервалам и расчет среднего.
const aggregateRowsByInterval = (rows, intervalMs) => {
  const buckets = new Map();
  rows.forEach((r) => {
    const tsMs = new Date(r.ts).getTime();
    if (Number.isNaN(tsMs)) return;
    const value = Number(r.value);
    if (Number.isNaN(value)) return;
    const bucket = Math.floor(tsMs / intervalMs) * intervalMs;
    const zoneKey = r.zone_id != null ? String(r.zone_id) : '';
    const key = `${bucket}|${zoneKey}`;
    const acc =
      buckets.get(key) || {
        ts: new Date(bucket),
        sum: 0,
        count: 0,
        name: r.name,
        unit: r.unit,
        zone_id: r.zone_id ?? null,
        zone_name: r.zone_name ?? null,
      };
    acc.sum += value;
    acc.count += 1;
    if (!acc.name && r.name) acc.name = r.name;
    if (!acc.unit && r.unit) acc.unit = r.unit;
    if (!acc.zone_name && r.zone_name) acc.zone_name = r.zone_name;
    buckets.set(key, acc);
  });
  return Array.from(buckets.values())
    .map((b) => ({
      ts: b.ts,
      value: +(b.sum / Math.max(1, b.count)).toFixed(2),
      name: b.name,
      unit: b.unit,
      zone_id: b.zone_id ?? null,
      zone_name: b.zone_name ?? null,
    }))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
};

// Заполнение истории NDVI, если в базе не хватает данных.
async function backfillNdviHistory(pool, hours = 24) {
  const now = new Date();
  const endHour = new Date(now);
  endHour.setMinutes(0, 0, 0);
  const startHour = new Date(endHour.getTime() - (hours - 1) * 60 * 60 * 1000);
  const queryEnd = new Date(endHour.getTime() + 60 * 60 * 1000 - 1);

  const sensorParamCol = await resolveSensorParamColumn(pool);
  if (!sensorParamCol) return;

  const sensorCache = new Map();
  // Поиск датчика для параметра и сохранение результата в кэше.
  const getSensorId = async (paramId) => {
    if (sensorCache.has(paramId)) return sensorCache.get(paramId);
    const [rows] = await pool.query(
      `SELECT id_sensor AS id FROM sensors WHERE ${sensorParamCol} = ? ORDER BY id_sensor LIMIT 1`,
      [paramId],
    );
    const id = rows?.[0]?.id ?? null;
    sensorCache.set(paramId, id);
    return id;
  };

  const plan = [
    { techId: 1, paramId: NDVI_PARAM_BY_TECH[1] },
    { techId: 2, paramId: NDVI_PARAM_BY_TECH[2] },
  ].filter((p) => p.paramId != null);

  for (const item of plan) {
    const zones = await fetchZonesByTechnology(pool, item.techId);
    const zoneIds = zones.map((z) => z.id).filter((id) => id != null);
    if (!zoneIds.length) continue;
    const sensorId = await getSensorId(item.paramId);
    if (!sensorId) continue;

    const zonePlaceholders = buildInList(zoneIds);
    const query = `SELECT id_zone, value, timestamp
                   FROM sensors_measurements
                   WHERE id_parameter = ? AND id_zone IN (${zonePlaceholders})
                     AND timestamp BETWEEN ? AND ?`;
    let rows = [];
    try {
      [rows] = await pool.query(query, [item.paramId, ...zoneIds, startHour, queryEnd]);
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        const fallback = query.replace('sensors_measurements', 'sensor_measurements');
        [rows] = await pool.query(fallback, [item.paramId, ...zoneIds, startHour, queryEnd]);
      } else {
        throw e;
      }
    }

    const byZoneHour = new Map();
    rows.forEach((r) => {
      const zoneId = r.id_zone ?? null;
      if (zoneId == null) return;
      const ts = new Date(r.timestamp).getTime();
      if (!Number.isFinite(ts)) return;
      const hour = new Date(ts);
      hour.setMinutes(0, 0, 0);
      const key = hour.getTime();
      const zoneMap = byZoneHour.get(zoneId) || new Map();
      const bucket = zoneMap.get(key) || { sum: 0, count: 0 };
      const val = Number(r.value);
      if (!Number.isNaN(val)) {
        bucket.sum += val;
        bucket.count += 1;
        zoneMap.set(key, bucket);
        byZoneHour.set(zoneId, zoneMap);
      }
    });

    for (const zoneId of zoneIds) {
      const zoneMap = byZoneHour.get(zoneId) || new Map();
      const [lastRows] = await pool.query(
        `SELECT value FROM sensors_measurements
         WHERE id_parameter = ? AND id_zone = ? AND timestamp < ?
         ORDER BY timestamp DESC
         LIMIT 1`,
        [item.paramId, zoneId, startHour],
      );
      let lastVal = lastRows?.[0]?.value != null ? Number(lastRows[0].value) : null;

      for (let i = 0; i < hours; i += 1) {
        const hourTs = startHour.getTime() + i * 60 * 60 * 1000;
        const bucket = zoneMap.get(hourTs);
        if (bucket && bucket.count) {
          lastVal = bucket.sum / bucket.count;
          continue;
        }
        const value = nextNdviValue(lastVal);
        await pool.query(
          `INSERT INTO sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, timestamp)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          [sensorId, item.paramId, value, zoneId, new Date(hourTs)],
        );
        lastVal = value;
      }
    }
  }
}

// Получение минимальной уставки для выбранного параметра.
async function getReferenceMin(pool, paramId) {
  const cols = await getColumns(pool, 'reference_values');
  const idCol = cols.includes('id_parameter')
    ? 'id_parameter'
    : cols.includes('id_parameters')
      ? 'id_parameters'
      : null;
  if (!idCol) return null;
  try {
    const [rows] = await pool.query(
      `SELECT min_value FROM reference_values WHERE ${idCol} = ? LIMIT 1`,
      [paramId],
    );
    const value = rows?.[0]?.min_value;
    return value == null ? null : Number(value);
  } catch {
    return null;
  }
}

// Получение минимальной и максимальной уставки параметра.
async function getReferenceRange(pool, paramId) {
  const cols = await getColumns(pool, 'reference_values');
  const idCol = cols.includes('id_parameter')
    ? 'id_parameter'
    : cols.includes('id_parameters')
      ? 'id_parameters'
      : null;
  if (!idCol) return { min: null, max: null };
  try {
    const [rows] = await pool.query(
      `SELECT min_value, max_value FROM reference_values WHERE ${idCol} = ? LIMIT 1`,
      [paramId],
    );
    const min = rows?.[0]?.min_value;
    const max = rows?.[0]?.max_value;
    return {
      min: min == null ? null : Number(min),
      max: max == null ? null : Number(max),
    };
  } catch {
    return { min: null, max: null };
  }
}

// Поиск датчика по параметру или выбор первого доступного датчика.
async function getSensorIdByParam(pool, paramId) {
  const sensorParamCol = await resolveSensorParamColumn(pool);
  if (sensorParamCol) {
    const [rows] = await pool.query(
      `SELECT id_sensor AS id FROM sensors WHERE ${sensorParamCol} = ? ORDER BY id_sensor LIMIT 1`,
      [paramId],
    );
    if (rows?.[0]?.id) return rows[0].id;
  }
  const [fallbackRows] = await pool.query('SELECT id_sensor AS id FROM sensors ORDER BY id_sensor LIMIT 1');
  return fallbackRows?.[0]?.id ?? null;
}

// Определение зоны, к которой относится датчик.
async function getZoneIdForSensor(pool, sensorId) {
  const sensorZoneCol = await resolveSensorZoneColumn(pool);
  if (sensorZoneCol && sensorId) {
    try {
      const [rows] = await pool.query(
        `SELECT ${sensorZoneCol} AS zone_id FROM sensors WHERE id_sensor = ? LIMIT 1`,
        [sensorId],
      );
      const zoneId = rows?.[0]?.zone_id ?? null;
      if (zoneId != null) return zoneId;
    } catch {
      // Пропуск ошибки: значение параметра останется пустым
    }
  }
  try {
    const [rows] = await pool.query('SELECT id_zone FROM zones ORDER BY id_zone LIMIT 1');
    return rows?.[0]?.id_zone ?? null;
  } catch {
    return null;
  }
}

// Получение последнего значения параметра, при необходимости только по зоне.
async function getLatestParamValue(pool, paramId, zoneId = null) {
  const zoneFilter = zoneId != null ? 'AND id_zone = ?' : '';
  const params = zoneId != null ? [paramId, zoneId] : [paramId];
  try {
    const [rows] = await pool.query(
      `SELECT value
       FROM sensors_measurements
       WHERE id_parameter = ? ${zoneFilter}
       ORDER BY timestamp DESC
       LIMIT 1`,
      params,
    );
    const value = rows?.[0]?.value;
    return value == null ? null : Number(value);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      try {
        const [rows] = await pool.query(
          `SELECT value
           FROM sensor_measurements
           WHERE id_parameter = ? ${zoneFilter}
           ORDER BY timestamp DESC
           LIMIT 1`,
          params,
        );
        const value = rows?.[0]?.value;
        return value == null ? null : Number(value);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Получение времени последнего измерения выбранного параметра.
async function getLatestParamTimestamp(pool, paramId) {
  try {
    const [rows] = await pool.query(
      `SELECT timestamp
       FROM sensors_measurements
       WHERE id_parameter = ?
       ORDER BY timestamp DESC
       LIMIT 1`,
      [paramId],
    );
    return rows?.[0]?.timestamp ? new Date(rows[0].timestamp) : null;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      try {
        const [rows] = await pool.query(
          `SELECT timestamp
           FROM sensor_measurements
           WHERE id_parameter = ?
           ORDER BY timestamp DESC
           LIMIT 1`,
          [paramId],
        );
        return rows?.[0]?.timestamp ? new Date(rows[0].timestamp) : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Получение последней обычной температуры до указанного момента.
async function getLatestNormalTemperature(pool, beforeTs = null) {
  const cutoff = beforeTs ? new Date(beforeTs) : null;
  // Сборка SQL-запроса для основной или резервной таблицы измерений.
  const query = (table) => `SELECT value
       FROM ${table}
       WHERE id_parameter = ?${cutoff ? ' AND timestamp < ?' : ''}
       ORDER BY timestamp DESC
       LIMIT 1`;
  const params = cutoff ? [AIR_TEMP_PARAM_ID, cutoff] : [AIR_TEMP_PARAM_ID];
  try {
    const [rows] = await pool.query(query('sensors_measurements'), params);
    const value = rows?.[0]?.value;
    return value == null ? null : Number(value);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      try {
        const [rows] = await pool.query(query('sensor_measurements'), params);
        const value = rows?.[0]?.value;
        return value == null ? null : Number(value);
      } catch {
        return null;
      }
    }
    return null;
  }
}

// Получение списка датчиков температуры воздуха.
async function getTemperatureSensors(pool) {
  if (tempNormal.sensors) return tempNormal.sensors;
  const sensorParamCol = await resolveSensorParamColumn(pool);
  const sensorZoneCol = await resolveSensorZoneColumn(pool);
  if (!sensorParamCol) return [];
  const zoneSelect = sensorZoneCol ? `, ${sensorZoneCol} AS zone_id` : '';
  const [rows] = await pool.query(
    `SELECT id_sensor AS id${zoneSelect} FROM sensors WHERE ${sensorParamCol} = ?`,
    [AIR_TEMP_PARAM_ID],
  );
  if (rows?.length) {
    tempNormal.sensors = rows;
    return rows;
  }
  const [fallbackRows] = await pool.query('SELECT id_sensor AS id FROM sensors ORDER BY id_sensor LIMIT 1');
  tempNormal.sensors = fallbackRows || [];
  return tempNormal.sensors;
}

// Генерация обычных значений температуры, когда сценарий отключен.
async function generateNormalTemperature(pool) {
  if (tempScenario.active) return;
  const sensors = await getTemperatureSensors(pool);
  if (!sensors.length) return;
  const latestTs = await getLatestParamTimestamp(pool, AIR_TEMP_PARAM_ID);
  if (latestTs && Date.now() - latestTs.getTime() < 55 * 1000) {
    return;
  }
  const { min, max } = await getReferenceRange(pool, AIR_TEMP_PARAM_ID);
  const lo = Number.isFinite(min) ? min : AIR_TEMP_RANGE_MIN;
  const hi = Number.isFinite(max) ? max : AIR_TEMP_RANGE_MAX;
  const now = new Date();
  now.setSeconds(59, 0);
  for (const s of sensors) {
    const value = +rand(lo, hi).toFixed(2);
    await insertMeasurement(pool, {
      sensorId: s.id,
      paramId: AIR_TEMP_PARAM_ID,
      value,
      zoneId: s.zone_id ?? null,
      ts: now,
    });
  }
}

// Добавление нового измерения датчика в базу данных.
async function insertMeasurement(pool, { sensorId, paramId, value, zoneId, ts }) {
  if (!sensorId || paramId == null) return;
  const timestamp = ts || new Date();
  try {
    await pool.query(
      `INSERT INTO sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, timestamp)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [sensorId, paramId, value, zoneId ?? null, timestamp],
    );
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      try {
        await pool.query(
          `INSERT INTO sensor_measurements (id_sensors, id_parameter, value, id_zone, id_run, timestamp)
           VALUES (?, ?, ?, ?, NULL, ?)`,
          [sensorId, paramId, value, zoneId ?? null, timestamp],
        );
      } catch (inner) {
        console.error('insert measurement fallback error', inner);
      }
    } else {
      console.error('insert measurement error', e);
    }
  }
}

// Добавление или обновление измерения с тем же датчиком и временем.
async function upsertMeasurement(pool, { sensorId, paramId, value, zoneId, ts }) {
  if (!sensorId || paramId == null) return;
  const timestamp = ts || new Date();
  const sql = `INSERT INTO sensors_measurements (id_sensors, id_parameter, value, id_zone, id_run, timestamp)
               VALUES (?, ?, ?, ?, NULL, ?)
               ON DUPLICATE KEY UPDATE value = VALUES(value)`;
  try {
    await pool.query(sql, [sensorId, paramId, value, zoneId ?? null, timestamp]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = sql.replace('sensors_measurements', 'sensor_measurements');
      try {
        await pool.query(fallback, [sensorId, paramId, value, zoneId ?? null, timestamp]);
      } catch (inner) {
        console.error('upsert measurement fallback error', inner);
      }
    } else {
      console.error('upsert measurement error', e);
    }
  }
}

// Запись ошибки датчика, если такая ошибка еще не добавлена.
async function insertSensorError(pool, { sensorId, code, text, ts }) {
  if (!sensorId || !code || !ts) return;
  try {
    const [exists] = await pool.query(
      `SELECT id_sensor_error
       FROM sensor_error
       WHERE id_sensor_number = ? AND error_code = ? AND timestamp = ?
       LIMIT 1`,
      [sensorId, code, ts],
    );
    if (exists.length) return;
    await pool.query(
      `INSERT INTO sensor_error (error_code, error_name, timestamp, id_sensor_number)
       VALUES (?, ?, ?, ?)`,
      [code, text, ts, sensorId],
    );
  } catch (e) {
    console.error('sensor_error insert error', e);
  }
}

const MAX_TEMP_SCENARIO_SAMPLES = 3000;
const MAX_TEMP_SCENARIO_HISTORY = 600;

const tempScenario = {
  sensorId: null,
  zoneId: null,
  value: null,
  phase: 'cooling',
  heatingOn: false,
  notifiedLow: false,
  notifiedOk: false,
  active: false,
  normalMin: AIR_TEMP_DEFAULT_NORMAL,
  startedAt: null,
  sampleKeys: new Set(),
  sampleKeyOrder: [],
  history: [],
};

// Сохранение списка измерений, созданных температурным сценарием.
const recordTempScenarioSample = (sensorId, ts) => {
  const key = measurementKey(sensorId, ts);
  if (!key) return;
  if (!tempScenario.sampleKeys) {
    tempScenario.sampleKeys = new Set();
  }
  if (!tempScenario.sampleKeyOrder) {
    tempScenario.sampleKeyOrder = [];
  }
  if (tempScenario.sampleKeys.has(key)) return;
  tempScenario.sampleKeys.add(key);
  tempScenario.sampleKeyOrder.push(key);
  if (tempScenario.sampleKeyOrder.length > MAX_TEMP_SCENARIO_SAMPLES) {
    const excess = tempScenario.sampleKeyOrder.length - MAX_TEMP_SCENARIO_SAMPLES;
    const removed = tempScenario.sampleKeyOrder.splice(0, excess);
    removed.forEach((oldKey) => tempScenario.sampleKeys.delete(oldKey));
  }
};

// Сохранение истории значений температурного сценария для отображения.
const recordTempScenarioHistory = (ts, value, sensorId = null, zoneId = null) => {
  if (!tempScenario.history) tempScenario.history = [];
  const time = new Date(ts).getTime();
  if (Number.isNaN(time)) return;
  tempScenario.history.push({
    ts: time,
    value,
    sensorId,
    zoneId,
  });
  if (tempScenario.history.length > MAX_TEMP_SCENARIO_HISTORY) {
    tempScenario.history.splice(0, tempScenario.history.length - MAX_TEMP_SCENARIO_HISTORY);
  }
};

const tempNormal = {
  sensors: null,
};

// Сброс температурного сценария в начальное состояние.
const resetTempScenario = () => {
  tempScenario.value = AIR_TEMP_DEFAULT_START;
  tempScenario.phase = 'cooling';
  tempScenario.heatingOn = false;
  tempScenario.notifiedLow = false;
  tempScenario.notifiedOk = false;
  tempScenario.zoneId = null;
  tempScenario.normalMin = AIR_TEMP_DEFAULT_NORMAL;
  tempScenario.startedAt = new Date();
  if (tempScenario.sampleKeys) tempScenario.sampleKeys.clear();
  if (tempScenario.sampleKeyOrder) tempScenario.sampleKeyOrder.length = 0;
  if (tempScenario.history) tempScenario.history.length = 0;
  tempNormal.sensors = null;
};

// Остановка температурного сценария и таймера его выполнения.
const stopTempScenario = () => {
  tempScenario.active = false;
  tempScenario.heatingOn = false;
  if (tempTimer) {
    clearInterval(tempTimer);
    tempTimer = null;
  }
};

// Подготовка датчика, зоны и уставок для температурного сценария.
async function initTempScenario(pool) {
  if (!tempScenario.sensorId) {
    tempScenario.sensorId = await getSensorIdByParam(pool, AIR_TEMP_PARAM_ID);
  }
  if (tempScenario.zoneId == null) {
    tempScenario.zoneId = await getZoneIdForSensor(pool, tempScenario.sensorId);
  }
  if (!tempScenario.startedAt) {
    tempScenario.startedAt = new Date();
  }
  if (tempScenario.value == null) {
    tempScenario.value = AIR_TEMP_DEFAULT_START;
  }
  if (!Number.isFinite(tempScenario.normalMin)) {
    tempScenario.normalMin = AIR_TEMP_DEFAULT_NORMAL;
  }
  const refMin = await getReferenceMin(pool, AIR_TEMP_PARAM_ID);
  if (Number.isFinite(refMin)) {
    tempScenario.normalMin = refMin;
  }
  if (tempScenario.value <= AIR_TEMP_CRITICAL) {
    if (tempScenario.phase === 'cooling') {
      tempScenario.phase = tempScenario.heatingOn ? 'heating' : 'waiting_heat';
    } else if (tempScenario.phase === 'waiting_heat' && tempScenario.heatingOn) {
      tempScenario.phase = 'heating';
    }
  }
}

// Выполнение одного шага температурного сценария.
async function tickTempScenario(pool) {
  if (!tempScenario.active) return;
  await initTempScenario(pool);
  const sensors = await getTemperatureSensors(pool);
  if (!sensors.length && !tempScenario.sensorId) return;

  const heatingTarget = AIR_TEMP_HEATING_TARGET;

  let value = Number.isFinite(tempScenario.value) ? tempScenario.value : AIR_TEMP_DEFAULT_START;
  const now = new Date();
  now.setMilliseconds(0);

  let nextValue = value;

  if (tempScenario.phase === 'cooling') {
    if (value <= AIR_TEMP_CRITICAL) {
      tempScenario.phase = 'waiting_heat';
      if (!tempScenario.notifiedLow) {
        await insertSensorError(pool, {
          sensorId: tempScenario.sensorId,
          code: 'TEMP_LOW',
          text: 'Температура критически низкая — включить отопление',
          ts: now,
        });
        tempScenario.notifiedLow = true;
      }
    }
    nextValue = Math.max(AIR_TEMP_CRITICAL, value - AIR_TEMP_STEP_VALUE);
  } else if (tempScenario.phase === 'waiting_heat') {
    if (tempScenario.heatingOn) {
      tempScenario.phase = 'heating';
    }
  } else if (tempScenario.phase === 'heating') {
    nextValue = Math.min(heatingTarget, value + AIR_TEMP_STEP_VALUE);
    if (nextValue >= heatingTarget) {
      tempScenario.phase = 'stable';
      tempScenario.notifiedOk = true;
    }
  } else if (tempScenario.phase === 'stable') {
    nextValue = Number.isFinite(value) ? value : heatingTarget;
  }

  const currentValue = +clamp(value, 0, 50).toFixed(2);
  tempScenario.value = +clamp(nextValue, 0, 50).toFixed(2);
  recordTempScenarioHistory(now, currentValue, tempScenario.sensorId, tempScenario.zoneId);

  if (sensors.length) {
    for (const s of sensors) {
      await upsertMeasurement(pool, {
        sensorId: s.id,
        paramId: AIR_TEMP_PARAM_ID,
        value: currentValue,
        zoneId: s.zone_id ?? tempScenario.zoneId,
        ts: now,
      });
      recordTempScenarioSample(s.id, now);
    }
  } else if (tempScenario.sensorId) {
    await upsertMeasurement(pool, {
      sensorId: tempScenario.sensorId,
      paramId: AIR_TEMP_PARAM_ID,
      value: currentValue,
      zoneId: tempScenario.zoneId,
      ts: now,
    });
    recordTempScenarioSample(tempScenario.sensorId, now);
  }
}

// Получение последнего запуска полива для выбранной технологии.
async function getLastRunInfo(pool, technologId) {
  const [rows] = await pool.query(
    `SELECT ir.id_run, ir.started_at AS started_at
     FROM irrigation_runs ir
     JOIN zones z ON z.id_zone = ir.id_zone
     WHERE z.id_technolog = ?
     ORDER BY ir.started_at DESC, ir.id_run DESC
     LIMIT 1`,
    [technologId],
  );
  return rows?.[0] || null;
}

// Определение временного интервала измерений в рамках одного запуска полива.
async function getRunMeasurementWindow(pool, runId, paramIds) {
  if (!runId || !paramIds.length) return null;
  const placeholders = buildInList(paramIds);
  const query = `SELECT MIN(m.timestamp) AS start,
                        MAX(m.timestamp) AS end
                 FROM sensors_measurements m
                 WHERE m.id_run = ? AND m.id_parameter IN (${placeholders})`;
  try {
    const [rows] = await pool.query(query, [runId, ...paramIds]);
    const start = rows?.[0]?.start;
    const end = rows?.[0]?.end;
    if (start && end) return { start, end };
    const fallback = query.replace('sensors_measurements', 'sensor_measurements');
    try {
      const [altRows] = await pool.query(fallback, [runId, ...paramIds]);
      const altStart = altRows?.[0]?.start;
      const altEnd = altRows?.[0]?.end;
      if (altStart && altEnd) return { start: altStart, end: altEnd };
    } catch (err) {
      if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallback, [runId, ...paramIds]);
      const start = rows?.[0]?.start;
      const end = rows?.[0]?.end;
      if (start && end) return { start, end };
      return null;
    }
    throw e;
  }
  return null;
}

// Добавление секунд к дате средствами SQL.
async function addSecondsSql(pool, start, seconds) {
  const [rows] = await pool.query(
    `SELECT DATE_FORMAT(DATE_ADD(?, INTERVAL ? SECOND), '%Y-%m-%d %H:%i:%s') AS end`,
    [start, seconds],
  );
  return rows?.[0]?.end || null;
}

// Получение окна данных по последнему запуску полива.
async function getLastWindowByRun(pool, technologId, paramIds, defaultSeconds) {
  try {
    const run = await getLastRunInfo(pool, technologId);
    if (!run) return null;
    const window = await getRunMeasurementWindow(pool, run.id_run, paramIds);
    if (window?.start && window?.end) return window;
  } catch (e) {
    console.error('getLastWindowByRun error', e);
  }
  return null;
}

// Получение окна последних измерений по списку параметров.
async function getLastMeasurementWindowByParams(pool, paramIds, windowSeconds) {
  if (!paramIds.length) return null;
  const placeholders = buildInList(paramIds);
  const query = `SELECT DATE_SUB(MAX(m.timestamp), INTERVAL ? SECOND) AS start,
                        MAX(m.timestamp) AS end
                 FROM sensors_measurements m
                 WHERE m.id_parameter IN (${placeholders})`;
  try {
    const [rows] = await pool.query(query, [windowSeconds, ...paramIds]);
    const start = rows?.[0]?.start;
    const end = rows?.[0]?.end;
    if (start && end) return { start, end };
    const fallback = query.replace('sensors_measurements', 'sensor_measurements');
    try {
      const [altRows] = await pool.query(fallback, [windowSeconds, ...paramIds]);
      const altStart = altRows?.[0]?.start;
      const altEnd = altRows?.[0]?.end;
      if (altStart && altEnd) return { start: altStart, end: altEnd };
    } catch (err) {
      if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallback, [windowSeconds, ...paramIds]);
      const start = rows?.[0]?.start;
      const end = rows?.[0]?.end;
      if (start && end) return { start, end };
      return null;
    }
    throw e;
  }
  return null;
}

// Получение окна последних измерений по параметрам и зонам.
async function getLastMeasurementWindowByParamsAndZones(pool, paramIds, zoneIds, windowSeconds) {
  if (!paramIds.length || !zoneIds.length) return null;
  const paramPlaceholders = buildInList(paramIds);
  const zonePlaceholders = buildInList(zoneIds);
  const query = `SELECT DATE_SUB(MAX(m.timestamp), INTERVAL ? SECOND) AS start,
                        MAX(m.timestamp) AS end
                 FROM sensors_measurements m
                 WHERE m.id_parameter IN (${paramPlaceholders})
                   AND m.id_zone IN (${zonePlaceholders})`;
  const params = [windowSeconds, ...paramIds, ...zoneIds];
  try {
    const [rows] = await pool.query(query, params);
    const start = rows?.[0]?.start;
    const end = rows?.[0]?.end;
    if (start && end) return { start, end };
    const fallback = query.replace('sensors_measurements', 'sensor_measurements');
    try {
      const [altRows] = await pool.query(fallback, params);
      const altStart = altRows?.[0]?.start;
      const altEnd = altRows?.[0]?.end;
      if (altStart && altEnd) return { start: altStart, end: altEnd };
    } catch (err) {
      if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
    }
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallback, params);
      const start = rows?.[0]?.start;
      const end = rows?.[0]?.end;
      if (start && end) return { start, end };
      return null;
    }
    throw e;
  }
  return null;
}

// Создание стартовых данных через полив, если измерений еще нет.
async function ensureSeeded(pool, technologId, paramIds, durationSeconds) {
  try {
    let count = 0;
    try {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM sensors_measurements WHERE id_parameter IN (${buildInList(paramIds)})`,
        paramIds,
      );
      count = Number(rows?.[0]?.cnt || 0);
      if (!count) {
        try {
          const [altRows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM sensor_measurements WHERE id_parameter IN (${buildInList(paramIds)})`,
            paramIds,
          );
          count = Number(altRows?.[0]?.cnt || 0);
        } catch (err) {
          if (err?.code !== 'ER_NO_SUCH_TABLE') throw err;
        }
      }
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        const [rows] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM sensor_measurements WHERE id_parameter IN (${buildInList(paramIds)})`,
          paramIds,
        );
        count = Number(rows?.[0]?.cnt || 0);
      } else {
        throw e;
      }
    }

    if (count > 0) return false;

    const [zones] = await pool.query(`SELECT id_zone FROM zones WHERE id_technolog = ?`, [technologId]);
    if (!zones?.length) return false;

    for (const z of zones) {
      try {
        await pool.query('CALL start_irrigation_for_zone(?, ?, ?, ?)', [
          z.id_zone,
          'MANUAL',
          durationSeconds,
          null,
        ]);
      } catch (e) {
        console.error('seed run error', e);
      }
    }
    return true;
  } catch (e) {
    console.error('ensureSeeded error', e);
    return false;
  }
}

// Определение временного окна для графиков гидропоники.
async function getHydroWindow(pool) {
  if (!HYDRO_PARAM_IDS.length) return null;
  let window = await getLastWindowByRun(pool, 1, HYDRO_PARAM_IDS, HYDRO_WINDOW_SECONDS);
  if (!window) window = await getLastMeasurementWindowByParams(pool, HYDRO_PARAM_IDS, HYDRO_WINDOW_SECONDS);
  if (!window) {
    const seeded = await ensureSeeded(pool, 1, HYDRO_PARAM_IDS, HYDRO_WINDOW_SECONDS);
    if (seeded) {
      window = await getLastWindowByRun(pool, 1, HYDRO_PARAM_IDS, HYDRO_WINDOW_SECONDS);
      if (!window) window = await getLastMeasurementWindowByParams(pool, HYDRO_PARAM_IDS, HYDRO_WINDOW_SECONDS);
    }
  }
  return window;
}

// Определение временного окна для графиков аэропоники.
async function getAeroWindow(pool) {
  if (!AERO_PARAM_IDS.length) return null;
  let window = await getLastWindowByRun(pool, 2, AERO_PARAM_IDS, AERO_WINDOW_SECONDS);
  if (!window) {
    try {
      const zones = await fetchZonesByTechnology(pool, 2);
      const zoneIds = zones.map((z) => z.id).filter((id) => id != null);
      if (zoneIds.length) {
        window = await getLastMeasurementWindowByParamsAndZones(pool, AERO_PARAM_IDS, zoneIds, AERO_WINDOW_SECONDS);
      }
    } catch (e) {
      console.error('getAeroWindow zones error', e);
    }
  }
  if (!window) window = await getLastMeasurementWindowByParams(pool, AERO_PARAM_IDS, AERO_WINDOW_SECONDS);
  if (!window) {
    const seeded = await ensureSeeded(pool, 2, AERO_PARAM_IDS, AERO_WINDOW_SECONDS);
    if (seeded) {
      window = await getLastWindowByRun(pool, 2, AERO_PARAM_IDS, AERO_WINDOW_SECONDS);
      if (!window) {
        try {
          const zones = await fetchZonesByTechnology(pool, 2);
          const zoneIds = zones.map((z) => z.id).filter((id) => id != null);
          if (zoneIds.length) {
            window = await getLastMeasurementWindowByParamsAndZones(pool, AERO_PARAM_IDS, zoneIds, AERO_WINDOW_SECONDS);
          }
        } catch (e) {
          console.error('getAeroWindow zones error', e);
        }
      }
      if (!window) window = await getLastMeasurementWindowByParams(pool, AERO_PARAM_IDS, AERO_WINDOW_SECONDS);
    }
  }
  return window;
}

// Загрузка измерений по парам датчик-время.
async function fetchMeasurementsByPairs(pool, pairs) {
  if (!pairs.length) return [];
  const unique = new Map();
  pairs.forEach((p) => {
    const key = measurementKey(p.sensorId, p.ts);
    if (key) unique.set(key, p);
  });
  const list = Array.from(unique.values());
  if (!list.length) return [];
  const placeholders = list.map(() => '(?, ?)').join(',');
  const values = list.flatMap((p) => [p.sensorId, p.ts]);
  const baseQuery = `SELECT m.id_sensors AS sensor_id,
                            m.timestamp AS ts,
                            m.value,
                            m.id_parameter
                     FROM sensors_measurements m
                     WHERE (m.id_sensors, m.timestamp) IN (${placeholders})`;
  try {
    const [rows] = await pool.query(baseQuery, values);
    return rows;
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallbackQuery = baseQuery.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallbackQuery, values);
      return rows;
    }
    throw e;
  }
}

// Приведение данных исполнительного устройства к единому виду.
const normalizeActuator = (row) => {
  const id = row.id ?? row.id_actuator ?? row.actuator_id ?? row.id_actuators;
  const name = row.name ?? row.name_actuator ?? row.actuator_name ?? row.title;
  const type = row.type ?? row.type_actuator ?? row.type_actuators ?? row.actuator_type ?? row.category;
  const serial = row.serial ?? row.serial_number ?? row.actuators_serial_number ?? row.actuator_serial_number;
  const zoneId = row.zoneId ?? row.id_zone ?? row.zone_id ?? row.zone;
  const status = row.status ?? row.state;
  return {
    ...row,
    ...(id !== undefined ? { id } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(serial !== undefined ? { serial } : {}),
    ...(zoneId !== undefined ? { zoneId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
};

// Список зон
app.get('/api/zones', async (req, res) => {
  const pool = await poolPromise;
  const { q, technology } = req.query;
  const conditions = [];
  const params = [];
  if (q) {
    conditions.push('z.zone_name LIKE ?');
    params.push(`%${q}%`);
  }
  if (technology) {
    conditions.push('(gt.name_technology LIKE ?)');
    params.push(`%${technology}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const hasNdvi = (await getColumns(pool, 'ndvi')).length > 0;
  const ndviSelect = hasNdvi ? 'nd.latest_ndvi AS ndvi' : 'NULL AS ndvi';
  const ndviJoin = hasNdvi
    ? `LEFT JOIN (
       SELECT n.id_zone, n.ndvi_value AS latest_ndvi
       FROM ndvi n
       INNER JOIN (
         SELECT id_zone, MAX(timestamp) AS ts
         FROM ndvi
         GROUP BY id_zone
       ) t ON t.id_zone = n.id_zone AND t.ts = n.timestamp
     ) nd ON nd.id_zone = z.id_zone`
    : '';
  // Сборка запроса зон с учетом возможного названия колонки технологии.
  const buildSql = (techCol) => `SELECT z.id_zone AS id,
            z.zone_name AS name,
            z.${techCol} AS technology,
            CASE
              WHEN ir.last_started_at IS NULL THEN 0
              WHEN TIMESTAMPDIFF(SECOND, ir.last_started_at, NOW()) BETWEEN 0 AND
                   COALESCE(ir.duration_sec, CASE WHEN z.${techCol} = 1 THEN 600 WHEN z.${techCol} = 2 THEN 10 ELSE 0 END)
                THEN 1
              ELSE 0
            END AS is_watering,
            ${ndviSelect},
            z.row_number AS row_num,
            z.column_number AS col_num,
            gt.name_technology AS technology_name
     FROM zones z
     LEFT JOIN growing_technology gt ON gt.id_technology = z.${techCol}
     LEFT JOIN (
       SELECT latest.id_zone, latest.started_at AS last_started_at, latest.duration_sec
       FROM irrigation_runs latest
       INNER JOIN (
         SELECT id_zone, MAX(id_run) AS id_run
         FROM irrigation_runs
         GROUP BY id_zone
       ) last_run ON last_run.id_run = latest.id_run
     ) ir ON ir.id_zone = z.id_zone
     ${ndviJoin}
     ${where}`;
  let rows;
  try {
    [rows] = await pool.query(buildSql('id_technolog'), params);
  } catch (e) {
    if (e?.code === 'ER_BAD_FIELD_ERROR') {
      try {
        [rows] = await pool.query(buildSql('id_tehnolog'), params);
      } catch (inner) {
        if (inner?.code === 'ER_BAD_FIELD_ERROR') {
          [rows] = await pool.query(buildSql('id_technology'), params);
        } else {
          throw inner;
        }
      }
    } else {
      throw e;
    }
  }
  const zoneIds = rows.map((r) => r.id).filter((v) => v != null);
  const measurementsByZone = new Map();
  if (zoneIds.length && ZONE_PARAM_IDS.length) {
    const zonePlaceholders = buildInList(zoneIds);
    const paramPlaceholders = buildInList(ZONE_PARAM_IDS);
    // Сборка запроса последних значений параметров по зонам.
    const buildLatestQuery = (table) => `SELECT m.id_zone, m.id_parameter, m.value, m.timestamp
       FROM ${table} m
       INNER JOIN (
         SELECT id_zone, id_parameter, MAX(timestamp) AS ts
         FROM ${table}
         WHERE id_zone IN (${zonePlaceholders}) AND id_parameter IN (${paramPlaceholders})
         GROUP BY id_zone, id_parameter
       ) t ON t.id_zone = m.id_zone AND t.id_parameter = m.id_parameter AND t.ts = m.timestamp`;
    let measureRows = [];
    try {
      [measureRows] = await pool.query(buildLatestQuery('sensors_measurements'), [
        ...zoneIds,
        ...ZONE_PARAM_IDS,
      ]);
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        try {
          [measureRows] = await pool.query(buildLatestQuery('sensor_measurements'), [
            ...zoneIds,
            ...ZONE_PARAM_IDS,
          ]);
        } catch (inner) {
          if (inner?.code !== 'ER_BAD_FIELD_ERROR') {
            throw inner;
          }
        }
      } else if (e?.code !== 'ER_BAD_FIELD_ERROR') {
        throw e;
      }
    }
    measureRows.forEach((m) => {
      const key = `${m.id_zone}:${m.id_parameter}`;
      measurementsByZone.set(key, m.value);
    });
  }
  const ndviByZone = new Map();
  if (zoneIds.length && NDVI_PARAM_IDS.length) {
    const zonePlaceholders = buildInList(zoneIds);
    const paramPlaceholders = buildInList(NDVI_PARAM_IDS);
    // Сборка запроса последних значений NDVI по зонам.
    const buildLatestNdviQuery = (table) => `SELECT m.id_zone, m.id_parameter, m.value, m.timestamp
       FROM ${table} m
       INNER JOIN (
         SELECT id_zone, id_parameter, MAX(timestamp) AS ts
         FROM ${table}
         WHERE id_zone IN (${zonePlaceholders}) AND id_parameter IN (${paramPlaceholders})
         GROUP BY id_zone, id_parameter
       ) t ON t.id_zone = m.id_zone AND t.id_parameter = m.id_parameter AND t.ts = m.timestamp`;
    let ndviRows = [];
    try {
      [ndviRows] = await pool.query(buildLatestNdviQuery('sensors_measurements'), [
        ...zoneIds,
        ...NDVI_PARAM_IDS,
      ]);
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        try {
          [ndviRows] = await pool.query(buildLatestNdviQuery('sensor_measurements'), [
            ...zoneIds,
            ...NDVI_PARAM_IDS,
          ]);
        } catch (inner) {
          if (inner?.code !== 'ER_BAD_FIELD_ERROR') {
            throw inner;
          }
        }
      } else if (e?.code !== 'ER_BAD_FIELD_ERROR') {
        throw e;
      }
    }
    ndviRows.forEach((m) => {
      const zoneId = m.id_zone;
      const ts = new Date(m.timestamp).getTime();
      const current = ndviByZone.get(zoneId);
      if (!current || (Number.isFinite(ts) && ts > current.ts)) {
        ndviByZone.set(zoneId, { value: m.value, ts: Number.isFinite(ts) ? ts : 0 });
      }
    });
  }

  // Выбор набора параметров для зоны по ее технологии.
  const pickTechMap = (row) => {
    const techId = Number(row?.technology);
    if (techId === 1) return HYDRO_PARAM_MAP;
    if (techId === 2) return AERO_PARAM_MAP;
    const label = (row?.technology_name || row?.technology || '').toString().toLowerCase();
    if (label.includes('гидро') || label.includes('hydro')) return HYDRO_PARAM_MAP;
    if (label.includes('аэро') || label.includes('aero')) return AERO_PARAM_MAP;
    return null;
  };

  res.json(
    rows.map((r) => {
      const isWatering = !!r.is_watering;
      const techMap = pickTechMap(r);
      const metrics = {};
      if (techMap) {
        Object.entries(techMap).forEach(([key, paramId]) => {
          const raw = measurementsByZone.get(`${r.id}:${paramId}`);
          const value = toNumber(raw);
          metrics[key] = isWatering || key === 'rootHumidity' ? value : 0;
        });
      }
      const ndviRaw = r.ndvi ?? ndviByZone.get(r.id)?.value;
      const ndvi = toNumber(ndviRaw);
      return {
        id: r.id,
        name: r.name,
        technology: r.technology_name || r.technology,
        technologyId: r.technology ?? null,
        technologyName: r.technology_name || null,
        status: isWatering ? 'watering' : 'idle',
        isWatering,
        ndvi,
        row: r.row_num,
        column: r.col_num,
        metrics,
      };
    }),
  );
});

// Подробная информация о зоне
app.get('/api/zones/:id', async (req, res) => {
  const pool = await poolPromise;
  const { id } = req.params;
  const hasNdvi = (await getColumns(pool, 'ndvi')).length > 0;
  const ndviSelect = hasNdvi ? 'nd.latest_ndvi AS ndvi' : 'NULL AS ndvi';
  const ndviJoin = hasNdvi
    ? `LEFT JOIN (
       SELECT n.id_zone, n.ndvi_value AS latest_ndvi
       FROM ndvi n
       INNER JOIN (
         SELECT id_zone, MAX(timestamp) AS ts
         FROM ndvi
         GROUP BY id_zone
       ) t ON t.id_zone = n.id_zone AND t.ts = n.timestamp
     ) nd ON nd.id_zone = z.id_zone`
    : '';
  // Сборка запроса одной зоны с учетом возможного названия колонки технологии.
  const buildSql = (techCol) => `SELECT z.id_zone AS id,
            z.zone_name AS name,
            z.${techCol} AS technology,
            CASE
              WHEN ir.last_started_at IS NULL THEN 0
              WHEN TIMESTAMPDIFF(SECOND, ir.last_started_at, NOW()) BETWEEN 0 AND
                   COALESCE(ir.duration_sec, CASE WHEN z.${techCol} = 1 THEN 600 WHEN z.${techCol} = 2 THEN 10 ELSE 0 END)
                THEN 1
              ELSE 0
            END AS is_watering,
            ${ndviSelect},
            z.row_number AS row_num,
            z.column_number AS col_num,
            gt.name_technology AS technology_name
     FROM zones z
     LEFT JOIN growing_technology gt ON gt.id_technology = z.${techCol}
     LEFT JOIN (
       SELECT latest.id_zone, latest.started_at AS last_started_at, latest.duration_sec
       FROM irrigation_runs latest
       INNER JOIN (
         SELECT id_zone, MAX(id_run) AS id_run
         FROM irrigation_runs
         GROUP BY id_zone
       ) last_run ON last_run.id_run = latest.id_run
     ) ir ON ir.id_zone = z.id_zone
     ${ndviJoin}
     WHERE z.id_zone=?`;
  let zoneRows;
  try {
    [zoneRows] = await pool.query(buildSql('id_technolog'), [id]);
  } catch (e) {
    if (e?.code === 'ER_BAD_FIELD_ERROR') {
      try {
        [zoneRows] = await pool.query(buildSql('id_tehnolog'), [id]);
      } catch (inner) {
        if (inner?.code === 'ER_BAD_FIELD_ERROR') {
          [zoneRows] = await pool.query(buildSql('id_technology'), [id]);
        } else {
          throw inner;
        }
      }
    } else {
      throw e;
    }
  }
  const zone = zoneRows?.[0];
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  res.json({
    id: zone.id,
    name: zone.name,
    technology: zone.technology_name || zone.technology,
    technologyId: zone.technology ?? null,
    technologyName: zone.technology_name || null,
    status: zone.is_watering ? 'watering' : 'idle',
    isWatering: !!zone.is_watering,
    ndvi: zone.ndvi,
    row: zone.row_num,
    column: zone.col_num,
  });
});

// Принудительный полив одной зоны через хранимую процедуру
app.post('/api/zones/:id/water/force', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const { id } = req.params;
    const { durationSec, startedByEmployee } = req.body || {};

    if (!id) return res.status(400).json({ error: 'Zone id required' });
    const zone = await fetchZoneById(pool, id);
    if (!zone) return res.status(404).json({ error: 'Zone not found' });

    const duration =
      durationSec === undefined || durationSec === null || durationSec === ''
        ? null
        : Number(durationSec);
    if (duration !== null && Number.isNaN(duration)) {
      return res.status(400).json({ error: 'durationSec must be a number' });
    }

    const startedBy =
      startedByEmployee === undefined || startedByEmployee === null || startedByEmployee === ''
        ? null
        : startedByEmployee;

    const [resultSets] = await pool.query(
      'CALL start_irrigation_for_zone(?, ?, ?, ?)',
      [id, 'MANUAL', duration, startedBy],
    );

    let runId = null;
    if (Array.isArray(resultSets)) {
      for (const set of resultSets) {
        if (Array.isArray(set) && set.length && set[0]?.id_run != null) {
          runId = set[0].id_run;
          break;
        }
      }
    }

    res.json({ ok: true, runId });
  } catch (err) {
    next(err);
  }
});

// Принудительный полив нескольких зон
app.post('/api/zones/water/force', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const { zoneIds, startedByEmployee } = req.body || {};
    if (!Array.isArray(zoneIds) || !zoneIds.length) {
      return res.status(400).json({ error: 'zoneIds must be a non-empty array' });
    }

    const ids = Array.from(
      new Set(
        zoneIds
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && Number.isInteger(v)),
      ),
    );
    if (!ids.length) {
      return res.status(400).json({ error: 'zoneIds must contain numeric ids' });
    }

    const startedBy =
      startedByEmployee === undefined || startedByEmployee === null || startedByEmployee === ''
        ? null
        : startedByEmployee;

    // Сборка запроса выбранных зон для принудительного полива.
    const buildZonesSql = (techCol) =>
      `SELECT id_zone AS id, zone_name AS name, ${techCol} AS technology
       FROM zones
       WHERE id_zone IN (?)`;

    let zoneRows;
    try {
      [zoneRows] = await pool.query(buildZonesSql('id_technolog'), [ids]);
    } catch (e) {
      if (e?.code === 'ER_BAD_FIELD_ERROR') {
        try {
          [zoneRows] = await pool.query(buildZonesSql('id_tehnolog'), [ids]);
        } catch (inner) {
          if (inner?.code === 'ER_BAD_FIELD_ERROR') {
            [zoneRows] = await pool.query(buildZonesSql('id_technology'), [ids]);
          } else {
            throw inner;
          }
        }
      } else {
        throw e;
      }
    }

    const zoneMap = new Map(zoneRows.map((z) => [Number(z.id), z]));
    const results = [];

    for (const id of ids) {
      const zone = zoneMap.get(Number(id));
      if (!zone) {
        results.push({ id, ok: false, error: 'Zone not found' });
        continue;
      }

      let duration = null;
      if (zone.technology === 1) duration = 600;
      else if (zone.technology === 2) duration = 10;
      else {
        results.push({ id, ok: false, error: 'Unknown technology' });
        continue;
      }

      try {
        const [resultSets] = await pool.query(
          'CALL start_irrigation_for_zone(?, ?, ?, ?)',
          [id, 'MANUAL', duration, startedBy],
        );
        let runId = null;
        if (Array.isArray(resultSets)) {
          for (const set of resultSets) {
            if (Array.isArray(set) && set.length && set[0]?.id_run != null) {
              runId = set[0].id_run;
              break;
            }
          }
        }
        results.push({ id, ok: true, runId });
      } catch (err) {
        results.push({ id, ok: false, error: err?.message || 'Failed to start irrigation' });
      }
    }

    const success = results.filter((r) => r.ok).length;
    const failed = results.length - success;
    res.json({ ok: failed === 0, success, failed, results });
  } catch (err) {
    next(err);
  }
});

// Последние измерения по зоне
app.get('/api/zones/:id/measurements', async (req, res) => {
  const pool = await poolPromise;
  const zoneId = Number(req.params.id);
  if (!Number.isFinite(zoneId)) return res.status(400).json({ error: 'Invalid zone id' });
  const rawHours = Number(req.query.hours);
  const hours = Number.isFinite(rawHours) ? Math.min(Math.max(Math.ceil(rawHours), 1), 72) : 1;
  const cutoff = new Date(Date.now() - hours * HOUR_MS);
  // Сборка запроса последних измерений по зоне.
  const buildQuery = (table) => `SELECT m.timestamp AS ts,
            m.value,
            m.id_parameter AS parameter_id,
            p.name_parameter AS parameter_name,
            m.id_sensors AS sensor_id,
            m.id_zone AS zone_id
     FROM ${table} m
     LEFT JOIN parameters p ON p.id_parameter = m.id_parameter
     WHERE m.timestamp >= ?
       AND (m.id_zone = ? OR m.id_zone IS NULL)
       AND m.id_parameter IN (1, 2, 3)
     ORDER BY m.timestamp ASC`;
  let rows = [];
  try {
    [rows] = await pool.query(buildQuery('sensors_measurements'), [cutoff, zoneId]);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      [rows] = await pool.query(buildQuery('sensor_measurements'), [cutoff, zoneId]);
    } else {
      throw e;
    }
  }
  const hasZoneRows = rows.some((r) => Number(r.zone_id) === zoneId);
  let filtered = hasZoneRows
    ? rows.filter((r) => Number(r.zone_id) === zoneId)
    : rows.filter((r) => r.zone_id === null || r.zone_id === undefined);
  if (!hasZoneRows && tempScenario.active && Array.isArray(tempScenario.history) && tempScenario.history.length) {
    const startedAt = tempScenario.startedAt ? new Date(tempScenario.startedAt).getTime() : null;
    const scenarioTemps = tempScenario.history.map((h) => ({
        ts: new Date(h.ts),
        value: h.value,
        parameter_id: AIR_TEMP_PARAM_ID,
        parameter_name: 'temperature',
        sensor_id: h.sensorId ?? tempScenario.sensorId ?? null,
        zone_id: null,
      }));
    const normalTemps = rows.filter((r) => {
      if (Number(r.parameter_id) !== AIR_TEMP_PARAM_ID) return false;
      if (!startedAt) return true;
      const ts = new Date(r.ts).getTime();
      return Number.isNaN(ts) ? false : ts < startedAt;
    });
    filtered = rows.filter((r) => Number(r.parameter_id) !== AIR_TEMP_PARAM_ID);
    filtered = filtered
      .concat(normalTemps, scenarioTemps)
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  }
  const keyById = {
    1: 'temperature',
    2: 'humidity',
    3: 'co2',
    10: 'ndvi',
    11: 'ndvi',
  };
  res.json(
    filtered.map((r) => {
      const pid = Number(r.parameter_id);
      const key = keyById[pid] || r.parameter_name;
      return { ...r, parameter_name: key, parameter_key: key };
    }),
  );
});

// Значения NDVI по зоне
app.get('/api/zones/:id/ndvi', async (req, res) => {
  const pool = await poolPromise;
  const { id } = req.params;
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 200;
  const hasNdvi = (await getColumns(pool, 'ndvi')).length > 0;
  if (hasNdvi) {
    const [rows] = await pool.query(
      `SELECT timestamp AS ts, ndvi_value AS value
       FROM ndvi
       WHERE id_zone=?
       ORDER BY timestamp DESC
       LIMIT ${limit}`,
      [id],
    );
    if (rows.length) return res.json(rows);
  }

  const query = `SELECT timestamp AS ts, value
                 FROM sensors_measurements
                 WHERE id_zone = ? AND id_parameter IN (${buildInList(NDVI_PARAM_IDS)})
                 ORDER BY timestamp DESC
                 LIMIT ${limit}`;
  try {
    const [rows] = await pool.query(query, [id, ...NDVI_PARAM_IDS]);
    return res.json(rows);
  } catch (e) {
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      const fallback = query.replace('sensors_measurements', 'sensor_measurements');
      const [rows] = await pool.query(fallback, [id, ...NDVI_PARAM_IDS]);
      return res.json(rows);
    }
    throw e;
  }
});

// Датчики
app.get('/api/sensors', async (req, res) => {
  const pool = await poolPromise;
  const { q, parameter } = req.query;
  const conditions = [];
  const params = [];

  if (q) {
    conditions.push('(s.name_sensor LIKE ? OR s.id_sensor LIKE ? OR s.sensor_serial_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (parameter) {
    conditions.push('(p.name_parameter LIKE ? OR p.id_parameter = ?)');
    params.push(`%${parameter}%`, parameter);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT s.id_sensor AS id,
            s.sensor_serial_number AS serial,
            s.name_sensor AS name,
            p.name_parameter AS parameter,
            u.unit_name AS unit,
            s.min_value AS min,
            s.max_value AS max
     FROM sensors s
     LEFT JOIN parameters p ON p.id_parameter = s.id_parameterss
     LEFT JOIN units u ON u.id_unit = s.id_units
     ${where}`,
    params,
  );
  res.json(rows.map((r) => ({ ...r, zoneId: null })));
});

// Исполнительные устройства
app.get(['/api/actuators', '/api/acuators'], async (req, res, next) => {
  const pool = await poolPromise;
  const { q } = req.query;
  const conditions = [];
  const params = [];
  if (q) {
    conditions.push('(name_actuator LIKE ? OR id_actuator LIKE ? OR type_actuators LIKE ? OR actuators_serial_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const [rows] = await pool.query(`SELECT * FROM actuators ${where} ORDER BY id_actuator`, params);
    res.json(rows.map(normalizeActuator));
  } catch (err) {
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      try {
        const [rows] = await pool.query(`SELECT * FROM acuators ${where}`, params);
        res.json(rows.map(normalizeActuator));
        return;
      } catch (inner) {
        next(inner);
        return;
      }
    }
    next(err);
  }
});

// Параметры системы
app.get('/api/parameters', async (_req, res, next) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.query(
      `SELECT p.id_parameter AS id,
              p.name_parameter AS name,
              COALESCE(MIN(su.unit_name), pu.unit_name, ru.unit_name) AS unit,
              COALESCE(rv.min_value, MIN(s.min_value)) AS ref_min,
              COALESCE(rv.max_value, MAX(s.max_value)) AS ref_max
       FROM parameters p
       LEFT JOIN sensors s ON s.id_parameterss = p.id_parameter
       LEFT JOIN reference_values rv ON rv.id_parameters = p.id_parameter
       LEFT JOIN units ru ON ru.id_unit = rv.id_unit_values
       LEFT JOIN units pu ON pu.id_unit = p.id_unit
       LEFT JOIN units su ON su.id_unit = s.id_units
       GROUP BY p.id_parameter, p.name_parameter, ru.unit_name, pu.unit_name, rv.min_value, rv.max_value
       ORDER BY p.id_parameter`,
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Уставки по идентификатору параметра
app.get('/api/parameters/:id/reference', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const paramId = Number(req.params.id);
    if (Number.isNaN(paramId)) return res.status(400).json({ error: 'Invalid parameter id' });
    const cols = await getColumns(pool, 'reference_values');
    const idCol = cols.includes('id_parameter') ? 'id_parameter' : cols.includes('id_parameters') ? 'id_parameters' : null;
    if (!idCol) return res.status(500).json({ error: 'reference_values: нет поля id_parameter/id_parameters' });
    const orderField = cols.includes('id_reference_values')
      ? 'id_reference_values'
      : cols.includes('id_reference')
        ? 'id_reference'
        : cols.includes('id')
          ? 'id'
          : cols.includes('timestamp')
            ? 'timestamp'
            : idCol;
    const [rows] = await pool.query(
      `SELECT min_value, max_value
       FROM reference_values
       WHERE ${idCol} = ?
       ORDER BY ${orderField} DESC
       LIMIT 1`,
      [paramId],
    );
    if (!rows.length) return res.json({ id: paramId, ref_min: null, ref_max: null });
    res.json({
      id: paramId,
      ref_min: rows[0].min_value,
      ref_max: rows[0].max_value,
    });
  } catch (err) {
    next(err);
  }
});

// Обновление уставок и запись действия в журнал
app.post('/api/reference', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const { parameterId, min_value, max_value, employeeId } = req.body || {};
    const paramId = Number(parameterId);
    const min = Number(min_value);
    const max = Number(max_value);
    if (Number.isNaN(paramId) || Number.isNaN(min) || Number.isNaN(max)) {
      return res.status(400).json({ error: 'Минимум/максимум должны быть числами' });
    }
    if (min > max) {
      return res.status(400).json({ error: 'Минимум не может быть больше максимума' });
    }
    const cols = await getColumns(pool, 'reference_values');
    const idCol = cols.includes('id_parameter') ? 'id_parameter' : cols.includes('id_parameters') ? 'id_parameters' : null;
    if (!idCol) return res.status(500).json({ error: 'reference_values: нет поля id_parameter/id_parameters' });
    let paramName = '';
    try {
      const [pinfo] = await pool.query('SELECT name_parameter FROM parameters WHERE id_parameter = ? LIMIT 1', [paramId]);
      paramName = pinfo?.[0]?.name_parameter || '';
    } catch (e) {
      paramName = '';
    }
    const [upd] = await pool.query(
      `UPDATE reference_values
       SET min_value = ?, max_value = ?
       WHERE ${idCol} = ?`,
      [min, max, paramId],
    );
    if (upd.affectedRows === 0) {
      await pool.query(
        `INSERT INTO reference_values (${idCol}, min_value, max_value)
         VALUES (?, ?, ?)`,
        [paramId, min, max],
      );
    }
    if (employeeId != null) {
      const actionText = paramName
        ? `Изменение диапазона "${paramName}"`
        : `Изменение диапазона параметра ${paramId}`;
      await logAction(pool, { employeeId, parameterId: paramId, actionText });
      await logAudit(pool, { employeeId, action: actionText });
    }
    await startHumidityRecoveryAfterTemperatureReferenceUpdate(pool, paramId);
    res.json({ ok: true, parameterId: paramId, min_value: min, max_value: max });
  } catch (err) {
    next(err);
  }
});

// Журнал ошибок
app.get('/api/errors', async (_req, res) => {
  const pool = await poolPromise;
  const cols = await getColumns(pool, 'sensor_error');
  const severityCol = cols.find((c) => ['severity', 'level', 'status', 'priority'].includes(c));
  const severitySelect = severityCol ? `se.${severityCol} AS severity` : `'warning' AS severity`;
  const [rows] = await pool.query(
    `SELECT se.id_sensor_error AS id,
            se.timestamp AS ts,
            se.error_code AS code,
            se.error_name AS text,
            ${severitySelect},
            se.id_sensor_number AS sensorId,
            s.id_parameterss AS sensorParameterId,
            p.name_parameter AS parameter,
            u.unit_name AS sensorUnit
     FROM sensor_error se
     LEFT JOIN sensors s ON s.id_sensor = se.id_sensor_number
     LEFT JOIN parameters p ON p.id_parameter = s.id_parameterss
     LEFT JOIN units u ON u.id_unit = s.id_units
     ORDER BY se.timestamp DESC
     LIMIT 100`,
  );
  let enriched = rows;
  try {
    const pairs = rows
      .map((r) => ({ sensorId: r.sensorId, ts: r.ts }))
      .filter((p) => p.sensorId && p.ts);
    const measurements = await fetchMeasurementsByPairs(pool, pairs);
    const measurementMap = new Map();
    measurements.forEach((m) => {
      const key = measurementKey(m.sensor_id, m.ts);
      if (!key) return;
      const list = measurementMap.get(key) || [];
      list.push(m);
      measurementMap.set(key, list);
    });
    const codeParamIds = rows
      .map((r) => parameterIdFromErrorCode(r.code))
      .filter(Boolean);
    const sensorParamIds = rows
      .map((r) => r.sensorParameterId)
      .filter(Boolean);
    const paramIds = [
      ...new Set([
        ...measurements.map((m) => m.id_parameter).filter(Boolean),
        ...codeParamIds,
        ...sensorParamIds,
      ]),
    ];
    const refMap = new Map();
    if (paramIds.length) {
      const refCols = await getColumns(pool, 'reference_values');
      const idCol = refCols.includes('id_parameter')
        ? 'id_parameter'
        : refCols.includes('id_parameters')
          ? 'id_parameters'
          : null;
      if (idCol) {
        const placeholders = paramIds.map(() => '?').join(',');
        const [refs] = await pool.query(
          `SELECT rv.${idCol} AS id_parameter,
                  rv.min_value,
                  rv.max_value,
                  u.unit_name AS unit
           FROM reference_values rv
           LEFT JOIN units u ON u.id_unit = rv.id_unit_values
           WHERE rv.${idCol} IN (${placeholders})`,
          paramIds,
        );
        refs.forEach((r) => refMap.set(Number(r.id_parameter), r));
      }
    }
    enriched = rows.map((r) => {
      let severity = r.severity || 'warning';
      let value = null;
      let parameterId = null;
      let refMin = null;
      let refMax = null;
      let unit = r.sensorUnit ?? null;
      let parameter = r.parameter ?? null;
      const knownAlert = knownAlertByCode(r.code);
      const expectedParameterId = knownAlert?.parameterId ?? parameterIdFromErrorCode(r.code) ?? r.sensorParameterId;
      if (expectedParameterId) {
        parameterId = expectedParameterId;
        const ref = refMap.get(Number(parameterId));
        refMin = ref?.min_value ?? null;
        refMax = ref?.max_value ?? null;
        unit = ref?.unit ?? unit;
      }
      if (knownAlert) {
        severity = knownAlert.severity;
        parameterId = knownAlert.parameterId;
        const ref = refMap.get(Number(parameterId));
        refMin = ref?.min_value ?? null;
        refMax = ref?.max_value ?? null;
        unit = ref?.unit ?? unit;
      }
      const key = measurementKey(r.sensorId, r.ts);
      const measurementList = key ? measurementMap.get(key) || [] : [];
      const measurement =
        measurementList.find((m) => expectedParameterId && Number(m.id_parameter) === Number(expectedParameterId)) ||
        measurementList.find((m) => {
          const ref = refMap.get(Number(m.id_parameter));
          return !!getDeviationSeverity(m.value, ref?.min_value, ref?.max_value);
        }) ||
        measurementList[0] ||
        null;
      if (measurement) {
        value = measurement.value;
        parameterId = measurement.id_parameter;
        const ref = refMap.get(Number(measurement.id_parameter));
        refMin = ref?.min_value ?? null;
        refMax = ref?.max_value ?? null;
        unit = ref?.unit ?? null;
        parameter = r.parameter ?? parameter;
        if (!knownAlert) {
          const computed = getDeviationSeverity(measurement.value, ref?.min_value, ref?.max_value);
          if (computed) severity = computed;
        }
      }
      return { ...r, severity, value, parameterId, parameter, refMin, refMax, unit };
    });
  } catch (e) {
    console.error('errors severity calc error', e);
  }
  res.json(enriched.map((r) => ({ ...r, zoneId: null })));
});

// Отчет по выбранному параметру: последние измерения
app.get('/api/report', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const { parameter } = req.query;
    let where = '';
    let params = [];

    // Определение параметра по id или по имени
    let paramRow = null;
    if (parameter) {
      const idNum = Number(parameter);
      if (!Number.isNaN(idNum)) {
        const [info] = await pool.query('SELECT id_parameter, name_parameter FROM parameters WHERE id_parameter = ? LIMIT 1', [idNum]);
        paramRow = info?.[0] || null;
      } else {
        const [info] = await pool.query('SELECT id_parameter, name_parameter FROM parameters WHERE name_parameter LIKE ? LIMIT 1', [`%${parameter}%`]);
        paramRow = info?.[0] || null;
      }
    }

    if (paramRow?.id_parameter) {
      where = 'WHERE p.id_parameter = ?';
      params = [paramRow.id_parameter];
    } else if (parameter) {
      where = 'WHERE p.name_parameter LIKE ?';
      params = [`%${parameter}%`];
    }

    let metaRow = {};
    try {
      const refCols = await getColumns(pool, 'reference_values');
      const refIdCol = refCols.includes('id_parameter')
        ? 'id_parameter'
        : refCols.includes('id_parameters')
          ? 'id_parameters'
          : null;
      const refJoin = refIdCol
        ? `LEFT JOIN reference_values rv ON rv.${refIdCol} = p.id_parameter`
        : '';
      const refMinExpr = refIdCol ? 'COALESCE(rv.min_value, MIN(s.min_value))' : 'MIN(s.min_value)';
      const refMaxExpr = refIdCol ? 'COALESCE(rv.max_value, MAX(s.max_value))' : 'MAX(s.max_value)';
      const refGroup = refIdCol ? ', rv.min_value, rv.max_value' : '';
      const [info] = await pool.query(
        `SELECT p.id_parameter AS id,
                p.name_parameter AS name,
                u2.unit_name AS unit,
                ${refMinExpr} AS ref_min,
                ${refMaxExpr} AS ref_max
         FROM parameters p
         LEFT JOIN sensors s ON s.id_parameterss = p.id_parameter
         LEFT JOIN units u2 ON u2.id_unit = s.id_units
         ${refJoin}
         ${where}
         GROUP BY p.id_parameter, p.name_parameter, u2.unit_name${refGroup}
         LIMIT 1`,
        params,
      );
      metaRow = info?.[0] || {};
    } catch (e) {
      metaRow = {};
    }
    const sensorZoneCol = await resolveSensorZoneColumn(pool);
    const sensorZoneExpr = sensorZoneCol ? `s.${sensorZoneCol}` : 'NULL';
    const zoneExpr = sensorZoneCol ? `COALESCE(m.id_zone, ${sensorZoneExpr})` : 'm.id_zone';

    // Лимит выборки: NDVI - 24, EC - 100, остальные - 300
    const nameLower = (metaRow.name || parameter || '').toString().toLowerCase();
    const requestedParamId = Number(parameter);
    const resolvedParamId = Number.isFinite(requestedParamId)
      ? Number(paramRow?.id_parameter ?? metaRow.id ?? requestedParamId)
      : Number(paramRow?.id_parameter ?? metaRow.id);
    let limit = 300;
    let timeFilter = '';
    let enforceSlice = null;
    let timeParams = [];
    const isNdviParamId = Number.isFinite(resolvedParamId) && NDVI_PARAM_IDS.includes(resolvedParamId);
    const isNdvi = nameLower.includes('ndvi') || isNdviParamId;
    const isEc = nameLower.includes('электропровод') || nameLower.includes('ec');
    const isHydro = nameLower.includes('гидроп') || nameLower.includes('раствор');
    const isAero = nameLower.includes('аэропон');
    const isHydroWindowParam =
      Number.isFinite(resolvedParamId) && HYDRO_PARAM_IDS.includes(resolvedParamId);
    const isAeroWindowParam =
      Number.isFinite(resolvedParamId) && AERO_PARAM_IDS.includes(resolvedParamId);
    const isHydroPressureName = nameLower.includes('давлен') && nameLower.includes('подач');
    const isAirTempParam =
      Number.isFinite(resolvedParamId)
        ? resolvedParamId === AIR_TEMP_PARAM_ID
        : nameLower.includes('температура воздуха');
    const isAirHumidityParam =
      Number.isFinite(resolvedParamId)
        ? resolvedParamId === 2
        : nameLower.includes('влажность воздуха');
    const isCo2Param =
      Number.isFinite(resolvedParamId)
        ? resolvedParamId === 3
        : nameLower.includes('углекисл') || nameLower.includes('co2');
    const usePerZoneSeries = isHydroWindowParam || isHydroPressureName || (isEc && isHydro);
    const wantPerZoneSeries = usePerZoneSeries && Number.isFinite(resolvedParamId);
    if (isNdvi) {
      limit = 5000;
      enforceSlice = null;
      timeFilter = ' AND m.timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)';
    } else if (!wantPerZoneSeries && (isHydroWindowParam || isHydroPressureName || (isEc && isHydro))) {
      limit = 300;
      const window = await getHydroWindow(pool);
      if (window?.start && window?.end) {
        timeFilter = ' AND m.timestamp BETWEEN ? AND ?';
        // Передача даты в SQL без дополнительного преобразования.
        const toSqlParam = (v) => v;
        timeParams = [toSqlParam(window.start), toSqlParam(window.end)];
      }
    } else if (isAeroWindowParam || isAero || (isEc && isAero)) {
      limit = Math.max(300, AERO_WINDOW_SECONDS * 4);
      const window = await getAeroWindow(pool);
      if (window?.start && window?.end) {
        timeFilter = ' AND m.timestamp BETWEEN ? AND ?';
        // Передача даты в SQL без дополнительного преобразования.
        const toSqlParam = (v) => v;
        timeParams = [toSqlParam(window.start), toSqlParam(window.end)];
      }
      } else if (isEc) {
      limit = 50;
      timeFilter = ' AND m.timestamp >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)';
    }

    let rows = [];
    if (wantPerZoneSeries) {
      const window = await getHydroWindow(pool);
      rows = await fetchHydroPerMinuteSeries(pool, { paramId: resolvedParamId, window });
    } else {
      [rows] = await pool.query(
        `SELECT m.timestamp AS ts,
                m.value,
                p.name_parameter AS name,
                u.unit_name AS unit,
                ${zoneExpr} AS zone_id,
                z.zone_name AS zone_name
         FROM sensors_measurements m
         LEFT JOIN parameters p ON p.id_parameter = m.id_parameter
         LEFT JOIN sensors s ON s.id_sensor = m.id_sensors
         LEFT JOIN units u ON u.id_unit = s.id_units
         LEFT JOIN zones z ON z.id_zone = ${zoneExpr}
         ${where ? `${where} ${timeFilter}` : timeFilter ? `WHERE 1=1 ${timeFilter}` : ''}
         ORDER BY m.timestamp DESC
         LIMIT ${limit}`,
        [...params, ...timeParams],
      ).catch(async (e) => {
        if (e?.code === 'ER_NO_SUCH_TABLE') {
          const [fallback] = await pool.query(
            `SELECT m.timestamp AS ts,
                    m.value,
                    p.name_parameter AS name,
                    u.unit_name AS unit,
                    ${zoneExpr} AS zone_id,
                    z.zone_name AS zone_name
             FROM sensor_measurements m
             LEFT JOIN parameters p ON p.id_parameter = m.id_parameter
             LEFT JOIN sensors s ON s.id_sensor = m.id_sensors
             LEFT JOIN units u ON u.id_unit = s.id_units
             LEFT JOIN zones z ON z.id_zone = ${zoneExpr}
             ${where ? `${where} ${timeFilter}` : timeFilter ? `WHERE 1=1 ${timeFilter}` : ''}
             ORDER BY m.timestamp DESC
             LIMIT ${limit}`,
            [...params, ...timeParams],
          );
          return fallback;
        }
        throw e;
      });
    }
    let finalRows = rows;

    // NDVI: формирование 24 почасовых точек (00 минут каждого часа) по каждой зоне
    if (isNdvi) {
      const hourMs = 60 * 60 * 1000;
      const now = new Date();
      now.setMinutes(0, 0, 0);

      const zoneBuckets = new Map();
      const zoneNames = new Map();
      rows.forEach((r) => {
        const zoneId = r.zone_id ?? null;
        if (zoneId == null) return;
        const ts = new Date(r.ts);
        const value = Number(r.value);
        if (Number.isNaN(ts.getTime()) || Number.isNaN(value)) return;
        const hour = new Date(ts);
        hour.setMinutes(0, 0, 0);
        const key = hour.getTime();
        const zoneMap = zoneBuckets.get(zoneId) || new Map();
        const bucket = zoneMap.get(key) || { sum: 0, count: 0 };
        bucket.sum += value;
        bucket.count += 1;
        zoneMap.set(key, bucket);
        zoneBuckets.set(zoneId, zoneMap);
        if (!zoneNames.has(zoneId)) {
          zoneNames.set(zoneId, r.zone_name || `Зона ${zoneId}`);
        }
      });

      if (!zoneNames.size) {
        // Построение одной общей линии при отсутствии данных по зонам
        const hourly = new Map();
        rows.forEach((r) => {
          const ts = new Date(r.ts);
          const value = Number(r.value);
          if (Number.isNaN(ts.getTime()) || Number.isNaN(value)) return;
          const hour = new Date(ts);
          hour.setMinutes(0, 0, 0);
          const key = hour.getTime();
          const bucket = hourly.get(key) || { sum: 0, count: 0 };
          bucket.sum += value;
          bucket.count += 1;
          hourly.set(key, bucket);
        });
        const hourlyValues = new Map();
        hourly.forEach((b, key) => {
          hourlyValues.set(key, b.count ? b.sum / b.count : null);
        });
        const sortedKeys = Array.from(hourlyValues.keys()).sort((a, b) => a - b);
        const fallbackValue = sortedKeys.length > 0 ? hourlyValues.get(sortedKeys[0]) : null;
        let lastValue = null;
        const points = [];
        for (let i = 23; i >= 0; i -= 1) {
          const ts = new Date(now.getTime() - i * hourMs);
          const key = ts.getTime();
          let value = hourlyValues.get(key);
          if (value == null) {
            if (lastValue != null) value = lastValue;
            else if (fallbackValue != null) value = fallbackValue;
          }
          if (value != null) lastValue = value;
          points.push({
            ts,
            value,
            name: metaRow.name || rows?.[0]?.name || parameter || 'NDVI',
            unit: metaRow.unit || rows?.[0]?.unit || null,
            zone_id: null,
            zone_name: null,
          });
        }
        finalRows = points;
      } else {
        const points = [];
        zoneNames.forEach((zoneName, zoneId) => {
          const zoneMap = zoneBuckets.get(zoneId) || new Map();
          const hourlyValues = new Map();
          zoneMap.forEach((b, key) => {
            hourlyValues.set(key, b.count ? b.sum / b.count : null);
          });
          const sortedKeys = Array.from(hourlyValues.keys()).sort((a, b) => a - b);
          const fallbackValue = sortedKeys.length > 0 ? hourlyValues.get(sortedKeys[0]) : null;
          let lastValue = null;
          for (let i = 23; i >= 0; i -= 1) {
            const ts = new Date(now.getTime() - i * hourMs);
            const key = ts.getTime();
            let value = hourlyValues.get(key);
            if (value == null) {
              if (lastValue != null) value = lastValue;
              else if (fallbackValue != null) value = fallbackValue;
            }
            if (value != null) lastValue = value;
            points.push({
              ts,
              value,
              name: metaRow.name || rows?.[0]?.name || parameter || 'NDVI',
              unit: metaRow.unit || rows?.[0]?.unit || null,
              zone_id: zoneId,
              zone_name: zoneName,
            });
          }
        });
        finalRows = points;
      }
    } else {
      if (isAirTempParam && !wantPerZoneSeries && REPORT_AIR_TEMP_AGG_MS) {
        finalRows = aggregateRowsByInterval(rows, REPORT_AIR_TEMP_AGG_MS);
      } else if (isAirHumidityParam && !wantPerZoneSeries && REPORT_AIR_HUMID_AGG_MS) {
        finalRows = aggregateRowsByInterval(rows, REPORT_AIR_HUMID_AGG_MS);
      } else if (isCo2Param && !wantPerZoneSeries && REPORT_CO2_AGG_MS) {
        finalRows = aggregateRowsByInterval(rows, REPORT_CO2_AGG_MS);
      }
      let sliceCount = enforceSlice;
      const nameSource = finalRows?.[0]?.name || rows?.[0]?.name || '';
      const effectiveName = nameLower || nameSource.toString().toLowerCase();
      if (sliceCount == null && effectiveName.includes('ndvi')) {
        sliceCount = 24;
      }
      const sourceRows = finalRows;
      finalRows =
        sliceCount != null
          ? sourceRows
              .slice()
              .sort((a, b) => new Date(b.ts) - new Date(a.ts))
              .slice(0, sliceCount)
              .sort((a, b) => new Date(a.ts) - new Date(b.ts))
          : sourceRows;
    }

    const series = finalRows.map((r) => ({
      ts: r.ts,
      value: r.value,
      name: r.name,
      unit: r.unit,
      zoneId: r.zone_id ?? null,
      zoneName: r.zone_name ?? null,
    }));
    const values = series.map((s) => Number(s.value)).filter((v) => !Number.isNaN(v));
    const stats = {
      count: values.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    };
    res.json({
      parameter: parameter || null,
      name: metaRow.name || series[0]?.name || parameter || null,
      unit: metaRow.unit || series[0]?.unit || null,
      refMin: metaRow.ref_min ?? null,
      refMax: metaRow.ref_max ?? null,
      series,
      stats,
    });
  } catch (err) {
    next(err);
  }
});

// Главная панель: последние показания и ошибки
app.get('/api/dashboard', async (_req, res) => {
  const pool = await poolPromise;
  const snapshot = await buildDashboardSnapshot(pool);
  res.json({ aggregates: snapshot.aggregates, errors: snapshot.errors });
});

// Главная панель с временем последнего обновления
app.get('/api/dashboard2', async (_req, res) => {
  const pool = await poolPromise;
  const snapshot = await buildDashboardSnapshot(pool);
  res.json(snapshot);
});

// Последние измерения с информацией о параметрах
app.get('/api/measurements', async (_req, res, next) => {
  try {
    const pool = await poolPromise;
    const cols = await getColumns(pool, 'reference_values');
    const idRefCol = cols.includes('id_parameter') ? 'id_parameter' : cols.includes('id_parameters') ? 'id_parameters' : null;
    const displayLimit = 100;
    const baseLimit = tempScenario.active ? 300 : displayLimit;
    // Сборка запроса последних измерений для общей таблицы параметров.
    const buildQuery = (table) => {
      const indexHint = table === 'sensors_measurements' ? 'FORCE INDEX (idx_measurements_timestamp)' : '';
      return `SELECT m.id,
              m.ts,
              m.value,
              m.id_parameter,
              m.sensor_id,
              m.id_zone AS zone_id,
              z.zone_name AS zone,
              p.name_parameter AS parameter,
              u.unit_name AS unit${idRefCol ? `,
              (SELECT rv.min_value
                 FROM reference_values rv
                 WHERE rv.${idRefCol} = m.id_parameter
                 LIMIT 1) AS ref_min,
              (SELECT rv.max_value
                 FROM reference_values rv
                 WHERE rv.${idRefCol} = m.id_parameter
                 LIMIT 1) AS ref_max` : ''}
       FROM (
         SELECT id_measurements AS id,
                timestamp AS ts,
                value,
                id_parameter,
                id_sensors AS sensor_id,
                id_zone
         FROM ${table} ${indexHint}
         ORDER BY timestamp DESC
         LIMIT ${baseLimit}
       ) m
       LEFT JOIN parameters p ON p.id_parameter = m.id_parameter
       LEFT JOIN sensors s ON s.id_sensor = m.sensor_id
       LEFT JOIN zones z ON z.id_zone = m.id_zone
       LEFT JOIN units u ON u.id_unit = s.id_units
       ORDER BY m.ts DESC`;
    };
    let rows = [];
    try {
      [rows] = await pool.query(buildQuery('sensors_measurements'));
    } catch (e) {
      if (e?.code === 'ER_NO_SUCH_TABLE') {
        const [altRows] = await pool.query(buildQuery('sensor_measurements'));
        rows = altRows;
      } else {
        throw e;
      }
    }
    const hasScenarioHistory =
      tempScenario.active && Array.isArray(tempScenario.history) && tempScenario.history.length;
    if (hasScenarioHistory) {
      const tempMeta = rows.find((row) => Number(row.id_parameter) === AIR_TEMP_PARAM_ID) || null;
      let refMin = tempMeta?.ref_min ?? null;
      let refMax = tempMeta?.ref_max ?? null;
      if (refMin == null || refMax == null) {
        const range = await getReferenceRange(pool, AIR_TEMP_PARAM_ID);
        if (refMin == null) refMin = range.min;
        if (refMax == null) refMax = range.max;
      }
      const parameter = tempMeta?.parameter ?? 'Температура воздуха';
      const unit = tempMeta?.unit ?? '°C';
      const scenarioRows = tempScenario.history.map((h) => ({
        id: null,
        ts: new Date(h.ts),
        value: h.value,
        id_parameter: AIR_TEMP_PARAM_ID,
        sensor_id: h.sensorId ?? tempScenario.sensorId ?? null,
        zone_id: h.zoneId ?? tempScenario.zoneId ?? null,
        zone: null,
        parameter,
        unit,
        ref_min: refMin,
        ref_max: refMax,
      }));
      rows = rows
        .filter((row) => Number(row.id_parameter) !== AIR_TEMP_PARAM_ID)
        .concat(scenarioRows)
        .sort((a, b) => new Date(b.ts) - new Date(a.ts))
        .slice(0, displayLimit);
    } else if (rows?.length && tempScenario.active) {
      const sampleKeys = tempScenario.sampleKeys;
      if (sampleKeys && sampleKeys.size) {
        rows = rows.filter((row) => {
          if (Number(row.id_parameter) !== AIR_TEMP_PARAM_ID) return true;
          const key = measurementKey(row.sensor_id, row.ts);
          return key ? sampleKeys.has(key) : false;
        });
      }
      rows = rows.slice(0, displayLimit);
    }
    if (rows?.length) {
      for (const row of rows) {
        const min = row.ref_min;
        const max = row.ref_max;
        const val = Number(row.value);
        const outLow = min != null && !Number.isNaN(val) && val < Number(min);
        const outHigh = max != null && !Number.isNaN(val) && val > Number(max);
        if (!outLow && !outHigh) continue;
        if (!row.sensor_id) continue;
        const code = `OUT-${row.id_parameter}`;
        const name = `Вне диапазона: ${row.parameter ?? row.id_parameter}`;
        const duplicateCodes = [code];
        if (Number(row.id_parameter) === 2) duplicateCodes.push('Warning_Hum', 'Alarm_Hum');
        if (Number(row.id_parameter) === 3) duplicateCodes.push('Warning_CO2', 'Alarm_CO2');
        try {
          const codePlaceholders = duplicateCodes.map(() => '?').join(',');
          const [exists] = await pool.query(
            `SELECT id_sensor_error
             FROM sensor_error
             WHERE id_sensor_number = ? AND timestamp = ? AND error_code IN (${codePlaceholders})
             LIMIT 1`,
            [row.sensor_id, row.ts, ...duplicateCodes],
          );
          if (!exists.length) {
            await pool.query(
              `INSERT INTO sensor_error (error_code, error_name, timestamp, id_sensor_number)
               VALUES (?, ?, ?, ?)`,
              [code, name, row.ts, row.sensor_id],
            );
          }
        } catch (e) {
          console.error('sensor_error insert error', e);
        }
      }
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Управление температурным сценарием
app.post('/api/sim/temperature/heating', (req, res) => {
  const on = req.body?.on;
  tempScenario.heatingOn = on === undefined || on === null ? true : !!on;
  if (tempScenario.heatingOn && tempScenario.phase === 'waiting_heat') {
    tempScenario.phase = 'heating';
  }
  res.json({ ok: true, heating: tempScenario.heatingOn, phase: tempScenario.phase });
});

app.post('/api/sim/temperature/reset', (_req, res) => {
  stopNormalTemperatureGenerator();
  resetTempScenario();
  startTempScenario();
  res.json({ ok: true });
});

app.post('/api/sim/temperature/active', (req, res) => {
  const active = req.body?.active;
  const enabled = active === undefined || active === null ? true : !!active;
  if (enabled) {
    tempScenario.active = true;
    stopNormalTemperatureGenerator();
    resetTempScenario();
    startTempScenario();
  } else {
    stopTempScenario();
    startNormalTemperatureGenerator();
  }
  res.json({ ok: true, active: tempScenario.active, phase: tempScenario.phase });
});

app.get('/api/sim/temperature/status', (_req, res) => {
  res.json({ active: tempScenario.active, phase: tempScenario.phase });
});

// Авторизация сотрудника по имени, фамилии и паролю
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const pool = await poolPromise;
    const { firstName, lastName, password } = req.body || {};
    const first = normalizeSpace(firstName);
    const last = normalizeSpace(lastName);
    const pass = String(password || '');
    if (!first || !last || !pass) {
      return res.status(400).json({ error: 'Введите имя, фамилию и пароль' });
    }

    const cols = await getColumns(pool, 'employee');
    if (!cols.length) return res.status(500).json({ error: 'employee: таблица не найдена' });
    const colMap = buildColumnMap(cols);

    const idCol = pickColumn(colMap, ['id_employee', 'employee_id', 'id', 'id_user', 'user_id']);
    const passCol = pickColumn(colMap, [
      'password',
      'pass',
      'pwd',
      'passwd',
      'employee_password',
      'user_password',
      'password_hash',
      'pass_hash',
      'hash',
    ]);
    if (!passCol) return res.status(500).json({ error: 'employee: нет колонки пароля' });

    const firstCol = pickColumn(colMap, [
      'first_name',
      'firstname',
      'name_first',
      'employee_first_name',
      'fname',
      'given_name',
    ]);
    const lastCol = pickColumn(colMap, [
      'last_name',
      'lastname',
      'surname',
      'family_name',
      'second_name',
      'employee_last_name',
      'lname',
    ]);
    const fullCols = pickColumns(colMap, [
      'employee_name',
      'name_employee',
      'full_name',
      'fio',
      'name',
      'fullname',
      'employee_fullname',
    ]);

    const conditions = [];
    const params = [];

    if (firstCol && lastCol) {
      conditions.push(`(LOWER(${firstCol}) = LOWER(?) AND LOWER(${lastCol}) = LOWER(?))`);
      params.push(first, last);
    }

    if (fullCols.length) {
      const likeParts = fullCols.map(
        (c) => `(LOWER(${c}) LIKE LOWER(?) AND LOWER(${c}) LIKE LOWER(?))`,
      );
      conditions.push(`(${likeParts.join(' OR ')})`);
      fullCols.forEach(() => params.push(`%${first}%`, `%${last}%`));
    }

    if (!conditions.length) {
      return res.status(500).json({ error: 'employee: нет колонок для имени/фамилии' });
    }

    const sql = `SELECT * FROM employee WHERE (${conditions.join(' OR ')}) LIMIT 20`;
    const [rows] = await pool.query(sql, params);
    if (!rows.length) return res.status(401).json({ error: 'Неверные данные' });

    let matched = null;
    for (const row of rows) {
      const stored = row?.[passCol];
      if (!stored) continue;
      if (verifyPassword(pass, stored)) {
        matched = row;
        break;
      }
    }
    if (!matched) return res.status(401).json({ error: 'Неверные данные' });

    const raw = matched || {};
    const id = raw[idCol] ?? raw.id_employee ?? raw.employee_id ?? raw.id ?? null;
    let name = null;
    for (const col of fullCols) {
      if (raw[col]) {
        name = raw[col];
        break;
      }
    }
    if (!name) {
      const firstVal = firstCol ? raw[firstCol] : null;
      const lastVal = lastCol ? raw[lastCol] : null;
      if (firstVal || lastVal) {
        name = `${firstVal ?? ''} ${lastVal ?? ''}`.trim();
      }
    }
    if (!name) {
      name =
        raw.employee_name ??
        raw.name_employee ??
        raw.full_name ??
        raw.fio ??
        raw.username ??
        raw.name ??
        null;
    }
    res.json({ id, name: name || `${first} ${last}`.trim() });
  } catch (err) {
    next(err);
  }
});

// Получение активного сотрудника
app.get('/api/employee/active', async (_req, res, next) => {
  try {
    const pool = await poolPromise;
    const [rows] = await pool.query('SELECT * FROM employee ORDER BY RAND() LIMIT 1');
    if (!rows.length) return res.status(404).json({ error: 'No employees' });
    const raw = rows[0] || {};
    const id = raw.id_employee ?? raw.employee_id ?? raw.id ?? null;
    const name =
      raw.employee_name ??
      raw.name_employee ??
      raw.full_name ??
      raw.fio ??
      raw.username ??
      raw.name ??
      (raw.first_name || raw.last_name ? `${raw.first_name ?? ''} ${raw.last_name ?? ''}`.trim() : null) ??
      null;
    res.json({ id, name: name || 'Дежурный сотрудник' });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Отправка сообщения всем подключенным WebSocket-клиентам.
const broadcast = (payload) => {
  if (!wss.clients.size) return;
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
};

let dashboardTimer = null;
let tempTimer = null;
let tempScenarioBusy = false;
let tempNormalTimer = null;
let ndviTimer = null;
let ndviBusy = false;
// Запуск периодической отправки данных главной панели.
const startDashboardBroadcast = () => {
  if (dashboardTimer) return;
  dashboardTimer = setInterval(async () => {
    if (!wss.clients.size) return;
    try {
      const pool = await poolPromise;
      const snapshot = await buildDashboardSnapshot(pool);
      broadcast({ type: 'dashboard', data: snapshot });
    } catch (e) {
      console.error('ws dashboard error', e);
    }
  }, 3000);
};

// Запуск таймера температурного сценария.
const startTempScenario = () => {
  if (tempTimer) return;
  // Выполнение одного запуска таймера температурного сценария.
  const run = async () => {
    if (tempScenarioBusy) return;
    tempScenarioBusy = true;
    try {
      const pool = await poolPromise;
      await tickTempScenario(pool);
      if (!tempScenario.active && tempTimer) {
        clearInterval(tempTimer);
        tempTimer = null;
      }
    } catch (e) {
      console.error('temp scenario error', e);
    } finally {
      tempScenarioBusy = false;
    }
  };
  tempTimer = setInterval(run, AIR_TEMP_SAMPLE_SECONDS * 1000);
  run();
};

// Запуск генерации обычной температуры без сценария.
const startNormalTemperatureGenerator = () => {
  if (tempNormalTimer || tempScenario.active) return;
  // Выполнение одного запуска генератора обычной температуры.
  const run = async () => {
    try {
      const pool = await poolPromise;
      await generateNormalTemperature(pool);
    } catch (e) {
      console.error('temp normal generator error', e);
    }
  };
  tempNormalTimer = setInterval(run, 60 * 1000);
  run();
};

// Остановка генератора обычной температуры.
const stopNormalTemperatureGenerator = () => {
  if (tempNormalTimer) {
    clearInterval(tempNormalTimer);
    tempNormalTimer = null;
  }
};

// Запуск генерации NDVI для графиков отчетности.
const startNdviGenerator = () => {
  if (ndviTimer) return;
  const run = async () => {
    if (ndviBusy) return;
    ndviBusy = true;
    try {
      const pool = await poolPromise;
      await writeStableHydroNdviSeries(pool);
      await writeAeroNdviSeries(pool);
    } catch (e) {
      console.error('ndvi generator error', e);
    } finally {
      ndviBusy = false;
    }
  };
  ndviTimer = setInterval(run, HOUR_MS);
  run();
};

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'welcome', ts: Date.now() }));
  ws.on('message', async (message) => {
    let payload = null;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return;
    }
    if (payload?.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }
    if (payload?.type === 'dashboard:once') {
      try {
        const pool = await poolPromise;
        const snapshot = await buildDashboardSnapshot(pool);
        ws.send(JSON.stringify({ type: 'dashboard', data: snapshot }));
      } catch (e) {
        console.error('ws dashboard once error', e);
      }
    }
  });
});

startDashboardBroadcast();
startNdviGenerator();
// Чтение данных из базы и запуск процедур полива на сервере.
startTempScenario();
startNormalTemperatureGenerator();

server.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});

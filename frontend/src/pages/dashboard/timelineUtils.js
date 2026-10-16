const HOUR_MS = 60 * 60 * 1000;
const SPECIAL_ALERTS = {
  humidity: {
    82: 'warning',
    86: 'danger',
  },
  co2: {
    1510: 'warning',
    1560: 'danger',
  },
};
const STATUS_RANK = { warning: 1, danger: 2 };

// Получение статуса специального предупреждения по значению.
function getSpecialAlertStatus(key, value) {
  const rounded = Number(value);
  if (!Number.isFinite(rounded)) return '';
  return SPECIAL_ALERTS[key]?.[rounded] || '';
}

// Запись специального предупреждения в временной интервал.
function setSpecialAlert(bucket, key, value) {
  const status = getSpecialAlertStatus(key, value);
  if (!status) return;
  const current = bucket.alertStatuses[key] || '';
  if ((STATUS_RANK[status] ?? 0) >= (STATUS_RANK[current] ?? 0)) {
    bucket.alertStatuses[key] = status;
    bucket.alertValues[key] = value;
  }
}

/** Формирование поминутной шкалы микроклимата за последний час. */
export function buildTimeline(detail) {
  if (!detail) return [];
  const buckets = {};
  const now = Date.now();
  const oneHourAgo = now - HOUR_MS;
  const bucketMs = 10000;

  detail.series.microclimate
    .filter((s) => ['temperature', 'humidity', 'co2'].includes(s.key))
    .forEach((series) => {
      series.data.forEach((p) => {
        const ts = new Date(p.ts).getTime();
        if (Number.isNaN(ts) || ts < oneHourAgo) return;
        const bucket = Math.floor(ts / bucketMs) * bucketMs;
        buckets[bucket] = buckets[bucket] || { ts: bucket, sums: {}, counts: {}, alertStatuses: {}, alertValues: {} };
        buckets[bucket].sums[series.key] = (buckets[bucket].sums[series.key] || 0) + (p.value ?? 0);
        buckets[bucket].counts[series.key] = (buckets[bucket].counts[series.key] || 0) + 1;
        setSpecialAlert(buckets[bucket], series.key, p.value);
      });
    });

  return Object.values(buckets)
    .map((b) => ({
      ts: b.ts,
      temperature: b.sums.temperature ? b.sums.temperature / b.counts.temperature : undefined,
      humidity: b.sums.humidity ? b.sums.humidity / b.counts.humidity : undefined,
      co2: b.sums.co2 ? b.sums.co2 / b.counts.co2 : undefined,
      humidityAlertStatus: b.alertStatuses.humidity || '',
      co2AlertStatus: b.alertStatuses.co2 || '',
      humidityAlertValue: b.alertValues.humidity,
      co2AlertValue: b.alertValues.co2,
    }))
    .sort((a, b) => a.ts - b.ts)
    .slice(-360);
}

/** Форматирование метки времени для осей графиков. */
export const formatTimeTick = (ts) =>
  new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

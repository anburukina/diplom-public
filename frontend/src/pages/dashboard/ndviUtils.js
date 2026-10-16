const HOUR_MS = 60 * 60 * 1000;

/** Округление даты до начала часа. */
export const toHourTs = (value) => {
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return null;
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

/** Группировка точек временного ряда по часам. */
export const collectHourly = (series = []) => {
  const buckets = new Map();
  series.forEach((p) => {
    const ts = toHourTs(p.ts);
    const value = Number(p.value);
    if (ts == null || Number.isNaN(value)) return;
    const bucket = buckets.get(ts) || { sum: 0, count: 0 };
    bucket.sum += value;
    bucket.count += 1;
    buckets.set(ts, bucket);
  });
  return buckets;
};

/** Построение 24-часового сравнения NDVI для гидро- и аэропоники. */
export const buildNdviCompareRows = (hydroSeries = [], aeroSeries = []) => {
  const hydroBuckets = collectHourly(hydroSeries);
  const aeroBuckets = collectHourly(aeroSeries);
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const rows = [];
  for (let i = 23; i >= 0; i -= 1) {
    const ts = now.getTime() - i * HOUR_MS;
    const hydroBucket = hydroBuckets.get(ts);
    const aeroBucket = aeroBuckets.get(ts);
    rows.push({
      ts,
      hydro: hydroBucket?.count ? hydroBucket.sum / hydroBucket.count : null,
      aero: aeroBucket?.count ? aeroBucket.sum / aeroBucket.count : null,
    });
  }
  return rows;
};

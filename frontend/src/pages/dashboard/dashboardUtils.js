/** Получение URL WebSocket из VITE_API_URL. */
export const getWsUrl = () => {
  const base = import.meta.env.VITE_API_URL;
  if (!base) return null;
  const trimmed = base.replace(/\/$/, '');
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}/ws`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}/ws`;
  return null;
};

/** Расчет статуса отклонения значения от заданного диапазона. */
export const getDeviationStatus = (value, ref) => {
  const val = Number(value);
  const min = Number(ref?.ref_min);
  const max = Number(ref?.ref_max);
  if (Number.isNaN(val) || Number.isNaN(min) || Number.isNaN(max)) return '';
  if (val >= min && val <= max) return 'success';
  const delta = val < min ? min - val : val - max;
  const range = max - min;
  const threshold = Math.max(range * 0.05, 2);
  return delta <= threshold ? 'warning' : 'danger';
};

/** Нормализация ответа дашборда и добавление счетчиков предупреждений. */
export const normalizeDashboardPayload = (payload) => {
  if (!payload) return null;
  const aggregates = payload.aggregates ?? payload ?? {};
  const errors = payload.errors ?? [];
  const alertCount = errors.filter((e) => (e.severity || e.status) === 'critical').length;
  const warnCount = errors.filter((e) => (e.severity || e.status) === 'warning').length;
  return {
    updatedAt: payload.updatedAt || Date.now(),
    aggregates,
    errors,
    alertCount,
    warnCount,
  };
};

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
});

const EMPTY_VALUE = '—';

// Форматирование даты и времени для интерфейса.
export function formatTs(ts) {
  if (!ts) return EMPTY_VALUE;
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  return dateFormatter.format(date);
}

// Форматирование числового значения.
export function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return EMPTY_VALUE;
  return number.toFixed(digits);
}

// Получение подписи статуса для интерфейса.
export function statusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'critical' || normalized === 'danger' || normalized === 'alarm') return 'Alarm';
  if (normalized === 'warn' || normalized === 'warning') return 'Warning';
  return 'Норма';
}

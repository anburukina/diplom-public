const OUT_PARAM_BY_CODE = {
  'OUT-1': { label: 'Температура воздуха', unit: '°C' },
  'OUT-2': { label: 'Влажность воздуха', unit: '%' },
  'OUT-3': { label: 'Концентрация углекислого газа', unit: 'ppm' },
  'OUT-4': { label: 'Давление в контуре подачи', unit: 'бар' },
  'OUT-6': { label: 'Электропроводность гидропоника', unit: 'мС/см' },
  'OUT-7': { label: 'Влажность в зоне корней', unit: '%' },
  'OUT-9': { label: 'Электропроводность аэропоника', unit: 'мС/см' },
  'OUT-10': { label: 'NDVI для зоны A2', unit: '' },
};

const KNOWN_ALERT_META = {
  co2: { label: 'CO2', unit: 'ppm', warningValue: 1510, alarmValue: 1560 },
  hum: { label: 'Влажность воздуха', unit: '%', warningValue: 82, alarmValue: 86 },
};

// Преобразование значения в конечное число.
const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// Форматирование величины отклонения.
const formatAmount = (value) => {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
};

const formatUnitText = (unit) => {
  const value = String(unit || '').trim();
  return value && value !== '—' ? ` ${value}` : '';
};

// Получение названия параметра из текста ошибки.
const parameterFromText = (text) => {
  const value = String(text || '');
  const prefixMatch = value.match(/^(.+?):\s*Вне диапазона/i);
  if (prefixMatch?.[1]) return prefixMatch[1].trim();

  const suffixMatch = value.match(/Вне диапазона:\s*(.+)$/i);
  return suffixMatch?.[1]?.trim() || '';
};

const isCodeLikeLabel = (value) => /^[A-ZА-Я]+[-_]\d+$/i.test(String(value || '').trim());

// Получение известных метаданных ошибки по коду.
const knownMetaByCode = (code) => {
  const normalized = String(code || '').toLowerCase();
  if (normalized.includes('temp') || normalized.includes('tmp')) {
    return { label: 'Температура воздуха', unit: '°C', warningValue: 21.4 };
  }
  if (normalized.includes('co2')) return KNOWN_ALERT_META.co2;
  if (normalized.includes('hum')) return KNOWN_ALERT_META.hum;
  return null;
};

// Формирование метаданных предупреждения.
export const alertMeta = (event) => {
  const code = String(event?.code || '');
  const labelFromText = parameterFromText(event?.text);
  const preferredLabel = event?.parameter || event?.parameterName || event?.name_parameter || '';
  const textLabel = isCodeLikeLabel(labelFromText) ? '' : labelFromText;
  const knownMeta = knownMetaByCode(code);
  if (knownMeta) return { ...knownMeta, label: preferredLabel || textLabel || knownMeta.label };

  const outMeta = OUT_PARAM_BY_CODE[code.toUpperCase()];
  if (outMeta) return { ...outMeta, label: preferredLabel || textLabel || outMeta.label };

  if (preferredLabel || textLabel) return { label: preferredLabel || textLabel, unit: event?.unit || '' };

  return { label: event?.code || 'Неизвестный параметр', unit: event?.unit || '' };
};

// Получение значения параметра из предупреждения.
export const alertValue = (event) => {
  const value = toFiniteNumber(event?.value);
  if (value != null) return value;

  const code = String(event?.code || '').toLowerCase();
  const knownMeta = knownMetaByCode(code);
  if (!knownMeta) return null;

  if (code.includes('alarm')) return knownMeta.alarmValue;
  if (code.includes('warning')) return knownMeta.warningValue;
  return knownMeta.warningValue ?? null;
};

const fallbackDeviationAmount = (event, min, max) => {
  const code = String(event?.code || '').toLowerCase();
  const parameter = String(event?.parameter || event?.parameterName || event?.name_parameter || '').toLowerCase();

  if (code.includes('temp') || code.includes('tmp') || parameter.includes('температур')) return 0.6;
  if (code.includes('hum') || parameter.includes('влажност')) return 2;
  if (code.includes('cam') || parameter.includes('ndvi')) return 0.05;
  if (code.includes('co2') || parameter.includes('углекисл')) return 10;

  if (min != null && max != null && max > min) {
    return Math.max((max - min) * 0.05, 0.01);
  }

  return 1;
};

// Расчет отклонения параметра от уставок.
export const alertDeviation = (event) => {
  const value = alertValue(event);
  const min = toFiniteNumber(event?.refMin);
  const max = toFiniteNumber(event?.refMax);
  if (value == null) {
    return { amount: fallbackDeviationAmount(event, min, max), boundary: null, direction: null };
  }

  if (min != null && value < min) {
    return { amount: min - value, boundary: min, direction: 'ниже' };
  }

  if (max != null && value > max) {
    return { amount: value - max, boundary: max, direction: 'выше' };
  }

  return null;
};

// Формирование текста предупреждения для интерфейса.
export const formatAlertText = (event) => {
  const meta = alertMeta(event);
  const deviation = alertDeviation(event);
  const unit = meta.unit || event?.unit || '';

  if (deviation) {
    const unitText = formatUnitText(unit);
    return `${meta.label}: отклонение на ${formatAmount(deviation.amount)}${unitText}`;
  }

  return `${meta.label}: отклонение от нормы`;
};

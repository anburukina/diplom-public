export const WATERING_DURATIONS_SEC = {
  hydro: 600,
  aero: 10,
};

// Нормализация текстового названия.
export const normalizeLabel = (value) => String(value ?? '').trim().toLowerCase();

// Преобразование значения в конечное число.
export const toFiniteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

// Получение идентификатора технологии зоны.
export const getTechnologyId = (zone) =>
  toFiniteNumber(zone?.technologyId ?? zone?.technology_id ?? zone?.technology);

// Получение номера строки зоны.
export const getZoneRow = (zone) => toFiniteNumber(zone?.row ?? zone?.row_num ?? zone?.row_number);

// Получение номера столбца зоны.
export const getZoneColumn = (zone) =>
  toFiniteNumber(zone?.column ?? zone?.col ?? zone?.col_num ?? zone?.column_number);

// Получение текстового названия технологии зоны.
export const getTechnologyLabel = (zone) =>
  normalizeLabel(zone?.technologyName ?? zone?.technology ?? zone?.technology_name);

// Проверка принадлежности зоны к гидропонной технологии.
export const isHydroZone = (zone) => {
  const techId = getTechnologyId(zone);
  if (techId === 1) return true;
  const label = getTechnologyLabel(zone);
  return label.includes('гидро') || label.includes('hydro');
};

// Проверка принадлежности зоны к аэропонной технологии.
export const isAeroZone = (zone) => {
  const techId = getTechnologyId(zone);
  if (techId === 2) return true;
  const label = getTechnologyLabel(zone);
  return label.includes('аэро') || label.includes('aero');
};

// Получение длительности полива для зоны.
export const getWateringDurationSec = (zone) => {
  if (isHydroZone(zone)) return WATERING_DURATIONS_SEC.hydro;
  if (isAeroZone(zone)) return WATERING_DURATIONS_SEC.aero;
  return null;
};

// Сортировка зон по сетке установки.
export const compareZonesByGrid = (a, b) => {
  const rowA = getZoneRow(a);
  const rowB = getZoneRow(b);
  if (rowA != null && rowB != null && rowA !== rowB) return rowA - rowB;

  const colA = getZoneColumn(a);
  const colB = getZoneColumn(b);
  if (colA != null && colB != null && colA !== colB) return colA - colB;

  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
};

// Получение отображаемого названия зоны.
export const getZoneDisplayName = (zone) => zone?.name || zone?.id || 'Зона';

import { NDVI_COMPARE_KEY } from './constants';
import { buildNdviCompareRows } from './ndviUtils';
import { formatTimeTick } from './timelineUtils';

/** Определение режима отображения отчета по выбранному параметру. */
export const getReportFlags = ({ report, reportParam }) => {
  const reportName = (report?.name || '').toString().toLowerCase();
  const reportNameCompact = reportName.replace(/\s+/g, '');
  const reportParamId = Number(report?.parameter ?? reportParam);
  const reportNeedsLast300 =
    Number.isFinite(reportParamId) && [1, 2, 3].includes(reportParamId)
      ? true
      : reportName.includes('температура воздуха') ||
        reportName.includes('влажность воздуха') ||
        reportName.includes('углекисл');
  const reportIsNdviParamId = Number.isFinite(reportParamId) && [10, 11].includes(reportParamId);
  const reportIsNdvi = reportName.includes('ndvi') || reportIsNdviParamId;
  const reportIsNdviCompare =
    reportParam === NDVI_COMPARE_KEY || report?.parameter === NDVI_COMPARE_KEY;
  const reportIsHydroParamId = Number.isFinite(reportParamId) && [4, 6].includes(reportParamId);
  const reportIsAeroParamId = Number.isFinite(reportParamId) && [7, 9].includes(reportParamId);
  const reportHasEc =
    reportName.includes('электропровод') ||
    reportName === 'ec' ||
    reportName.includes('ec');
  const reportIsHydroLabel = reportName.includes('гидропон') || reportName.includes('hydro');
  const reportIsAeroLabel = reportName.includes('аэро') || reportName.includes('aero');
  const reportIsHydroParamName =
    (reportName.includes('давлен') &&
      (reportName.includes('контур') ||
        reportNameCompact.includes('контуреподачи') ||
        reportNameCompact.includes('контурподачи') ||
        reportNameCompact.includes('контурпода'))) ||
    (reportIsHydroLabel && reportHasEc);
  const reportIsNdviHydro = reportIsNdvi && (reportParamId === 10 || reportIsHydroLabel);
  const reportIsNdviAero = reportIsNdvi && (reportParamId === 11 || reportIsAeroLabel);
  const reportIsHydroMulti = reportIsHydroParamId || reportIsHydroParamName || reportIsNdviHydro;
  const reportIsAeroMulti = reportIsAeroParamId || reportIsNdviAero;
  const reportIsAeroWindow =
    Number.isFinite(reportParamId) && [7, 9].includes(reportParamId);
  const reportIsDense =
    (reportName.includes('электропровод') ||
      reportName === 'ec' ||
      reportName.includes('ndvi')) &&
    !reportIsAeroWindow &&
    !reportIsHydroMulti &&
    !reportIsAeroMulti &&
    !reportIsNdviCompare;

  return {
    reportIsAeroMulti,
    reportIsAeroWindow,
    reportIsDense,
    reportIsHydroMulti,
    reportIsNdviCompare,
    reportNeedsLast300,
  };
};

/** Построение строк и наборов серий для графика отчетности. */
export const buildReportChart = ({
  report,
  flags,
  hydroZoneIds,
  aeroZoneIds,
  hydroZoneLabels,
  aeroZoneLabels,
}) => {
  if (flags.reportIsNdviCompare) {
    const rows = buildNdviCompareRows(
      report?.ndviCompare?.hydro ?? [],
      report?.ndviCompare?.aero ?? [],
    );
    return {
      rows,
      seriesKeys: ['hydro', 'aero'],
      seriesLabels: new Map([
        ['hydro', 'NDVI гидропоника'],
        ['aero', 'NDVI аэропоника'],
      ]),
    };
  }

  const src = (report?.series || [])
    .map((p) => {
      const ts = new Date(p.ts).getTime();
      if (Number.isNaN(ts)) return null;
      return {
        ts,
        value: p.value,
        zoneId: p.zoneId ?? null,
        zoneName: p.zoneName ?? null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  if (!flags.reportIsHydroMulti && !flags.reportIsAeroMulti) {
    let rows = src;
    if (flags.reportNeedsLast300 && rows.length > 300) {
      rows = rows.slice(-300);
    }
    if (flags.reportIsDense) {
      rows = rows.map((item, idx) => ({ ...item, x: idx + 1 }));
    }
    return {
      rows,
      seriesKeys: ['value'],
      seriesLabels: new Map([['value', report?.name || 'Значение']]),
    };
  }

  const byTs = new Map();
  const labels = flags.reportIsHydroMulti
    ? new Map(hydroZoneLabels)
    : flags.reportIsAeroMulti
      ? new Map(aeroZoneLabels)
      : new Map();
  const zoneFilter = flags.reportIsHydroMulti
    ? hydroZoneIds
    : flags.reportIsAeroMulti
      ? aeroZoneIds
      : null;
  src.forEach((item) => {
    if (zoneFilter && (item.zoneId == null || !zoneFilter.has(String(item.zoneId)))) {
      return;
    }
    const zoneKey = `zone_${item.zoneId ?? 'x'}`;
    if (!labels.has(zoneKey)) {
      const label = item.zoneName || (item.zoneId != null ? `Зона ${item.zoneId}` : 'Зона');
      labels.set(zoneKey, label);
    }
    const row = byTs.get(item.ts) || { ts: item.ts };
    row[zoneKey] = item.value;
    byTs.set(item.ts, row);
  });
  let rows = Array.from(byTs.values()).sort((a, b) => a.ts - b.ts);
  if (labels.size && rows.length) {
    rows = rows.map((row) => {
      const next = { ...row };
      labels.forEach((_, key) => {
        if (!(key in next)) next[key] = null;
      });
      return next;
    });
  }
  const seriesKeys = Array.from(labels.keys()).sort((a, b) => {
    const aNum = Number(a.replace('zone_', ''));
    const bNum = Number(b.replace('zone_', ''));
    if (Number.isNaN(aNum) || Number.isNaN(bNum)) return a.localeCompare(b);
    return aNum - bNum;
  });
  if (flags.reportIsDense) {
    rows = rows.map((item, idx) => ({ ...item, x: idx + 1 }));
  }
  return { rows, seriesKeys, seriesLabels: labels };
};

/** Создание словаря подписей для плотных графиков. */
export const buildDenseLabelMap = (reportChart, reportIsDense) => {
  if (!reportIsDense) return null;
  const labels = new Map();
  reportChart.rows.forEach((d) => {
    if (d.x != null) labels.set(d.x, formatTimeTick(d.ts));
  });
  return labels;
};

/** Форматирование подписи tooltip в зависимости от режима графика. */
export const formatReportLabel = ({ value, reportIsDense, labelMap, reportIsAeroWindow, reportAeroBaseTs }) => {
  if (reportIsDense) return labelMap?.get(value) || value;
  if (reportIsAeroWindow && reportAeroBaseTs != null) {
    const delta = Math.max(0, Math.round((value - reportAeroBaseTs) / 1000));
    return `t+${delta}с`;
  }
  return formatTimeTick(value);
};


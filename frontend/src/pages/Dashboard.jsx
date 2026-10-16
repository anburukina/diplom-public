import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  getDashboard,
  getZones,
  getZoneDetails,
  getParameterReport,
  getParameters,
  getParameterReference,
  updateReference,
  setTemperatureHeating,
  getTemperatureScenarioStatus,
} from '../api';
import { Topbar } from '../layout/Topbar';
import { formatTs } from '../utils/format';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { useAuth } from '../auth';
import { NDVI_AERO_PARAM_ID, NDVI_COMPARE_KEY, NDVI_COMPARE_LABEL, NDVI_HYDRO_PARAM_ID } from './dashboard/constants';
import {
  buildDenseLabelMap,
  buildReportChart,
  formatReportLabel as formatReportLabelValue,
  getReportFlags,
} from './dashboard/reportChartUtils';
import {
  getDeviationStatus,
  getWsUrl,
  normalizeDashboardPayload,
} from './dashboard/dashboardUtils';
import { buildTimeline } from './dashboard/timelineUtils';
import { isAeroZone, isHydroZone } from './dashboard/zoneUtils';
import { MetricCards } from './dashboard/components/MetricCards';
import { MicroclimatePanel } from './dashboard/components/MicroclimatePanel';
import { ReferenceEditor } from './dashboard/components/ReferenceEditor';
import { ReportPanel } from './dashboard/components/ReportPanel';
import { TemperatureNotice } from './dashboard/components/TemperatureNotice';

const REPORT_EXCLUDED_PARAM_IDS = new Set([4, 6, 7]);

/** Формирование экрана мониторинга из данных API, графиков и форм управления. */
export function Dashboard() {
  const location = useLocation();
  const { employee } = useAuth();
  const [dash, setDash] = useState(null);
  const [wsOnline, setWsOnline] = useState(false);
  const [zones, setZones] = useState([]);
  const [detail, setDetail] = useState(null);
  const [primaryZoneId, setPrimaryZoneId] = useState(null);
  const [parameters, setParameters] = useState([]);
  const [reportParam, setReportParam] = useState('');
  const [report, setReport] = useState(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [rangeRefs, setRangeRefs] = useState({});
  const [tempNotice, setTempNotice] = useState(null);
  const [tempCriticalAck, setTempCriticalAck] = useState(false);
  const [tempNormalAck, setTempNormalAck] = useState(false);
  const [tempScenarioActive, setTempScenarioActive] = useState(true);

  const [editParam, setEditParam] = useState('');
  const [editMin, setEditMin] = useState('');
  const [editMax, setEditMax] = useState('');
  const [loadedRef, setLoadedRef] = useState({ min: '', max: '' });
  const [editError, setEditError] = useState('');
  const [editSuccess, setEditSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  /** Применение обновления дашборда из HTTP или WebSocket. */
  const applyDashboard = useCallback((payload) => {
    const normalized = normalizeDashboardPayload(payload);
    if (normalized) setDash(normalized);
  }, []);

  /** Загрузка референсных диапазонов для основных метрик. */
  const loadMainRefs = useCallback(async () => {
    try {
      const [tempRef, humRef, co2Ref] = await Promise.all([
        getParameterReference(1),
        getParameterReference(2),
        getParameterReference(3),
      ]);
      setRangeRefs({
        temperature: tempRef,
        humidity: humRef,
        co2: co2Ref,
      });
    } catch (e) {
      console.error('reference load error', e);
    }
  }, []);

  /** Загрузка основных данных для первого отображения страницы. */
  const load = useCallback(async () => {
    const [dashboardData, zoneList, parameterList] = await Promise.all([
      getDashboard(),
      getZones(),
      getParameters(),
    ]);
    applyDashboard(dashboardData);
    setZones(Array.isArray(zoneList) ? zoneList : []);
    setParameters(Array.isArray(parameterList) ? parameterList : []);

    const firstReportParam = parameterList
      ?.find((p) => !REPORT_EXCLUDED_PARAM_IDS.has(Number(p.id)))
      ?.id
      ?.toString();
    const firstParam = parameterList?.[0]?.id?.toString();
    if (firstReportParam) {
      setReportParam((prev) => prev || firstReportParam);
    }
    if (firstParam) {
      setEditParam((prev) => prev || firstParam);
    }

    const primaryZone = zoneList?.[0]?.id ?? null;
    setPrimaryZoneId(primaryZone);
    if (primaryZone) {
      setDetail(await getZoneDetails(primaryZone, { hours: 6 }));
    }
  }, [applyDashboard]);

  /** Обновление детализации выбранной зоны. */
  const loadZoneDetail = useCallback(async (zoneId) => {
    if (!zoneId) return;
    try {
      setDetail(await getZoneDetails(zoneId, { hours: 6 }));
    } catch (e) {
      console.error('zone detail load error', e);
    }
  }, []);

  useEffect(() => {
    load();
    loadMainRefs();
  }, [load, loadMainRefs]);

  useEffect(() => {
    let mounted = true;
    getTemperatureScenarioStatus()
      .then((data) => {
        if (mounted && typeof data?.active === 'boolean') {
          setTempScenarioActive(data.active);
        }
      })
      .catch((e) => console.error(e));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const wsUrl = getWsUrl();
    if (!wsUrl) return undefined;

    let ws;
    let reconnectTimer;
    let active = true;

    /** Открытие WebSocket и переподключение при разрыве. */
    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        setWsOnline(true);
        ws.send(JSON.stringify({ type: 'dashboard:once' }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg?.type === 'dashboard' && msg.data) {
            applyDashboard(msg.data);
          }
        } catch (e) {
          console.error('ws message error', e);
        }
      };
      ws.onclose = () => {
        setWsOnline(false);
        if (active) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
      ws.onerror = () => {
        ws.close();
      };
    };

    connect();
    return () => {
      active = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [applyDashboard]);

  useAutoRefresh(() => {
    if (!wsOnline) {
      return load();
    }
    return null;
  }, 3000);

  useAutoRefresh(() => {
    if (primaryZoneId) {
      return loadZoneDetail(primaryZoneId);
    }
    return null;
  }, 3000);

  const chartData = useMemo(() => buildTimeline(detail), [detail]);
  const reportFlags = useMemo(() => getReportFlags({ report, reportParam }), [report, reportParam]);

  const hydroZones = useMemo(() => zones.filter(isHydroZone), [zones]);
  const aeroZones = useMemo(() => zones.filter(isAeroZone), [zones]);
  const hydroZoneIds = useMemo(() => new Set(hydroZones.map((z) => String(z.id))), [hydroZones]);
  const aeroZoneIds = useMemo(() => new Set(aeroZones.map((z) => String(z.id))), [aeroZones]);
  const hydroZoneLabels = useMemo(
    () => new Map(hydroZones.map((z) => [`zone_${z.id}`, z.name || `Зона ${z.id}`])),
    [hydroZones],
  );
  const aeroZoneLabels = useMemo(
    () => new Map(aeroZones.map((z) => [`zone_${z.id}`, z.name || `Зона ${z.id}`])),
    [aeroZones],
  );

  const reportChart = useMemo(
    () =>
      buildReportChart({
        report,
        flags: reportFlags,
        hydroZoneIds,
        aeroZoneIds,
        hydroZoneLabels,
        aeroZoneLabels,
      }),
    [report, reportFlags, hydroZoneIds, aeroZoneIds, hydroZoneLabels, aeroZoneLabels],
  );

  const labelMap = useMemo(
    () => buildDenseLabelMap(reportChart, reportFlags.reportIsDense),
    [reportChart, reportFlags.reportIsDense],
  );
  const reportAeroBaseTs = useMemo(() => {
    if (!reportFlags.reportIsAeroWindow) return null;
    return reportChart.rows[0]?.ts ?? null;
  }, [reportChart, reportFlags.reportIsAeroWindow]);
  const formatReportLabel = useCallback(
    (value) =>
      formatReportLabelValue({
        value,
        reportIsDense: reportFlags.reportIsDense,
        labelMap,
        reportIsAeroWindow: reportFlags.reportIsAeroWindow,
        reportAeroBaseTs,
      }),
    [labelMap, reportAeroBaseTs, reportFlags.reportIsAeroWindow, reportFlags.reportIsDense],
  );

  /** Загрузка отчета по выбранному параметру. */
  const loadReport = useCallback(async (paramKey) => {
    if (!paramKey) return;
    try {
      setReportLoading(true);
      setReportError('');
      if (paramKey === NDVI_COMPARE_KEY) {
        const [hydro, aero] = await Promise.all([
          getParameterReport(NDVI_HYDRO_PARAM_ID),
          getParameterReport(NDVI_AERO_PARAM_ID),
        ]);
        setReport({
          parameter: NDVI_COMPARE_KEY,
          name: NDVI_COMPARE_LABEL,
          ndviCompare: {
            hydro: hydro?.series ?? [],
            aero: aero?.series ?? [],
          },
        });
        return;
      }
      setReport(await getParameterReport(paramKey));
    } catch (e) {
      console.error(e);
      setReportError('Не удалось загрузить данные отчета');
    } finally {
      setReportLoading(false);
    }
  }, []);

  useEffect(() => {
    if (reportParam) {
      loadReport(reportParam);
    }
  }, [loadReport, reportParam]);

  const reportParameters = useMemo(
    () => parameters.filter((p) => !REPORT_EXCLUDED_PARAM_IDS.has(Number(p.id))),
    [parameters],
  );

  useEffect(() => {
    if (!reportParameters.length) return;
    if (reportParam === NDVI_COMPARE_KEY) return;
    const isAvailable = reportParameters.some((p) => String(p.id) === String(reportParam));
    if (!isAvailable) {
      setReportParam(reportParameters[0].id.toString());
    }
  }, [reportParam, reportParameters]);

  /** Загрузка текущих пределов редактируемого параметра. */
  const loadReference = useCallback(async (paramId) => {
    if (!paramId) return;
    try {
      const ref = await getParameterReference(paramId);
      const minVal = ref?.ref_min ?? '';
      const maxVal = ref?.ref_max ?? '';
      setLoadedRef({ min: minVal, max: maxVal });
      setEditMin('');
      setEditMax('');
      setEditError('');
      setEditSuccess('');
    } catch (e) {
      console.error(e);
      setLoadedRef({ min: '', max: '' });
      setEditError('Не удалось загрузить текущие пределы');
    }
  }, []);

  useEffect(() => {
    if (editParam) {
      loadReference(editParam);
    }
  }, [editParam, loadReference]);

  useEffect(() => {
    if (location.hash !== '#reference-editor') return;
    requestAnimationFrame(() => {
      document.getElementById('reference-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [location.hash]);

  const values = {
    temperature: dash?.aggregates?.temperature ?? detail?.current?.temperature,
    humidity: dash?.aggregates?.humidity ?? detail?.current?.humidity,
    co2: dash?.aggregates?.co2 ?? detail?.current?.co2,
  };
  const statuses = {
    temperature: getDeviationStatus(values.temperature, rangeRefs.temperature),
    humidity: getDeviationStatus(values.humidity, rangeRefs.humidity),
    co2: getDeviationStatus(values.co2, rangeRefs.co2),
  };
  const tempNormalMin = useMemo(() => {
    const raw =
      rangeRefs?.temperature?.ref_min ??
      rangeRefs?.temperature?.min_value ??
      rangeRefs?.temperature?.min ??
      null;
    const val = Number(raw);
    return Number.isFinite(val) && val > 10 ? val : 20;
  }, [rangeRefs]);

  useEffect(() => {
    if (!tempScenarioActive) return;
    const value = Number(values.temperature);
    if (!Number.isFinite(value)) return;
    if (!tempCriticalAck && value <= 10) {
      setTempNotice('critical');
      return;
    }
    if (tempCriticalAck && !tempNormalAck && value >= tempNormalMin) {
      setTempNotice('normal');
    }
  }, [values.temperature, tempCriticalAck, tempNormalAck, tempNormalMin, tempScenarioActive]);

  /** Подтверждение критического падения температуры и включение отопления. */
  const handleTempCriticalAck = useCallback(async () => {
    try {
      await setTemperatureHeating({ on: true });
    } catch (e) {
      console.error(e);
    }
    setTempCriticalAck(true);
    setTempNotice(null);
  }, []);

  /** Закрытие уведомления о возврате температуры в норму. */
  const handleTempNormalAck = useCallback(() => {
    setTempNormalAck(true);
    setTempNotice(null);
  }, []);

  /** Проверка и сохранение нового референсного диапазона. */
  const handleReferenceSubmit = useCallback(async () => {
    const minRaw = editMin === '' ? loadedRef.min : editMin;
    const maxRaw = editMax === '' ? loadedRef.max : editMax;
    const min = Number(minRaw);
    const max = Number(maxRaw);
    if (minRaw === '' || maxRaw === '') {
      setEditError('Заполните оба значения');
      setEditSuccess('');
      return;
    }
    if (Number.isNaN(min) || Number.isNaN(max)) {
      setEditError('Минимум и максимум должны быть числами');
      setEditSuccess('');
      return;
    }
    if (min > max) {
      setEditError('Минимум не может быть больше максимума');
      setEditSuccess('');
      return;
    }

    setEditError('');
    setSaving(true);
    try {
      await updateReference({ parameterId: editParam, min, max, employeeId: employee?.id });
      setEditSuccess('Диапазон обновлен');
      setLoadedRef({ min, max });
      setEditMin('');
      setEditMax('');
      loadMainRefs();
    } catch (e) {
      console.error(e);
      setEditError('Не удалось сохранить изменения');
      setEditSuccess('');
    } finally {
      setSaving(false);
    }
  }, [editMax, editMin, editParam, employee?.id, loadedRef, loadMainRefs]);

  /** Сброс формы редактирования к последним загруженным значениям. */
  const handleReferenceCancel = useCallback(() => {
    setEditMin(loadedRef.min ?? '');
    setEditMax(loadedRef.max ?? '');
    setEditError('');
    setEditSuccess('');
  }, [loadedRef]);

  return (
    <div>
      <TemperatureNotice
        notice={tempNotice}
        temperatureValue={values.temperature}
        onCriticalAck={handleTempCriticalAck}
        onNormalAck={handleTempNormalAck}
      />
      <Topbar
        title="Главная"
        actions={
          <>
            <button className="language-switch" type="button" title="English interface preview">
              EN
            </button>
            {employee && (
              <div className="pill">
                Сотрудник: {employee.name}
              </div>
            )}
            <div className="pill success">Обновлено: {dash ? formatTs(dash.updatedAt || Date.now()) : '-'}</div>
          </>
        }
      />

      <MetricCards values={values} statuses={statuses} />
      <MicroclimatePanel chartData={chartData} />
      <ReportPanel
        flags={reportFlags}
        formatReportLabel={formatReportLabel}
        labelMap={labelMap}
        onReportParamChange={setReportParam}
        parameters={reportParameters}
        report={report}
        reportChart={reportChart}
        reportError={reportError}
        reportLoading={reportLoading}
        reportParam={reportParam}
      />
      <ReferenceEditor
        editError={editError}
        editMax={editMax}
        editMin={editMin}
        editParam={editParam}
        editSuccess={editSuccess}
        employee={employee}
        loadedRef={loadedRef}
        onCancel={handleReferenceCancel}
        onEditMaxChange={setEditMax}
        onEditMinChange={setEditMin}
        onEditParamChange={setEditParam}
        onSubmit={handleReferenceSubmit}
        parameters={parameters}
        saving={saving}
      />
    </div>
  );
}

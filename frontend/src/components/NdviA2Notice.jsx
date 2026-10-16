import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getZoneDetails, getZones } from '../api';
import { formatTimeTick } from '../pages/dashboard/timelineUtils';
import { formatNumber } from '../utils/format';

const STORAGE_KEY = 'ndviA2LowNoticeDismissed:v5';
const POLL_MS = 5000;
const NDVI_LOW_LIMIT = 0.5;

// Нормализация названия зоны для поиска A2.
const normalizeZoneCode = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[а]/g, 'a')
    .replace(/[^a-z0-9]/g, '');

// Проверка принадлежности зоны к гидропонной технологии.
const isHydro = (zone) => {
  const id = Number(zone?.technologyId ?? zone?.technology_id ?? zone?.technology);
  if (id === 1) return true;
  const label = String(zone?.technologyName || zone?.technology || '').toLowerCase();
  return label.includes('гидро') || label.includes('hydro');
};

// Проверка принадлежности зоны к A2.
const isZoneA2 = (zone) => normalizeZoneCode(zone?.name).includes('a2');

const MICROCLIMATE_PARAMS = [
  { key: 'temperature', label: 'Температура', unit: '°C', min: 22, max: 25 },
  { key: 'humidity', label: 'Влажность', unit: '%', min: 70, max: 80 },
  { key: 'co2', label: 'CO₂', unit: 'ppm', min: 1000, max: 1500 },
];

// Определение статуса микроклимата по допустимому диапазону.
const getMicroclimateStatus = (value, { min, max }) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { tone: 'warning', label: 'Нет данных' };
  if (numeric >= min && numeric <= max) return { tone: 'success', label: 'В норме' };
  return { tone: 'danger', label: 'Проверьте значение' };
};

// Отображение предупреждения о снижении NDVI в зоне A2.
export function NdviA2Notice() {
  const navigate = useNavigate();
  const [notice, setNotice] = useState(null);
  const dismissedRef = useRef(localStorage.getItem(STORAGE_KEY) || '');

  useEffect(() => {
    let cancelled = false;

    // Проверка текущего NDVI зоны A2.
    const check = async () => {
      try {
        const zones = await getZones();
        if (cancelled || !Array.isArray(zones)) return;

        const zone = zones.find((item) => isHydro(item) && isZoneA2(item));
        const value = Number(zone?.ndvi ?? zone?.ndvi_value ?? zone?.ndviValue);
        if (!Number.isFinite(value)) return;

        if (value > NDVI_LOW_LIMIT) {
          dismissedRef.current = '';
          localStorage.removeItem(STORAGE_KEY);
          setNotice(null);
          return;
        }

        let current = {};
        let ndviSeries = [];
        if (zone?.id != null) {
          try {
            const detail = await getZoneDetails(zone.id, { hours: 24 });
            current = detail?.current ?? {};
            ndviSeries =
              detail?.series?.ndvi
                ?.map((point) => {
                  const ts = new Date(point.ts).getTime();
                  const pointValue = Number(point.value ?? point.ndvi);
                  if (!Number.isFinite(ts) || !Number.isFinite(pointValue)) return null;
                  return { ts, value: pointValue };
                })
                .filter(Boolean)
                .sort((a, b) => a.ts - b.ts)
                .slice(-24) ?? [];
          } catch (detailError) {
            console.error('NDVI A2 detail load error', detailError);
          }
        }

        const latestPoint = ndviSeries.at(-1);
        const noticeKey = `${zone?.id ?? 'a2'}:${latestPoint?.ts ?? 'no-ts'}:${value.toFixed(3)}`;
        if (dismissedRef.current === noticeKey) return;

        setNotice({
          zoneId: zone?.id ?? null,
          zoneName: zone?.name || 'A2',
          value,
          current,
          ndviSeries,
          noticeKey,
        });
      } catch (e) {
        console.error('NDVI A2 notice error', e);
      }
    };

    check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!notice) return null;

  // Переход к корректировке полива после предупреждения.
  const correctWatering = () => {
    dismissedRef.current = notice.noticeKey;
    localStorage.setItem(STORAGE_KEY, notice.noticeKey);
    setNotice(null);
    const query = notice.zoneId != null ? `?forceZoneId=${encodeURIComponent(notice.zoneId)}` : '';
    navigate(`/zones${query}#watering-control`);
  };

  return (
    <div className="modal-overlay">
      <div className="modal-card critical ndvi-notice-card" role="alertdialog" aria-modal="true">
        <div className="modal-title">Зона A2. Снижение уровня NDVI.</div>
        <div className="subtitle">
          Растения в стрессовом состоянии, требуется проверка условий.
        </div>
        <div className="row-grid" style={{ marginTop: 14 }}>
          {MICROCLIMATE_PARAMS.map((param) => {
            const value = notice.current?.[param.key];
            const status = getMicroclimateStatus(value, param);
            return (
              <div key={param.key} className={`row-tile metric ${status.tone}`}>
                <div className="row-title">{param.label}</div>
                <div className="row-meta">
                  {formatNumber(value, param.key === 'co2' ? 0 : 1)}
                  {param.unit ? ` ${param.unit}` : ''}
                </div>
                <div className={`pill ${status.tone}`}>{status.label}</div>
              </div>
            );
          })}
        </div>
        {notice.ndviSeries?.length > 0 && (
          <div style={{ height: 180, marginTop: 16 }}>
            <ResponsiveContainer>
              <LineChart data={notice.ndviSeries} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgba(147,163,190,0.14)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="ts"
                  stroke="#93a3be"
                  tickFormatter={formatTimeTick}
                  minTickGap={18}
                />
                <YAxis stroke="#93a3be" domain={[0, 0.8]} tickFormatter={(v) => formatNumber(v, 1)} />
                <Tooltip
                  contentStyle={{ background: '#0f1a2b', border: '1px solid #26364f', borderRadius: 8 }}
                  labelFormatter={formatTimeTick}
                  formatter={(val) => [formatNumber(val, 2), 'NDVI']}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#ff6b6b"
                  strokeWidth={2}
                  dot={false}
                  name="NDVI"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn primary" type="button" onClick={correctWatering}>
            Перейти к корректировке полива
          </button>
        </div>
      </div>
    </div>
  );
}

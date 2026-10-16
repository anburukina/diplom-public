import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, AreaChart, Area } from 'recharts';
import { getZoneDetails } from '../api';
import { Topbar } from '../layout/Topbar';
import StatusBadge from '../components/StatusBadge';
import { formatNumber, formatTs, statusLabel } from '../utils/format';
import { useAutoRefresh } from '../hooks/useAutoRefresh';
import { isAeroZone, isHydroZone } from '../utils/zones';

// Форматирование времени для подписей графика.
const formatTimeTick = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

// Группировка временного ряда по минутным интервалам.
function bucketSeries(series, keys, hours) {
  const now = Date.now();
  const from = now - (hours || 1) * 60 * 60 * 1000;
  const buckets = new Map();

  (series || []).forEach((serie) => {
    if (keys && !keys.includes(serie.key)) return;
    (serie.data || []).forEach((p) => {
      const ts = new Date(p.ts).getTime();
      if (Number.isNaN(ts) || ts < from) return;
      const bucketTs = Math.floor(ts / 60000) * 60000;
      const bucket = buckets.get(bucketTs) || { ts: bucketTs, sums: {}, counts: {} };
      bucket.sums[serie.key] = (bucket.sums[serie.key] || 0) + (p.value ?? 0);
      bucket.counts[serie.key] = (bucket.counts[serie.key] || 0) + 1;
      buckets.set(bucketTs, bucket);
    });
  });

  return Array.from(buckets.values())
    .map((b) => {
      const row = { ts: b.ts };
      Object.keys(b.sums).forEach((k) => {
        row[k] = b.sums[k] / b.counts[k];
      });
      return row;
    })
    .sort((a, b) => a.ts - b.ts)
    .slice(-100);
}

// Отображение подробной страницы выбранной зоны.
export function ZoneDetails() {
  const { id } = useParams();
  const [detail, setDetail] = useState(null);
  const [hours, setHours] = useState(24);
  const [error, setError] = useState('');
  const [nowTs, setNowTs] = useState(() => Date.now());

  // Загрузка подробных данных выбранной зоны.
  const load = useCallback(async () => {
    try {
      setError('');
      const data = await getZoneDetails(id, { hours });
      if (!data) {
        setError('Зона не найдена');
        setDetail(null);
        return;
      }
      setNowTs(Date.now());
      setDetail(data);
    } catch (e) {
      console.error(e);
      setError('Не удалось загрузить данные зоны');
    }
  }, [id, hours]);

  useEffect(() => {
    const timer = setTimeout(() => {
      load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  useAutoRefresh(load, 4000);

  const { zone = {}, current = {}, references = {}, series = {}, errors = [] } = detail || {};
  const isHydro = isHydroZone(zone);
  const isAero = isAeroZone(zone);

  const microData = useMemo(
    () => bucketSeries(series.microclimate, ['temperature', 'humidity', 'co2'], hours),
    [series, hours],
  );
  const solutionData = useMemo(
    () => bucketSeries(series.solution, ['ec', 'pressure', 'rootHumidity'], hours),
    [series, hours],
  );
  const ndviData = useMemo(() => {
    const cutoff = nowTs - (hours || 1) * 60 * 60 * 1000;
    return (
      series.ndvi
        ?.map((p) => {
          const ts = new Date(p.ts).getTime();
          if (Number.isNaN(ts)) return null;
          return { ts, value: p.value ?? p.ndvi ?? 0 };
        })
        .filter((p) => p && p.ts >= cutoff)
        .sort((a, b) => a.ts - b.ts)
        .slice(-200) ?? []
    );
  }, [series, hours, nowTs]);

  const pills = [
    { key: 'temperature', label: 'Температура', unit: '°C' },
    { key: 'humidity', label: 'Влажность', unit: '%' },
    { key: 'co2', label: 'CO₂', unit: 'ppm' },
    { key: 'ec', label: 'EC', unit: '' },
    { key: 'pressure', label: 'Давление', unit: '' },
    { key: 'ndvi', label: 'NDVI', unit: '' },
  ];

  // Экспорт микроклимата зоны в CSV-файл.
  const exportCsv = () => {
    const rows = [['time', 'temperature', 'humidity', 'co2']];
    microData.forEach((row) => rows.push([formatTimeTick(row.ts), row.temperature ?? '', row.humidity ?? '', row.co2 ?? '']));
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zone-${id}-microclimate.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <div className="panel">
        <div className="muted">{error}</div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="panel">
        <div className="muted">Загрузка...</div>
      </div>
    );
  }

  return (
    <div>
      <Topbar
        title={`Зона ${zone.name ?? id}`}
        subtitle="Паспорт, текущие значения, история измерений"
        actions={
          <>
            <div className="pill">Время: {formatTs(nowTs)}</div>
            <button className="btn" onClick={exportCsv}>
              Экспорт CSV
            </button>
          </>
        }
      />

      <div className="grid cols-3">
        <div className="panel">
          <div className="muted">Технология</div>
          <div className="stat-value">{zone.technology || '—'}</div>
          <div className="tiny">
            Ряд {zone.row ?? '—'}, колонка {zone.column ?? '—'}
          </div>
        </div>
        <div className="panel">
          <div className="muted">NDVI</div>
          <div className="stat-value">{formatNumber(zone.ndvi)}</div>
          <div className="pill success">
            Референс: {references.ndvi ? references.ndvi.join(' - ') : 'нет данных'}
          </div>
        </div>
        <div className="panel">
          <div className="muted">Статус</div>
          <StatusBadge status={zone.status || 'ok'}>{statusLabel(zone.status || 'ok')}</StatusBadge>
          <div className="tiny">Обновлено {formatTs(nowTs)}</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="card-row" style={{ marginBottom: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>Текущее состояние</h3>
            <div className="subtitle">Параметры с подсветкой выхода за эталон</div>
          </div>
          <select className="input" style={{ width: 180 }} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={6}>За 6 часов</option>
            <option value={24}>За сутки</option>
            <option value={72}>За 3 суток</option>
          </select>
        </div>
        <div className="list-inline">
          {pills.map((p) => (
            <span key={p.key} className="pill">
              {p.label}: {formatNumber(current[p.key])} {p.unit}{' '}
              {references[p.key] ? `| эталон ${references[p.key].join(' - ')}` : ''}
            </span>
          ))}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="card-row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Микроклимат</h3>
            <div className="pill success">Темп./Влажн./CO₂</div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <LineChart data={microData}>
                <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
                <XAxis dataKey="ts" stroke="#93a3be" tickFormatter={formatTimeTick} />
                <YAxis stroke="#93a3be" />
                <Tooltip
                  contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                  formatter={(value) => formatNumber(value, 1)}
                  labelFormatter={formatTimeTick}
                />
                <Line type="monotone" dataKey="temperature" stroke="#21d4c2" dot={false} name="Температура" />
                <Line type="monotone" dataKey="humidity" stroke="#ffa84a" dot={false} name="Влажность" />
                <Line type="monotone" dataKey="co2" stroke="#7da2ff" dot={false} name="CO₂" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <div className="card-row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Раствор / давление</h3>
            <div className="pill">EC / Давление</div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <LineChart data={solutionData}>
                <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
                <XAxis dataKey="ts" stroke="#93a3be" tickFormatter={formatTimeTick} />
                <YAxis stroke="#93a3be" />
                <Tooltip
                  contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                  formatter={(value) => formatNumber(value, 1)}
                  labelFormatter={formatTimeTick}
                />
                <Line type="monotone" dataKey="ec" stroke="#d9a1ff" dot={false} name="EC" />
                {isHydro && <Line type="monotone" dataKey="pressure" stroke="#f16b6b" dot={false} name="Давление" />}
                {isAero && <Line type="monotone" dataKey="rootHumidity" stroke="#4db3ff" dot={false} name="Влажность корней" />}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="panel">
          <div className="card-row" style={{ marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>NDVI</h3>
            <div className="pill success">История за выбранный период</div>
          </div>
          <div className="chart-wrap">
            <ResponsiveContainer>
              <AreaChart data={ndviData}>
                <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
                <XAxis dataKey="ts" stroke="#93a3be" tickFormatter={formatTimeTick} />
                <YAxis stroke="#93a3be" domain={[0, 1]} />
                <Tooltip
                  contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                  formatter={(value) => formatNumber(value, 1)}
                  labelFormatter={formatTimeTick}
                />
                <Area type="monotone" dataKey="value" stroke="#6ef2d5" fill="rgba(110,242,213,0.2)" name="NDVI" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="panel">
          <div className="card-row" style={{ marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Ошибки</h3>
            <Link to="/errors" className="btn">
              Все ошибки
            </Link>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Время</th>
                <th>Код</th>
                <th>Статус</th>
              </tr>
            </thead>
            <tbody>
              {(errors || []).map((e) => (
                <tr key={e.id}>
                  <td>{formatTs(e.ts)}</td>
                  <td>{e.code}</td>
                  <td>
                    <StatusBadge status={e.severity}>{statusLabel(e.severity)}</StatusBadge>
                  </td>
                </tr>
              ))}
              {!errors?.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    Ошибок нет
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

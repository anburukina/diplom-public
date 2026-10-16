import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getReport } from '../api';
import { Topbar } from '../layout/Topbar';
import { formatNumber } from '../utils/format';

// Отображение страницы отчетов по NDVI.
export function Reports() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState(168);

  useEffect(() => {
    let mounted = true;
    getReport({ fromHours: range }).then((report) => {
      if (mounted) setData(report);
    });
    return () => {
      mounted = false;
    };
  }, [range]);

  // Экспорт отчета в CSV-файл.
  const exportCsv = () => {
    if (!data) return;
    const rows = [['zone', 'avgNdvi', 'alerts', 'critical']];
    data.series.forEach((row) => rows.push([row.zone, row.avgNdvi, row.alerts, row.critical]));
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'report.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <Topbar
        title="NDVI"
        subtitle="NDVI, сравнение зон и ошибок по выбранному диапазону"
        actions={
          <>
            <select className="input" style={{ width: 150 }} value={range} onChange={(e) => setRange(Number(e.target.value))}>
              <option value={24}>24 часа</option>
              <option value={72}>3 дня</option>
              <option value={168}>Неделя</option>
            </select>
            <button className="btn" onClick={exportCsv}>
              CSV
            </button>
          </>
        }
      />

      <div className="panel">
        <div className="card-row" style={{ marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0 }}>График NDVI по зонам</h3>
            <div className="subtitle">Период: {range} часов</div>
          </div>
          <div className="pill success">Зон: {data?.series.length ?? 0}</div>
        </div>
        <div className="chart-wrap" style={{ height: 320 }}>
          <ResponsiveContainer>
            <BarChart data={data?.series ?? []}>
              <CartesianGrid stroke="#1f2c3f" strokeDasharray="3 3" />
              <XAxis dataKey="zone" stroke="#93a3be" />
              <YAxis stroke="#93a3be" domain={[0, 1]} />
              <Tooltip
                contentStyle={{ background: '#0f1724', border: '1px solid var(--border)' }}
                formatter={(value) => formatNumber(value, 1)}
              />
              <Bar dataKey="avgNdvi" name="NDVI" fill="#21d4c2" radius={[6, 6, 0, 0]} />
              <Bar dataKey="alerts" name="Предупреждения" fill="#ffa84a" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Сводка</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Зона</th>
              <th>NDVI</th>
              <th>Предупреждения</th>
              <th>Критичные</th>
            </tr>
          </thead>
          <tbody>
            {data?.series.map((row) => (
              <tr key={row.zone}>
                <td>{row.zone}</td>
                <td>{formatNumber(row.avgNdvi)}</td>
                <td>{row.alerts}</td>
                <td>{row.critical}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
